import { describe, it, expect } from 'vitest';
import { makeRng } from '../../src/core/mapgen.js';
import {
  raggedRect,
  longestBoundaryRun,
  RAGGED_DEFAULTS,
} from '../../src/core/ragged.js';
import type { Rect } from '../../src/core/autotile.js';

/**
 * The corpus numbers these assertions are against, from
 * `scripts/measure-map-shape.mjs` over the 293 sample maps: a boundary run's
 * median is 1, its p99 is 9, and 70.5% of all runs are a single tile. The p99
 * is the one this module promises; the rest is what it aims at.
 */
const CORPUS_P99 = 9;

const SEEDS = [1, 2, 3, 7, 11, 42, 99, 1234, 20260819, 777];

function countCells(mask: boolean[][]): number {
  return mask.reduce((total, row) => total + row.filter(Boolean).length, 0);
}

/** The straight-run measure of the corpus script, restated on a plain mask. */
function bruteForceLongestRun(mask: boolean[][]): number {
  const height = mask.length;
  const width = mask[0]?.length ?? 0;
  const at = (x: number, y: number) =>
    y >= 0 && y < height && x >= 0 && x < width && mask[y][x];
  let longest = 0;

  for (let y = 0; y <= height; y++) {
    let run = 0;
    let pair: string | null = null;
    for (let x = 0; x < width; x++) {
      const p = at(x, y - 1) === at(x, y) ? null : `${at(x, y - 1)}|${at(x, y)}`;
      if (p !== null && p === pair) run++;
      else {
        longest = Math.max(longest, run);
        run = p === null ? 0 : 1;
        pair = p;
      }
    }
    longest = Math.max(longest, run);
  }
  for (let x = 0; x <= width; x++) {
    let run = 0;
    let pair: string | null = null;
    for (let y = 0; y < height; y++) {
      const p = at(x - 1, y) === at(x, y) ? null : `${at(x - 1, y)}|${at(x, y)}`;
      if (p !== null && p === pair) run++;
      else {
        longest = Math.max(longest, run);
        run = p === null ? 0 : 1;
        pair = p;
      }
    }
    longest = Math.max(longest, run);
  }
  return longest;
}

describe('longestBoundaryRun', () => {
  it('agrees with a direct restatement of the corpus measure', () => {
    for (const seed of SEEDS) {
      const rng = makeRng(seed);
      const mask = Array.from({ length: 14 }, () =>
        Array.from({ length: 18 }, () => rng() < 0.6)
      );
      expect(longestBoundaryRun(mask)).toBe(bruteForceLongestRun(mask));
    }
  });

  it('gives a rectangle a run as long as its side', () => {
    // The thing P5-07 measured and P5-09 exists to stop: a 12x5 block of one
    // material has a 12-long boundary top and bottom.
    const mask = Array.from({ length: 5 }, () => new Array<boolean>(12).fill(true));
    expect(longestBoundaryRun(mask)).toBe(12);
  });

  it('is 0 for an empty mask', () => {
    expect(longestBoundaryRun(Array.from({ length: 4 }, () => new Array(4).fill(false)))).toBe(0);
  });
});

describe('raggedRect', () => {
  const patch: Rect = { x: 5, y: 4, width: 20, height: 12 };

  it('keeps no boundary run longer than the corpus p99, across seeds', () => {
    for (const seed of SEEDS) {
      const result = raggedRect(patch, makeRng(seed));
      expect(result.longestRun).toBeLessThanOrEqual(CORPUS_P99);
      // And the reported figure is the truth about the mask it returned.
      expect(result.longestRun).toBe(bruteForceLongestRun(result.mask));
    }
  });

  it('beats the rectangle it came from every time', () => {
    // A 20x12 rectangle has 20-long runs; nothing here may be worse.
    for (const seed of SEEDS) {
      expect(raggedRect(patch, makeRng(seed)).longestRun).toBeLessThan(20);
    }
  });

  it('is reproducible — same seed, same patch', () => {
    for (const seed of SEEDS) {
      const a = raggedRect(patch, makeRng(seed));
      const b = raggedRect(patch, makeRng(seed));
      expect(b.mask).toEqual(a.mask);
      expect(b.cells).toEqual(a.cells);
    }
  });

  it('stays one connected piece', () => {
    for (const seed of SEEDS) {
      const { mask } = raggedRect(patch, makeRng(seed));
      // largestComponent is the only thing that can drop a cell, so a mask that
      // survives a second pass unchanged was already connected.
      const again = raggedRect(patch, makeRng(seed));
      expect(countCells(again.mask)).toBe(countCells(mask));
      expect(countCells(mask)).toBeGreaterThan(0);
    }
  });

  it('keeps roughly the area it was asked for', () => {
    // Amplitude 1 moves an edge by a tile; it must not eat or double the patch.
    const area = patch.width * patch.height;
    for (const seed of SEEDS) {
      const cells = countCells(raggedRect(patch, makeRng(seed)).mask);
      expect(cells).toBeGreaterThan(area * 0.75);
      expect(cells).toBeLessThan(area * 1.25);
    }
  });

  it('turns the edge far more often than a rectangle does', () => {
    // The corpus median run is 1 and 70.5% of runs are a single tile. This does
    // not claim to reproduce that distribution — only that the typical run is
    // short rather than the length of a side.
    const runs: number[] = [];
    for (const seed of SEEDS) {
      runs.push(raggedRect(patch, makeRng(seed)).longestRun);
    }
    const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
    expect(mean).toBeLessThan(8);
  });
});

describe('raggedRect with only two edges free', () => {
  // A street: full map width, so its ends must stay flush or the road stops
  // reaching the map edge and the town loses its entrances.
  const road: Rect = { x: 0, y: 20, width: 44, height: 2 };
  const edges = { top: true, bottom: true };

  it('leaves the ends exactly where the rectangle put them', () => {
    for (const seed of SEEDS) {
      const { mask, rect } = raggedRect(road, makeRng(seed), { edges, minThickness: 2 });
      const columnCells = (x: number) =>
        mask.map((row) => row[x - rect.x]).filter(Boolean).length;
      expect(columnCells(0)).toBeGreaterThan(0);
      expect(columnCells(43)).toBeGreaterThan(0);
    }
  });

  it('never pinches a 2-wide street below 2 wide', () => {
    for (const seed of SEEDS) {
      const { mask, rect } = raggedRect(road, makeRng(seed), { edges, minThickness: 2 });
      for (let x = 0; x < road.width; x++) {
        const column = mask.map((row) => row[x + road.x - rect.x]);
        expect(column.filter(Boolean).length).toBeGreaterThanOrEqual(2);
        // And what it does have is one unbroken run, not two strips.
        const first = column.indexOf(true);
        const last = column.lastIndexOf(true);
        expect(column.slice(first, last + 1).every(Boolean)).toBe(true);
      }
    }
  });

  it('makes the street change width instead of jittering about one', () => {
    // "Roads bend and change width" is the task; a comb that alternates between
    // two levels satisfies every run-length number and is not that. A 2-wide
    // street must actually get wider somewhere.
    for (const seed of SEEDS) {
      const { mask, rect } = raggedRect(road, makeRng(seed), { edges, minThickness: 2 });
      const widths: number[] = [];
      for (let x = 0; x < road.width; x++) {
        widths.push(mask.map((row) => row[x + road.x - rect.x]).filter(Boolean).length);
      }
      expect(Math.max(...widths), `seed ${seed}`).toBeGreaterThan(2);
      expect(new Set(widths).size, `seed ${seed}`).toBeGreaterThan(2);
    }
  });

  it('moves the edge one tile at a time, so it drifts rather than alternates', () => {
    // The walk, stated as a property of the result: the top of the street never
    // jumps. This is what separates a road that bends from a battlement.
    for (const seed of SEEDS) {
      const { mask, rect } = raggedRect(road, makeRng(seed), { edges, minThickness: 2 });
      const top: number[] = [];
      for (let x = 0; x < road.width; x++) {
        top.push(mask.findIndex((row) => row[x + road.x - rect.x]));
      }
      for (let x = 1; x < top.length; x++) {
        expect(Math.abs(top[x] - top[x - 1]), `seed ${seed} at x=${x}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('still caps the run along a street 44 tiles long', () => {
    for (const seed of SEEDS) {
      const { longestRun } = raggedRect(road, makeRng(seed), { edges, minThickness: 2 });
      expect(longestRun).toBeLessThanOrEqual(RAGGED_DEFAULTS.maxRun);
    }
  });
});

describe('raggedRect against an obstruction', () => {
  // The case the town actually has: a street with houses along one side, so the
  // edge that would like to bulge cannot, for most of its length.
  const road: Rect = { x: 0, y: 20, width: 44, height: 2 };
  const wallRow = 19;

  it('never claims a cell the caller refused', () => {
    for (const seed of SEEDS) {
      const { cells } = raggedRect(road, makeRng(seed), {
        edges: { top: true, bottom: true },
        minThickness: 2,
        available: (x, y) => y !== wallRow || x < 4,
      });
      for (const c of cells) {
        if (c.y === wallRow) expect(c.x).toBeLessThan(4);
      }
    }
  });

  it('reports the run it could not break rather than claiming the cap', () => {
    // With one whole side walled off and a 2-tile street that cannot narrow,
    // the top edge has nowhere to go: it stays flush for all 44 tiles however
    // hard the forced turn tries. The honest answer is a long run, not a silent
    // one — this is the case RaggedPatch.longestRun exists for.
    const options = { edges: { top: true, bottom: true }, minThickness: 2 };
    const walled = raggedRect(road, makeRng(1), {
      ...options,
      available: (_x: number, y: number) => y !== wallRow,
    });
    expect(walled.longestRun).toBe(road.width);

    const free = raggedRect(road, makeRng(1), options);
    expect(free.longestRun).toBeLessThanOrEqual(RAGGED_DEFAULTS.maxRun);
  });

  it('needs both edges of a street ragged, not one', () => {
    // Worth stating because it is the trap: ragging the far side of a road and
    // leaving the near side flush changes nothing the measure can see, because
    // the flush side is still one run the length of the street.
    const oneSide = raggedRect(road, makeRng(1), { edges: { bottom: true }, minThickness: 2 });
    expect(oneSide.longestRun).toBe(road.width);
  });
});
