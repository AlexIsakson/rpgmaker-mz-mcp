import type { MapData } from '../schemas/map.js';

/**
 * Passability/terrain bit layout, ported from RPG Maker MZ's Game_Map
 * (rmmz_objects.js: checkPassage, isLadder/isBush/isCounter/isDamageFloor, terrainTag).
 */
export const PASSAGE_BIT = { down: 0x01, left: 0x02, right: 0x04, up: 0x08 } as const;
export const FLAG_STAR = 0x10; // "no effect on passage" — fall through to the next layer
export const FLAG_LADDER = 0x20;
export const FLAG_BUSH = 0x40;
export const FLAG_COUNTER = 0x80;
export const FLAG_DAMAGE_FLOOR = 0x100;

export interface TileInfo {
  x: number;
  y: number;
  /** Tile IDs for layers 0-3 (bottom to top), as stored in map data. */
  tileIds: [number, number, number, number];
  regionId: number;
  shadow: number;
  passable: { up: boolean; down: boolean; left: boolean; right: boolean };
  /** Blocked from every direction — the closest static-analysis equivalent of "a wall". */
  isWall: boolean;
  isLadder: boolean;
  isBush: boolean;
  isCounter: boolean;
  isDamageFloor: boolean;
  terrainTag: number;
}

function tileIdAt(data: number[], width: number, height: number, x: number, y: number, z: number): number {
  return data[(z * height + y) * width + x] ?? 0;
}

/**
 * Matches Game_Map.prototype.layeredTiles: top layer (3) to bottom layer (0).
 * Note: the real engine's passability check (allTiles) also includes any event
 * standing on the tile; that's dynamic runtime state and out of scope for this
 * static map read — a tile reported passable here could still be blocked by an
 * event placed on it at runtime.
 */
function layeredTileIds(data: number[], width: number, height: number, x: number, y: number): number[] {
  return [3, 2, 1, 0].map((z) => tileIdAt(data, width, height, x, y, z));
}

/** Matches Game_Map.prototype.checkPassage. */
function checkPassage(flags: number[], layered: number[], bit: number): boolean {
  for (const tileId of layered) {
    const flag = flags[tileId] ?? 0;
    if ((flag & FLAG_STAR) !== 0) continue; // [*] no effect — check the layer below
    if ((flag & bit) === 0) return true; // [o] passable
    return false; // [x] impassable
  }
  return false; // no layer resolved passage — engine treats this as blocked
}

function anyLayerFlag(flags: number[], layered: number[], bit: number): boolean {
  return layered.some((tileId) => ((flags[tileId] ?? 0) & bit) !== 0);
}

export function readTile(mapData: MapData, flags: number[], x: number, y: number): TileInfo {
  const { width, height, data } = mapData;
  const layered = layeredTileIds(data, width, height, x, y);

  const passable = {
    down: checkPassage(flags, layered, PASSAGE_BIT.down),
    left: checkPassage(flags, layered, PASSAGE_BIT.left),
    right: checkPassage(flags, layered, PASSAGE_BIT.right),
    up: checkPassage(flags, layered, PASSAGE_BIT.up),
  };

  let terrainTag = 0;
  for (const tileId of layered) {
    const tag = (flags[tileId] ?? 0) >> 12;
    if (tag > 0) {
      terrainTag = tag;
      break;
    }
  }

  return {
    x,
    y,
    tileIds: [
      tileIdAt(data, width, height, x, y, 0),
      tileIdAt(data, width, height, x, y, 1),
      tileIdAt(data, width, height, x, y, 2),
      tileIdAt(data, width, height, x, y, 3),
    ],
    regionId: tileIdAt(data, width, height, x, y, 5),
    shadow: tileIdAt(data, width, height, x, y, 4),
    passable,
    isWall: !passable.up && !passable.down && !passable.left && !passable.right,
    isLadder: anyLayerFlag(flags, layered, FLAG_LADDER),
    isBush: anyLayerFlag(flags, layered, FLAG_BUSH),
    isCounter: anyLayerFlag(flags, layered, FLAG_COUNTER),
    isDamageFloor: anyLayerFlag(flags, layered, FLAG_DAMAGE_FLOOR),
    terrainTag,
  };
}

export function buildGrid(mapData: MapData, flags: number[]): TileInfo[][] {
  const grid: TileInfo[][] = [];
  for (let y = 0; y < mapData.height; y++) {
    const row: TileInfo[] = [];
    for (let x = 0; x < mapData.width; x++) {
      row.push(readTile(mapData, flags, x, y));
    }
    grid.push(row);
  }
  return grid;
}

export interface GridEventMarker {
  id: number;
  name: string;
  x: number;
  y: number;
}

export interface GridBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const EVENT_SYMBOLS = '123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function tileGlyph(tile: TileInfo): string {
  if (tile.isWall) return '#';
  if (tile.isDamageFloor) return '~';
  if (tile.isLadder) return '=';
  if (tile.isBush) return '"';
  if (tile.isCounter) return '+';
  return '.';
}

export interface RenderedGrid {
  text: string;
  legend: string[];
  truncatedEvents: boolean;
}

/**
 * Renders a text grid an AI can read directly: one character per tile plus
 * a ruler and an event legend. `bounds` lets callers window large maps.
 */
export function renderAsciiGrid(
  grid: TileInfo[][],
  events: GridEventMarker[],
  bounds?: GridBounds
): RenderedGrid {
  const mapWidth = grid[0]?.length ?? 0;
  const mapHeight = grid.length;
  const x0 = bounds?.x ?? 0;
  const y0 = bounds?.y ?? 0;
  const x1 = bounds ? Math.min(mapWidth, x0 + bounds.width) : mapWidth;
  const y1 = bounds ? Math.min(mapHeight, y0 + bounds.height) : mapHeight;

  const eventAt = new Map<string, GridEventMarker>();
  for (const event of events) {
    if (event.x >= x0 && event.x < x1 && event.y >= y0 && event.y < y1) {
      eventAt.set(`${event.x},${event.y}`, event);
    }
  }

  const symbolByEventId = new Map<number, string>();
  const legend: string[] = [];
  let truncatedEvents = false;
  for (const event of eventAt.values()) {
    if (symbolByEventId.size >= EVENT_SYMBOLS.length) {
      truncatedEvents = true;
      continue;
    }
    const symbol = EVENT_SYMBOLS[symbolByEventId.size];
    symbolByEventId.set(event.id, symbol);
    legend.push(`${symbol} = event [${event.id}] "${event.name || '(unnamed)'}" at (${event.x}, ${event.y})`);
  }

  const colWidth = String(x1 - 1).length;
  const rowLabelWidth = String(y1 - 1).length;
  const lines: string[] = [];

  // Column ruler (tens then units) so coordinates are readable without counting characters.
  if (colWidth > 1) {
    let tens = ' '.repeat(rowLabelWidth + 1);
    for (let x = x0; x < x1; x++) tens += Math.floor(x / 10) % 10;
    lines.push(tens);
  }
  let units = ' '.repeat(rowLabelWidth + 1);
  for (let x = x0; x < x1; x++) units += x % 10;
  lines.push(units);

  for (let y = y0; y < y1; y++) {
    let line = String(y).padStart(rowLabelWidth, ' ') + ' ';
    for (let x = x0; x < x1; x++) {
      const event = eventAt.get(`${x},${y}`);
      line += event ? symbolByEventId.get(event.id)! : tileGlyph(grid[y][x]);
    }
    lines.push(line);
  }

  return { text: lines.join('\n'), legend, truncatedEvents };
}

/**
 * The region plane (z=5) as its own grid.
 *
 * A separate grid rather than a glyph in the main one, because a region is not
 * a property of the terrain — it is an orthogonal overlay, and a tile commonly
 * has both a wall glyph and a region. Ids 1-9 print as themselves so the usual
 * case reads directly; anything above that gets a letter and a legend line,
 * since a region id can go to 255 and a cell is one character wide.
 */
const REGION_SYMBOLS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function renderRegionGrid(grid: TileInfo[][], bounds?: GridBounds): RenderedGrid {
  const mapWidth = grid[0]?.length ?? 0;
  const mapHeight = grid.length;
  const x0 = bounds?.x ?? 0;
  const y0 = bounds?.y ?? 0;
  const x1 = bounds ? Math.min(mapWidth, x0 + bounds.width) : mapWidth;
  const y1 = bounds ? Math.min(mapHeight, y0 + bounds.height) : mapHeight;

  const present = new Set<number>();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const id = grid[y][x].regionId;
      if (id !== 0) present.add(id);
    }
  }

  const symbolById = new Map<number, string>();
  const legend: string[] = [];
  let truncated = false;
  let nextSymbol = 0;
  for (const id of [...present].sort((a, b) => a - b)) {
    if (id >= 1 && id <= 9) {
      symbolById.set(id, String(id));
      continue;
    }
    if (nextSymbol >= REGION_SYMBOLS.length) {
      truncated = true;
      continue;
    }
    const symbol = REGION_SYMBOLS[nextSymbol++];
    symbolById.set(id, symbol);
    legend.push(`${symbol} = region ${id}`);
  }

  const colWidth = String(x1 - 1).length;
  const rowLabelWidth = String(y1 - 1).length;
  const lines: string[] = [];

  if (colWidth > 1) {
    let tens = ' '.repeat(rowLabelWidth + 1);
    for (let x = x0; x < x1; x++) tens += Math.floor(x / 10) % 10;
    lines.push(tens);
  }
  let units = ' '.repeat(rowLabelWidth + 1);
  for (let x = x0; x < x1; x++) units += x % 10;
  lines.push(units);

  for (let y = y0; y < y1; y++) {
    let line = String(y).padStart(rowLabelWidth, ' ') + ' ';
    for (let x = x0; x < x1; x++) {
      const id = grid[y][x].regionId;
      line += id === 0 ? '.' : (symbolById.get(id) ?? '?');
    }
    lines.push(line);
  }

  return { text: lines.join('\n'), legend, truncatedEvents: truncated };
}
