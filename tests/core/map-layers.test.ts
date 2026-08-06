import { describe, it, expect } from 'vitest';
import { readLayer, writeLayer, tileIndex, REGION_LAYER } from '../../src/core/map-layers.js';
import { defaultMap } from '../../src/templates/defaults.js';

describe('tileIndex', () => {
  it('matches the engine layout data[(z * height + y) * width + x]', () => {
    expect(tileIndex(10, 8, 0, 0, 0)).toBe(0);
    expect(tileIndex(10, 8, 3, 2, 0)).toBe(23);
    expect(tileIndex(10, 8, 0, 0, 1)).toBe(80); // one full layer in
    expect(tileIndex(10, 8, 4, 1, 5)).toBe((5 * 8 + 1) * 10 + 4);
  });
});

describe('readLayer / writeLayer', () => {
  it('round-trips a layer', () => {
    const map = defaultMap(4, 3, 1);
    const grid = [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ];

    writeLayer(map, 0, grid);
    expect(readLayer(map, 0)).toEqual(grid);
  });

  it('reads a grid shaped height x width', () => {
    const map = defaultMap(6, 4, 1);
    const grid = readLayer(map, 0);
    expect(grid).toHaveLength(4);
    expect(grid[0]).toHaveLength(6);
  });

  it('keeps other layers untouched', () => {
    const map = defaultMap(3, 3, 1);
    writeLayer(map, REGION_LAYER, [
      [7, 7, 7],
      [7, 7, 7],
      [7, 7, 7],
    ]);
    writeLayer(map, 0, [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]);

    expect(readLayer(map, REGION_LAYER)[1][1]).toBe(7);
    expect(readLayer(map, 0)[1][1]).toBe(1);
    expect(readLayer(map, 1)[1][1]).toBe(0);
  });

  it('does not change the data array length', () => {
    const map = defaultMap(5, 5, 1);
    const before = map.data.length;
    writeLayer(map, 2, readLayer(map, 2));
    expect(map.data.length).toBe(before);
  });
});
