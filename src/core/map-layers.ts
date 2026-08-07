import type { MapData } from '../schemas/map.js';

/**
 * Map tile data is one flat array holding six stacked layers:
 * z 0-3 are the drawable tile layers (bottom to top), z 4 is shadow, z 5 is
 * region id. Indexing follows Game_Map.tileId in the corescript.
 */

export const TILE_LAYERS = 4;
export const SHADOW_LAYER = 4;
export const REGION_LAYER = 5;
export const TOTAL_LAYERS = 6;

export function tileIndex(width: number, height: number, x: number, y: number, z: number): number {
  return (z * height + y) * width + x;
}

/**
 * Whether any layer below `layer` has something painted at (x, y).
 *
 * Anything with transparent pixels — a roof's cut corner, a tree's canopy, most
 * object tiles — shows whatever is underneath it, and with nothing underneath
 * that is the map background, which renders black in game. So this is the check
 * that stands between a partly-transparent tile and a hole in the map.
 */
export function hasTileBelow(mapData: MapData, x: number, y: number, layer: number): boolean {
  const { width, height, data } = mapData;
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  for (let z = 0; z < layer; z++) {
    if ((data[tileIndex(width, height, x, y, z)] ?? 0) !== 0) return true;
  }
  return false;
}

/** Extract one layer as `grid[y][x]`. */
export function readLayer(mapData: MapData, z: number): number[][] {
  const { width, height, data } = mapData;
  const grid: number[][] = [];

  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) {
      row.push(data[tileIndex(width, height, x, y, z)] ?? 0);
    }
    grid.push(row);
  }

  return grid;
}

/**
 * Write a grid back into one layer, leaving every other layer untouched.
 * Mutates `mapData.data`.
 */
export function writeLayer(mapData: MapData, z: number, grid: number[][]): void {
  const { width, height } = mapData;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      mapData.data[tileIndex(width, height, x, y, z)] = grid[y][x];
    }
  }
}
