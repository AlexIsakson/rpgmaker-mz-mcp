import { describe, it, expect } from 'vitest';
import { makeRng } from '../../src/core/mapgen.js';
import {
  cutRoomCorners,
  columnSpan,
  isConnected,
  shapeCells,
  CORNERS,
  CORPUS_CORNER_WEIGHTS,
  SHAPE_DEFAULTS,
} from '../../src/core/room-shape.js';

/**
 * The corpus this module is built to, from the 139 interior maps the editor
 * ships: of 191 room cores, 106 have no corner cut, 26 have one, 27 have two,
 * 5 have three and 27 have all four. A cut is a median 0.24 of the room's width
 * and 0.25 of its height, over 203 individual cuts.
 */
const SEEDS = [1, 2, 3, 7, 11, 42, 99, 1234, 20260820, 777];

function countCells(mask: boolean[][]): number {
  return mask.reduce((total, row) => total + row.filter(Boolean).length, 0);
}

describe('cutRoomCorners', () => {
  it('is reproducible for a seed', () => {
    for (const seed of SEEDS) {
      const a = cutRoomCorners(14, 10, makeRng(seed));
      const b = cutRoomCorners(14, 10, makeRng(seed));
      expect(b.mask).toEqual(a.mask);
      expect(b.cuts).toEqual(a.cuts);
    }
  });

  it('produces different shapes for different seeds', () => {
    const shapes = new Set(
      SEEDS.map((seed) => JSON.stringify(cutRoomCorners(14, 10, makeRng(seed)).mask))
    );
    expect(shapes.size).toBeGreaterThan(1);
  });

  it('leaves the mask 4-connected, over many seeds and sizes', () => {
    for (let seed = 1; seed <= 300; seed++) {
      for (const [w, h] of [[14, 10], [7, 5], [20, 4], [4, 20], [5, 5], [30, 24]]) {
        const shape = cutRoomCorners(w, h, makeRng(seed));
        expect(isConnected(shape.mask)).toBe(true);
        expect(countCells(shape.mask)).toBeGreaterThan(0);
      }
    }
  });

  it('never empties a row or a column', () => {
    const minSpan = SHAPE_DEFAULTS.minSpan;
    for (let seed = 1; seed <= 300; seed++) {
      const shape = cutRoomCorners(16, 12, makeRng(seed));
      for (let y = 0; y < shape.height; y++) {
        expect(shape.mask[y].filter(Boolean).length).toBeGreaterThanOrEqual(minSpan);
      }
      for (let x = 0; x < shape.width; x++) {
        const column = shape.mask.map((row) => row[x]).filter(Boolean).length;
        expect(column).toBeGreaterThanOrEqual(minSpan);
      }
    }
  });

  it('leaves every column a single unbroken interval', () => {
    // The interior wall builder walks a column at a time and assumes one run of
    // floor per column. That assumption is this module's to keep.
    for (let seed = 1; seed <= 200; seed++) {
      const shape = cutRoomCorners(18, 13, makeRng(seed));
      for (let x = 0; x < shape.width; x++) {
        const span = columnSpan(shape.mask, x);
        expect(span).not.toBeNull();
        for (let y = span!.top; y <= span!.bottom; y++) {
          expect(shape.mask[y][x]).toBe(true);
        }
      }
    }
  });

  it('only ever removes cells at a corner of the box', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const shape = cutRoomCorners(15, 11, makeRng(seed));
      for (let y = 0; y < shape.height; y++) {
        for (let x = 0; x < shape.width; x++) {
          if (shape.mask[y][x]) continue;
          const covered = shape.cuts.some((cut) => {
            const inX =
              cut.corner === 'topLeft' || cut.corner === 'bottomLeft'
                ? x < cut.width
                : x >= shape.width - cut.width;
            const inY =
              cut.corner === 'topLeft' || cut.corner === 'topRight'
                ? y < cut.height
                : y >= shape.height - cut.height;
            return inX && inY;
          });
          expect(covered).toBe(true);
        }
      }
    }
  });

  it('follows the corpus corner distribution over many seeds', () => {
    // 106 : 26 : 27 : 5 : 27 out of 191 -> 55.5% of rooms are rectangles.
    const counts = [0, 0, 0, 0, 0];
    const trials = 4000;
    for (let seed = 1; seed <= trials; seed++) {
      const shape = cutRoomCorners(20, 16, makeRng(seed));
      counts[new Set(shape.cuts.map((c) => c.corner)).size]++;
    }
    const total = CORPUS_CORNER_WEIGHTS.reduce((a, b) => a + b, 0);
    for (let n = 0; n < counts.length; n++) {
      const expected = (CORPUS_CORNER_WEIGHTS[n] / total) * trials;
      expect(Math.abs(counts[n] - expected)).toBeLessThan(trials * 0.04);
    }
  });

  it('cuts sized inside the measured p10..p90 band', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const shape = cutRoomCorners(40, 30, makeRng(seed));
      for (const cut of shape.cuts) {
        // Rounded to whole tiles, so the band is checked with a tile of slack.
        expect(cut.width / 40).toBeGreaterThanOrEqual(SHAPE_DEFAULTS.minFraction - 1 / 40);
        expect(cut.width / 40).toBeLessThanOrEqual(SHAPE_DEFAULTS.maxFraction + 1 / 40);
        expect(cut.height / 30).toBeGreaterThanOrEqual(SHAPE_DEFAULTS.minFraction - 1 / 30);
        expect(cut.height / 30).toBeLessThanOrEqual(SHAPE_DEFAULTS.maxFraction + 1 / 30);
      }
    }
  });

  it('is a rectangle when the weights ask for one', () => {
    for (const seed of SEEDS) {
      const shape = cutRoomCorners(14, 10, makeRng(seed), { cornerWeights: [1, 0, 0, 0, 0] });
      expect(shape.cuts).toEqual([]);
      expect(countCells(shape.mask)).toBe(140);
    }
  });

  it('says so rather than throwing when the room is too small to shape', () => {
    const shape = cutRoomCorners(2, 8, makeRng(1));
    expect(shape.tooSmall).toContain('width');
    expect(shape.cuts).toEqual([]);
    expect(countCells(shape.mask)).toBe(16);
  });

  it('keeps a small room a rectangle rather than severing it', () => {
    // 3x3 with minSpan 2 leaves exactly one tile of cut in each direction.
    for (let seed = 1; seed <= 200; seed++) {
      const shape = cutRoomCorners(3, 3, makeRng(seed));
      expect(isConnected(shape.mask)).toBe(true);
      for (const cut of shape.cuts) {
        expect(cut.width).toBe(1);
        expect(cut.height).toBe(1);
      }
    }
  });

  it('can cut every corner and still hold together', () => {
    const shape = cutRoomCorners(20, 16, makeRng(5), { cornerWeights: [0, 0, 0, 0, 1] });
    expect(new Set(shape.cuts.map((c) => c.corner)).size).toBe(4);
    expect(isConnected(shape.mask)).toBe(true);
    expect(countCells(shape.mask)).toBeLessThan(20 * 16);
  });

  it('offsets cells to the rectangle it is given', () => {
    const shape = cutRoomCorners(4, 4, makeRng(1), { cornerWeights: [1, 0, 0, 0, 0] });
    const cells = shapeCells(shape, { x: 10, y: 20, width: 4, height: 4 });
    expect(cells).toHaveLength(16);
    expect(cells[0]).toEqual({ x: 10, y: 20 });
    expect(cells[cells.length - 1]).toEqual({ x: 13, y: 23 });
  });

  it('names every corner exactly once at most', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const shape = cutRoomCorners(20, 16, makeRng(seed));
      const named = shape.cuts.map((c) => c.corner);
      expect(new Set(named).size).toBe(named.length);
      for (const corner of named) expect(CORNERS).toContain(corner);
    }
  });
});
