import type { MapData } from '../schemas/map.js';
import { tileIndex, SHADOW_LAYER, TILE_LAYERS } from './map-layers.js';
import { TILE_ID_A3, TILE_ID_MAX } from './autotile.js';

/**
 * The editor's auto-shadow, reproduced from the maps that ship with RPG Maker MZ.
 *
 * The shadow plane (z=4) holds four bits per tile, one per quadrant: 1 top-left,
 * 2 top-right, 4 bottom-left, 8 bottom-right. Measured across the 293 sample
 * maps in `RPG Maker MZ/samplemaps`: 285 of them use the plane at all, and of
 * their 16,829 shadow tiles **81.6% carry the value 5** — the left half of the
 * tile darkened — while **83.7% sit immediately to the right of a wall tile**.
 *
 * So: a tile that is not itself a wall, whose left neighbour is, gets bits 5.
 * The remaining sample patterns are hand-placed shading around terrain, which
 * is a judgement call rather than a rule and is deliberately not guessed at
 * here.
 *
 * Without this, buildings read as flat cut-outs pasted onto the ground — it is
 * the cheapest single thing that makes a generated map look built rather than
 * printed.
 */

export const SHADOW_LEFT_HALF = 5;

/** A3 and A4 tiles: the wall and roof families that cast shadows. */
export function isWallTile(tileId: number): boolean {
  return tileId >= TILE_ID_A3 && tileId < TILE_ID_MAX;
}

export interface ShadowOptions {
  /** Replace shadows already in the map instead of leaving them alone. */
  overwrite?: boolean;
}

export interface ShadowResult {
  added: number;
  cleared: number;
}

function hasWall(mapData: MapData, x: number, y: number): boolean {
  const { width, height, data } = mapData;
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  for (let z = 0; z < TILE_LAYERS; z++) {
    if (isWallTile(data[tileIndex(width, height, x, y, z)] ?? 0)) return true;
  }
  return false;
}

/**
 * Write wall shadows into `mapData` and report what changed. Mutates the map.
 *
 * Hand-placed shadows are preserved unless `overwrite` is set, so running this
 * over a map someone has already shaded by hand does not undo their work.
 */
export function applyWallShadows(mapData: MapData, options: ShadowOptions = {}): ShadowResult {
  const { width, height, data } = mapData;
  const overwrite = options.overwrite ?? false;

  let added = 0;
  let cleared = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = tileIndex(width, height, x, y, SHADOW_LAYER);
      const existing = data[index] ?? 0;
      const wants = !hasWall(mapData, x, y) && hasWall(mapData, x - 1, y);

      if (wants) {
        if (existing === SHADOW_LEFT_HALF) continue;
        if (existing !== 0 && !overwrite) continue;
        data[index] = SHADOW_LEFT_HALF;
        added++;
      } else if (overwrite && existing !== 0) {
        data[index] = 0;
        cleared++;
      }
    }
  }

  return { added, cleared };
}
