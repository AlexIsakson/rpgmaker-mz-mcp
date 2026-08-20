import { describe, it, expect } from 'vitest';
import {
  isTileA1,
  isWaterfallTile,
  isWaterfallKind,
  isWaterTile,
  usesWaterfallAutotileTable,
  computeWaterfallShape,
  refreshWaterfallShapes,
  fillWaterCells,
  describeA1Kind,
  WATERFALL_SHAPE_LEFT,
  WATERFALL_SHAPE_RIGHT,
  WATERFALL_SHAPE_MAX,
  WATERFALL_KIND_MIN,
  A1_KIND_MAX,
} from '../../src/core/water-autotile.js';
import {
  TILE_ID_A1,
  TILE_ID_A2,
  makeAutotileId,
  getAutotileShape,
  getAutotileKind,
  usesFloorAutotileTable,
  refreshAutotileShapes,
  SHAPE_FULL,
} from '../../src/core/autotile.js';

/**
 * `Tilemap.WATERFALL_AUTOTILE_TABLE`, copied from rmmz_core.js v1.9.0. The
 * shape numbering this module uses is *derived from this table's geometry*
 * rather than asserted, the same way autotile.test.ts re-derives the floor
 * table's — so these tests check the meaning of each shape, not a restatement
 * of the implementation.
 *
 * Each entry is four [qsx, qsy] pairs in the order TL, TR, BL, BR, from the
 * `dx1 = dx + (i % 2) * w1; dy1 = dy + Math.floor(i / 2) * h1` in
 * `Tilemap.prototype._addAutotile`. A waterfall block is four half-tile columns
 * wide: qsx 0 is the left edge, 1 and 2 the seamless middle pair, 3 the right.
 */
const WATERFALL_AUTOTILE_TABLE = [
  [[2, 0], [1, 0], [2, 1], [1, 1]],
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[2, 0], [3, 0], [2, 1], [3, 1]],
  [[0, 0], [3, 0], [0, 1], [3, 1]],
];

/** Does this shape draw the sheet's leftmost half-tile column on its left side? */
const drawsLeftEdge = (shape: number): boolean =>
  WATERFALL_AUTOTILE_TABLE[shape][0][0] === 0 && WATERFALL_AUTOTILE_TABLE[shape][2][0] === 0;

/** ...and the rightmost on its right side? */
const drawsRightEdge = (shape: number): boolean =>
  WATERFALL_AUTOTILE_TABLE[shape][1][0] === 3 && WATERFALL_AUTOTILE_TABLE[shape][3][0] === 3;

const waterfall = (kind: number, shape = 0) => makeAutotileId(kind, shape);

describe('the engine boundary', () => {
  it('matches Tilemap.isTileA1', () => {
    expect(isTileA1(TILE_ID_A1)).toBe(true);
    expect(isTileA1(TILE_ID_A2 - 1)).toBe(true);
    expect(isTileA1(TILE_ID_A2)).toBe(false);
    expect(isTileA1(TILE_ID_A1 - 1)).toBe(false);
  });

  it('matches Tilemap.isWaterfallTile — kind 4 and up, odd', () => {
    // The engine writes it as `tileId >= TILE_ID_A1 + 192`, and 192 / 48 = 4.
    expect(WATERFALL_KIND_MIN * 48).toBe(192);
    for (let kind = 0; kind <= A1_KIND_MAX; kind++) {
      const expected = kind >= 4 && kind % 2 === 1;
      expect(isWaterfallKind(kind), `kind ${kind}`).toBe(expected);
      expect(isWaterfallTile(makeAutotileId(kind, 0)), `kind ${kind}`).toBe(expected);
    }
    // 5, 7, 9, 11, 13, 15 and nothing else.
    const kinds = [];
    for (let k = 0; k <= A1_KIND_MAX; k++) if (isWaterfallKind(k)) kinds.push(k);
    expect(kinds).toEqual([5, 7, 9, 11, 13, 15]);
  });

  it('matches Tilemap.isWaterTile — every A1 kind but 2 and 3', () => {
    for (let kind = 0; kind <= A1_KIND_MAX; kind++) {
      expect(isWaterTile(makeAutotileId(kind, 0)), `kind ${kind}`).toBe(kind !== 2 && kind !== 3);
    }
    expect(isWaterTile(TILE_ID_A2)).toBe(false);
  });

  it('splits A1 between the two tables the way isFloorTypeAutotile does', () => {
    // Tilemap.isFloorTypeAutotile = A1-and-not-waterfall, A2, or a wall top.
    // Every A1 kind belongs to exactly one of the two tables, and this is the
    // assertion that autotile.ts and water-autotile.ts agree about which.
    for (let kind = 0; kind <= A1_KIND_MAX; kind++) {
      const id = makeAutotileId(kind, 0);
      expect(usesFloorAutotileTable(id) !== usesWaterfallAutotileTable(id), `kind ${kind}`).toBe(true);
    }
  });
});

describe('computeWaterfallShape', () => {
  it('has exactly the four shapes the table has', () => {
    expect(WATERFALL_AUTOTILE_TABLE).toHaveLength(WATERFALL_SHAPE_MAX + 1);
    const seen = new Set<number>();
    for (const left of [true, false]) {
      for (const right of [true, false]) seen.add(computeWaterfallShape(left, right));
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  it('draws an edge exactly where the fall does not continue', () => {
    // Checked against the table's own geometry, not against the constants.
    for (const left of [true, false]) {
      for (const right of [true, false]) {
        const shape = computeWaterfallShape(left, right);
        expect(drawsLeftEdge(shape), `left ${left}`).toBe(!left);
        expect(drawsRightEdge(shape), `right ${right}`).toBe(!right);
      }
    }
  });

  it('names its bits the way the table numbers them', () => {
    expect(computeWaterfallShape(false, true)).toBe(WATERFALL_SHAPE_LEFT);
    expect(computeWaterfallShape(true, false)).toBe(WATERFALL_SHAPE_RIGHT);
    expect(computeWaterfallShape(true, true)).toBe(SHAPE_FULL);
    expect(computeWaterfallShape(false, false)).toBe(WATERFALL_SHAPE_LEFT + WATERFALL_SHAPE_RIGHT);
  });
});

describe('refreshWaterfallShapes', () => {
  const blank = (w: number, h: number) =>
    Array.from({ length: h }, () => new Array<number>(w).fill(0));

  it('shapes a run of falls: edge, middle, edge', () => {
    const grid = blank(6, 3);
    for (let y = 0; y < 3; y++) for (let x = 1; x <= 4; x++) grid[y][x] = waterfall(5);
    const out = refreshWaterfallShapes(grid, { outOfBounds: 'different' });
    for (let y = 0; y < 3; y++) {
      expect(getAutotileShape(out[y][1]), `row ${y}`).toBe(WATERFALL_SHAPE_LEFT);
      expect(getAutotileShape(out[y][2]), `row ${y}`).toBe(0);
      expect(getAutotileShape(out[y][3]), `row ${y}`).toBe(0);
      expect(getAutotileShape(out[y][4]), `row ${y}`).toBe(WATERFALL_SHAPE_RIGHT);
    }
  });

  it('gives a one-tile fall both edges', () => {
    const grid = blank(3, 4);
    for (let y = 0; y < 4; y++) grid[y][1] = waterfall(9);
    const out = refreshWaterfallShapes(grid, { outOfBounds: 'different' });
    for (let y = 0; y < 4; y++) expect(getAutotileShape(out[y][1])).toBe(3);
  });

  it('ignores vertical neighbours — the table has no shape for them', () => {
    // A fall repeats down its column; the three animation frames supply the
    // motion. Corpus: columns run a median of 2 tiles and up to 37, all one
    // shape.
    const grid = blank(4, 8);
    for (let y = 0; y < 8; y++) for (let x = 1; x <= 2; x++) grid[y][x] = waterfall(11);
    const out = refreshWaterfallShapes(grid, { outOfBounds: 'different' });
    const column = out.map((row) => getAutotileShape(row[1]));
    expect(new Set(column).size).toBe(1);
    expect(column[0]).toBe(WATERFALL_SHAPE_LEFT);
  });

  it('does not join two different waterfall kinds', () => {
    const grid = blank(4, 1);
    grid[0][1] = waterfall(5);
    grid[0][2] = waterfall(7);
    const out = refreshWaterfallShapes(grid, { outOfBounds: 'different' });
    expect(getAutotileShape(out[0][1])).toBe(3);
    expect(getAutotileShape(out[0][2])).toBe(3);
  });

  it('leaves water, ground and walls alone', () => {
    const grid = [[makeAutotileId(0, 12), makeAutotileId(20, 30), makeAutotileId(60, 5), 0]];
    expect(refreshWaterfallShapes(grid)).toEqual(grid);
  });

  it('treats the map edge as continuing by default, like the floor table', () => {
    const grid = [[waterfall(5), waterfall(5)]];
    const joined = refreshWaterfallShapes(grid);
    expect(getAutotileShape(joined[0][0])).toBe(0);
    expect(getAutotileShape(joined[0][1])).toBe(0);

    const cut = refreshWaterfallShapes(grid, { outOfBounds: 'different' });
    expect(getAutotileShape(cut[0][0])).toBe(WATERFALL_SHAPE_LEFT);
    expect(getAutotileShape(cut[0][1])).toBe(WATERFALL_SHAPE_RIGHT);
  });

  it('honours a region, reading neighbours from outside it', () => {
    const grid = Array.from({ length: 1 }, () => [
      waterfall(5, 3), waterfall(5, 3), waterfall(5, 3),
    ]);
    const out = refreshWaterfallShapes(grid, {
      outOfBounds: 'different',
      region: { x: 1, y: 0, width: 1, height: 1 },
    });
    // Only the middle is rewritten, and it sees its neighbours either side.
    expect(getAutotileShape(out[0][0])).toBe(3);
    expect(getAutotileShape(out[0][1])).toBe(0);
    expect(getAutotileShape(out[0][2])).toBe(3);
  });
});

describe('A1 water on the floor table', () => {
  it('shapes a lake with the 48-shape vocabulary', () => {
    // This is the regression the whole task exists for: before A1 joined
    // usesFloorAutotileTable, every one of these stayed at shape 0.
    const grid = Array.from({ length: 5 }, () => new Array<number>(5).fill(0));
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) grid[y][x] = makeAutotileId(0, 0);
    const out = refreshAutotileShapes(grid, { outOfBounds: 'different' });
    expect(getAutotileShape(out[2][2])).toBe(SHAPE_FULL);      // middle
    const edges = [out[1][2], out[2][1], out[2][3], out[3][2]].map(getAutotileShape);
    for (const shape of edges) expect(shape).toBeGreaterThan(0);
    const corners = [out[1][1], out[1][3], out[3][1], out[3][3]].map(getAutotileShape);
    for (const shape of corners) expect(shape).toBeGreaterThan(15); // two edges meeting
  });

  it('leaves a waterfall out of the floor pass', () => {
    const grid = [[waterfall(5, 3)]];
    expect(refreshAutotileShapes(grid, { outOfBounds: 'different' })).toEqual(grid);
  });
});

describe('fillWaterCells', () => {
  it('paints a lake and shapes it in one call', () => {
    const grid = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
    const cells: { x: number; y: number }[] = [];
    for (let y = 1; y <= 4; y++) for (let x = 1; x <= 4; x++) cells.push({ x, y });
    const out = fillWaterCells(grid, cells, makeAutotileId(0, 0), { outOfBounds: 'different' });
    expect(getAutotileKind(out[2][2])).toBe(0);
    expect(getAutotileShape(out[2][2])).toBe(SHAPE_FULL);
    expect(getAutotileShape(out[1][1])).toBeGreaterThan(0);
    expect(out[0][0]).toBe(0);
  });

  it('paints a fall and shapes it in one call', () => {
    const grid = Array.from({ length: 5 }, () => new Array<number>(5).fill(0));
    const cells: { x: number; y: number }[] = [];
    for (let y = 0; y < 5; y++) for (let x = 1; x <= 2; x++) cells.push({ x, y });
    const out = fillWaterCells(grid, cells, waterfall(5), { outOfBounds: 'different' });
    for (let y = 0; y < 5; y++) {
      expect(getAutotileShape(out[y][1]), `row ${y}`).toBe(WATERFALL_SHAPE_LEFT);
      expect(getAutotileShape(out[y][2]), `row ${y}`).toBe(WATERFALL_SHAPE_RIGHT);
    }
  });

  it('reshapes the water already beside what it paints', () => {
    const grid = Array.from({ length: 3 }, () => new Array<number>(4).fill(0));
    grid[1][1] = makeAutotileId(0, 46); // an isolated pond
    const out = fillWaterCells(grid, [{ x: 2, y: 1 }], makeAutotileId(0, 0), {
      outOfBounds: 'different',
    });
    // The old tile is no longer isolated, so its shape had to change.
    expect(getAutotileShape(out[1][1])).not.toBe(46);
    expect(getAutotileShape(out[1][2])).not.toBe(46);
  });

  it('does nothing with no cells', () => {
    const grid = [[1, 2], [3, 4]];
    expect(fillWaterCells(grid, [], makeAutotileId(0, 0))).toEqual(grid);
  });
});

describe('describeA1Kind', () => {
  it('reports the table from the slot', () => {
    for (let kind = 0; kind <= A1_KIND_MAX; kind++) {
      const facts = describeA1Kind(kind);
      expect(facts.table).toBe(isWaterfallKind(kind) ? 'waterfall' : 'floor');
    }
  });

  it('marks kinds 2 and 3 as the static slots', () => {
    // _addAutotile gives them a fixed bx of 6 with no waterSurfaceIndex term.
    expect(describeA1Kind(2).animated).toBe(false);
    expect(describeA1Kind(3).animated).toBe(false);
    expect(describeA1Kind(2).water).toBe(false);
    expect(describeA1Kind(3).water).toBe(false);
    for (const kind of [0, 1, 4, 5, 10, 15]) {
      expect(describeA1Kind(kind).animated, `kind ${kind}`).toBe(true);
    }
  });
});
