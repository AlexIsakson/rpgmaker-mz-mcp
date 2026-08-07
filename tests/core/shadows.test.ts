import { describe, it, expect } from 'vitest';
import { applyWallShadows, SHADOW_LEFT_HALF } from '../../src/core/shadows.js';
import { tileIndex, SHADOW_LAYER } from '../../src/core/map-layers.js';
import { TILE_ID_A3, TILE_ID_A2, makeAutotileId } from '../../src/core/autotile.js';
import type { MapData } from '../../src/schemas/map.js';

const WALL = TILE_ID_A3; // an A3 wall tile
const GROUND = makeAutotileId(16, 0); // an A2 ground tile
const TOTAL_LAYERS = 6;

/** '#' wall on layer 1 over ground, '.' ground only. */
function makeMap(rows: string[]): MapData {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Array(width * height * TOTAL_LAYERS).fill(0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[tileIndex(width, height, x, y, 0)] = GROUND;
      if (rows[y][x] === '#') data[tileIndex(width, height, x, y, 1)] = WALL;
    }
  }

  return { width, height, data, tilesetId: 1, events: [] } as unknown as MapData;
}

const shadowAt = (map: MapData, x: number, y: number) =>
  map.data[tileIndex(map.width, map.height, x, y, SHADOW_LAYER)];

describe('applyWallShadows', () => {
  it('darkens the left half of the tile to the right of a wall', () => {
    const map = makeMap([
      '.....',
      '.##..',
      '.....',
    ]);
    const result = applyWallShadows(map);

    expect(result.added).toBe(1);
    expect(shadowAt(map, 3, 1)).toBe(SHADOW_LEFT_HALF);
    expect(shadowAt(map, 1, 1)).toBe(0); // to the left of the wall
    expect(shadowAt(map, 2, 0)).toBe(0); // above it
  });

  it('does not shadow a wall tile itself', () => {
    const map = makeMap(['##.']);
    applyWallShadows(map);

    expect(shadowAt(map, 1, 0)).toBe(0);
    expect(shadowAt(map, 2, 0)).toBe(SHADOW_LEFT_HALF);
  });

  it('shadows every row of a tall building, once each', () => {
    const map = makeMap([
      '.##..',
      '.##..',
      '.##..',
    ]);
    const result = applyWallShadows(map);

    expect(result.added).toBe(3);
    for (let y = 0; y < 3; y++) expect(shadowAt(map, 3, y)).toBe(SHADOW_LEFT_HALF);
  });

  it('is idempotent', () => {
    const map = makeMap(['.#.']);
    expect(applyWallShadows(map).added).toBe(1);
    expect(applyWallShadows(map).added).toBe(0);
  });

  it('leaves hand-placed shadows alone unless told to overwrite', () => {
    const map = makeMap(['...']);
    const index = tileIndex(map.width, map.height, 1, 0, SHADOW_LAYER);
    map.data[index] = 15; // someone shaded this tile fully by hand

    applyWallShadows(map);
    expect(map.data[index]).toBe(15);

    const result = applyWallShadows(map, { overwrite: true });
    expect(map.data[index]).toBe(0);
    expect(result.cleared).toBe(1);
  });

  it('ignores A2 ground, which casts nothing', () => {
    const map = makeMap([
      '...',
      '...',
    ]);
    expect(applyWallShadows(map).added).toBe(0);
  });

  it('treats a wall on any tile layer as a caster', () => {
    const map = makeMap(['...']);
    map.data[tileIndex(map.width, map.height, 0, 0, 3)] = TILE_ID_A3 + 10;
    expect(applyWallShadows(map).added).toBe(1);
    expect(shadowAt(map, 1, 0)).toBe(SHADOW_LEFT_HALF);
  });

  it('does not shadow off the left map edge', () => {
    const map = makeMap(['#..']);
    const result = applyWallShadows(map);
    expect(result.added).toBe(1);
    expect(shadowAt(map, 1, 0)).toBe(SHADOW_LEFT_HALF);
  });

  it('leaves A2 tiles out of the wall test even at the A3 boundary', () => {
    const map = makeMap(['...']);
    map.data[tileIndex(map.width, map.height, 0, 0, 1)] = TILE_ID_A2;
    expect(applyWallShadows(map).added).toBe(0);
  });
});
