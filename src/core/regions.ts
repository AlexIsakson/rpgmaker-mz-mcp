import type { MapData } from '../schemas/map.js';
import { tileIndex, REGION_LAYER } from './map-layers.js';
import { readTile } from './map-grid.js';

/**
 * The region plane, z=5 — the last of the six stacked layers and the only one
 * no tool could reach.
 *
 * **What the engine does with it** (v1.9.0 `rmmz_objects.js`, strongest kind of
 * claim here):
 *
 *  - `Game_Map.regionId(x, y)` is `this.isValid(x, y) ? this.tileId(x, y, 5) : 0`
 *    — the raw stored value, with no decoding, no flags and no tileset involved.
 *    Every other plane needs the tileset to mean anything; this one does not.
 *  - `Game_Player.meetsEncounterConditions` fires an encounter when
 *    `encounter.regionSet.length === 0 || encounter.regionSet.includes(this.regionId())`.
 *    So a map's `encounterList` entry either fires everywhere or only inside the
 *    regions it names — which is the whole mechanism for "wolves in the woods,
 *    not on the road".
 *  - Get Location Info (`Game_Interpreter` command 285) reads it into a variable
 *    at its `default:` case, so events can branch on it.
 *
 * **What the corpus says: nothing, and that is worth saying out loud.** Zero of
 * the 293 sample maps in `RPG Maker MZ/samplemaps` write a single non-zero
 * region tile, and all 293 ship an empty `encounterList`. Across the user's own
 * projects only 1 map of 64 uses the plane (Wicked Heart Map025: region id 1,
 * 335 tiles in 11 disconnected areas, 5 of them a single tile). So there is no
 * measured convention for how big a region should be, which ids mean what, or
 * whether an area should be contiguous — and this module deliberately invents
 * none. It writes what the caller asks for and reports what it wrote.
 *
 * The one bound that is not measured: ids run 1-255 because that is the
 * editor's region palette. The engine itself does not clamp — `regionId` would
 * happily return 4096 — but a value the editor cannot display is a value nobody
 * can maintain by hand afterwards, so it is refused. **Stated, not measured.**
 */

/** 0 erases; the editor's palette runs 1-255. */
export const REGION_ID_MIN = 0;
export const REGION_ID_MAX = 255;

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RegionTile {
  x: number;
  y: number;
  regionId: number;
}

export interface RegionArea {
  regionId: number;
  /** Number of tiles carrying this id. */
  tiles: number;
  /** How many 4-connected areas those tiles form. */
  areas: number;
  bounds: RegionRect;
  /**
   * Tiles the player can never stand on, because every direction is blocked.
   * An encounter region over these can never fire; a Get Location Info branch
   * on them can never be taken.
   */
  impassable: number;
}

export interface RegionWriteResult {
  /** Tiles whose region id changed. */
  written: number;
  /** Tiles already carrying the requested id. */
  unchanged: number;
  /** Tiles that had a different non-zero region before this write. */
  replaced: number;
  /** Region ids that lost tiles to this write, and how many. */
  overwritten: Map<number, number>;
  /** Set when a rectangle ran past the map edge and was clipped to fit. */
  clipped?: RegionRect;
}

export function readRegion(mapData: MapData, x: number, y: number): number {
  const { width, height, data } = mapData;
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  return data[tileIndex(width, height, x, y, REGION_LAYER)] ?? 0;
}

function writeOne(mapData: MapData, x: number, y: number, regionId: number, result: RegionWriteResult): void {
  const { width, height, data } = mapData;
  const index = tileIndex(width, height, x, y, REGION_LAYER);
  const existing = data[index] ?? 0;

  if (existing === regionId) {
    result.unchanged++;
    return;
  }
  if (existing !== 0) {
    result.replaced++;
    result.overwritten.set(existing, (result.overwritten.get(existing) ?? 0) + 1);
  }
  data[index] = regionId;
  result.written++;
}

function emptyResult(): RegionWriteResult {
  return { written: 0, unchanged: 0, replaced: 0, overwritten: new Map() };
}

/**
 * Paint a rectangle of the region plane. Mutates `mapData`.
 *
 * A rectangle running past the map edge is clipped rather than refused, which
 * matches `fill_map_region`; the clipped bounds come back in the result so the
 * caller is told rather than left to notice. A rectangle *entirely* outside the
 * map is a caller error and throws — silently writing nothing is the failure
 * mode this repo refuses.
 */
export function paintRegionRect(mapData: MapData, rect: RegionRect, regionId: number): RegionWriteResult {
  validateRegionId(regionId);

  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(mapData.width, rect.x + rect.width);
  const y1 = Math.min(mapData.height, rect.y + rect.height);

  if (x1 <= x0 || y1 <= y0) {
    throw new Error(
      `Rectangle (${rect.x}, ${rect.y}) ${rect.width}x${rect.height} lies entirely outside ` +
      `the ${mapData.width}x${mapData.height} map, so nothing would be written.`
    );
  }

  const result = emptyResult();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) writeOne(mapData, x, y, regionId, result);
  }

  const clippedWidth = x1 - x0;
  const clippedHeight = y1 - y0;
  if (clippedWidth !== rect.width || clippedHeight !== rect.height) {
    result.clipped = { x: x0, y: y0, width: clippedWidth, height: clippedHeight };
  }

  return result;
}

/**
 * Paint individual tiles of the region plane. Mutates `mapData`.
 *
 * All-or-nothing: every tile is validated before any is written, the same rule
 * `paint_tiles` follows. A partial write would be worse than a refusal, because
 * the result would not say which half landed.
 */
export function paintRegionTiles(mapData: MapData, tiles: RegionTile[]): RegionWriteResult {
  if (tiles.length === 0) throw new Error('No tiles given.');

  for (const tile of tiles) {
    validateRegionId(tile.regionId);
    if (tile.x < 0 || tile.y < 0 || tile.x >= mapData.width || tile.y >= mapData.height) {
      throw new Error(
        `Tile (${tile.x}, ${tile.y}) is outside the ${mapData.width}x${mapData.height} map. ` +
        'Nothing was written.'
      );
    }
  }

  const result = emptyResult();
  // Later entries win over earlier ones, as in paint_tiles.
  for (const tile of tiles) writeOne(mapData, tile.x, tile.y, tile.regionId, result);
  return result;
}

/** Erase every tile carrying `regionId`. Mutates `mapData`. */
export function clearRegion(mapData: MapData, regionId: number): number {
  if (regionId < 1 || regionId > REGION_ID_MAX) {
    throw new Error(`Region id ${regionId} is outside 1-${REGION_ID_MAX}.`);
  }

  const { width, height, data } = mapData;
  let cleared = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = tileIndex(width, height, x, y, REGION_LAYER);
      if ((data[index] ?? 0) === regionId) {
        data[index] = 0;
        cleared++;
      }
    }
  }
  return cleared;
}

function validateRegionId(regionId: number): void {
  if (!Number.isInteger(regionId) || regionId < REGION_ID_MIN || regionId > REGION_ID_MAX) {
    throw new Error(
      `Region id ${regionId} is outside ${REGION_ID_MIN}-${REGION_ID_MAX}. ` +
      `The editor's region palette is 1-${REGION_ID_MAX}; 0 erases.`
    );
  }
}

/** How many 4-connected areas the tiles carrying `regionId` form. */
function countAreas(mapData: MapData, regionId: number): number {
  const { width, height } = mapData;
  const seen = new Uint8Array(width * height);
  let areas = 0;

  for (let start = 0; start < width * height; start++) {
    if (seen[start] === 1) continue;
    if (readRegion(mapData, start % width, Math.floor(start / width)) !== regionId) continue;

    areas++;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const cell = stack.pop()!;
      const cx = cell % width;
      const cy = Math.floor(cell / width);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (seen[next] === 1 || readRegion(mapData, nx, ny) !== regionId) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
  }

  return areas;
}

/**
 * What is on the region plane, one entry per id in ascending order.
 *
 * `flags` are the tileset's passage flags. Pass them to get the `impassable`
 * count, which is the one thing that makes a region useless without looking
 * broken: an encounter regionSet over tiles the player cannot stand on will
 * never fire. Omit them and `impassable` is reported as 0.
 */
export function summariseRegions(mapData: MapData, flags?: number[]): RegionArea[] {
  const { width, height } = mapData;
  const tiles = new Map<number, { count: number; minX: number; minY: number; maxX: number; maxY: number; impassable: number }>();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const id = readRegion(mapData, x, y);
      if (id === 0) continue;

      const entry = tiles.get(id) ?? { count: 0, minX: x, minY: y, maxX: x, maxY: y, impassable: 0 };
      entry.count++;
      entry.minX = Math.min(entry.minX, x);
      entry.minY = Math.min(entry.minY, y);
      entry.maxX = Math.max(entry.maxX, x);
      entry.maxY = Math.max(entry.maxY, y);
      if (flags && readTile(mapData, flags, x, y).isWall) entry.impassable++;
      tiles.set(id, entry);
    }
  }

  return [...tiles.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([regionId, e]) => ({
      regionId,
      tiles: e.count,
      areas: countAreas(mapData, regionId),
      bounds: { x: e.minX, y: e.minY, width: e.maxX - e.minX + 1, height: e.maxY - e.minY + 1 },
      impassable: e.impassable,
    }));
}
