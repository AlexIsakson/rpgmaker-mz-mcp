import { describe, it, expect } from 'vitest';
import {
  computeFloorShape,
  refreshAutotileShapes,
  fillRect,
  makeAutotileId,
  getAutotileKind,
  getAutotileShape,
  isSameKindTile,
  isTileA2,
  isAutotile,
  SHAPE_ISOLATED,
  SHAPE_FULL,
  TILE_ID_A2,
  TILE_ID_A4,
  type Connections,
} from '../../src/core/autotile.js';

/**
 * Verbatim copy of Tilemap.FLOOR_AUTOTILE_TABLE from the MZ corescript
 * (rmmz_core.js). Each shape lists the source quadrants [TL, TR, BL, BR] as
 * [x, y] in a 4-wide x 6-tall grid of half-tiles.
 *
 * This is the engine's own definition of what each shape looks like, so
 * decoding it back into edges/corners is an independent check that our shape
 * numbering is right — not just self-consistent.
 */
const FLOOR_AUTOTILE_TABLE: number[][][] = [
  [[2, 4], [1, 4], [2, 3], [1, 3]],
  [[2, 0], [1, 4], [2, 3], [1, 3]],
  [[2, 4], [3, 0], [2, 3], [1, 3]],
  [[2, 0], [3, 0], [2, 3], [1, 3]],
  [[2, 4], [1, 4], [2, 3], [3, 1]],
  [[2, 0], [1, 4], [2, 3], [3, 1]],
  [[2, 4], [3, 0], [2, 3], [3, 1]],
  [[2, 0], [3, 0], [2, 3], [3, 1]],
  [[2, 4], [1, 4], [2, 1], [1, 3]],
  [[2, 0], [1, 4], [2, 1], [1, 3]],
  [[2, 4], [3, 0], [2, 1], [1, 3]],
  [[2, 0], [3, 0], [2, 1], [1, 3]],
  [[2, 4], [1, 4], [2, 1], [3, 1]],
  [[2, 0], [1, 4], [2, 1], [3, 1]],
  [[2, 4], [3, 0], [2, 1], [3, 1]],
  [[2, 0], [3, 0], [2, 1], [3, 1]],
  [[0, 4], [1, 4], [0, 3], [1, 3]],
  [[0, 4], [3, 0], [0, 3], [1, 3]],
  [[0, 4], [1, 4], [0, 3], [3, 1]],
  [[0, 4], [3, 0], [0, 3], [3, 1]],
  [[2, 2], [1, 2], [2, 3], [1, 3]],
  [[2, 2], [1, 2], [2, 3], [3, 1]],
  [[2, 2], [1, 2], [2, 1], [1, 3]],
  [[2, 2], [1, 2], [2, 1], [3, 1]],
  [[2, 4], [3, 4], [2, 3], [3, 3]],
  [[2, 4], [3, 4], [2, 1], [3, 3]],
  [[2, 0], [3, 4], [2, 3], [3, 3]],
  [[2, 0], [3, 4], [2, 1], [3, 3]],
  [[2, 4], [1, 4], [2, 5], [1, 5]],
  [[2, 0], [1, 4], [2, 5], [1, 5]],
  [[2, 4], [3, 0], [2, 5], [1, 5]],
  [[2, 0], [3, 0], [2, 5], [1, 5]],
  [[0, 4], [3, 4], [0, 3], [3, 3]],
  [[2, 2], [1, 2], [2, 5], [1, 5]],
  [[0, 2], [1, 2], [0, 3], [1, 3]],
  [[0, 2], [1, 2], [0, 3], [3, 1]],
  [[2, 2], [3, 2], [2, 3], [3, 3]],
  [[2, 2], [3, 2], [2, 1], [3, 3]],
  [[2, 4], [3, 4], [2, 5], [3, 5]],
  [[2, 0], [3, 4], [2, 5], [3, 5]],
  [[0, 4], [1, 4], [0, 5], [1, 5]],
  [[0, 4], [3, 0], [0, 5], [1, 5]],
  [[0, 2], [3, 2], [0, 3], [3, 3]],
  [[0, 2], [1, 2], [0, 5], [1, 5]],
  [[0, 4], [3, 4], [0, 5], [3, 5]],
  [[2, 2], [3, 2], [2, 5], [3, 5]],
  [[0, 2], [3, 2], [0, 5], [3, 5]],
  [[0, 0], [1, 0], [0, 1], [1, 1]],
];

interface Geometry {
  edgeW: boolean;
  edgeN: boolean;
  edgeE: boolean;
  edgeS: boolean;
  cornerTL: boolean;
  cornerTR: boolean;
  cornerBR: boolean;
  cornerBL: boolean;
}

/**
 * Read a table row back as geometry. Inner-corner pieces live in half-tile
 * rows 0-1; edge pieces live at x=0 (left), x=3 (right), y=2 (top), y=5
 * (bottom). A side with an edge forces both its quadrants to be non-corner, so
 * reading either quadrant of a side agrees.
 */
function decodeShape(shape: number): Geometry {
  const [TL, TR, BL, BR] = FLOOR_AUTOTILE_TABLE[shape];

  const cornerTL = TL[1] <= 1;
  const cornerTR = TR[1] <= 1;
  const cornerBL = BL[1] <= 1;
  const cornerBR = BR[1] <= 1;

  return {
    cornerTL,
    cornerTR,
    cornerBR,
    cornerBL,
    edgeW: (!cornerTL && TL[0] === 0) || (!cornerBL && BL[0] === 0),
    edgeN: (!cornerTL && TL[1] === 2) || (!cornerTR && TR[1] === 2),
    edgeE: (!cornerTR && TR[0] === 3) || (!cornerBR && BR[0] === 3),
    edgeS: (!cornerBL && BL[1] === 5) || (!cornerBR && BR[1] === 5),
  };
}

function connectionsFromMask(mask: number): Connections {
  return {
    n: (mask & 1) !== 0,
    e: (mask & 2) !== 0,
    s: (mask & 4) !== 0,
    w: (mask & 8) !== 0,
    nw: (mask & 16) !== 0,
    ne: (mask & 32) !== 0,
    se: (mask & 64) !== 0,
    sw: (mask & 128) !== 0,
  };
}

/** Fixed key order — JSON.stringify is order-sensitive and these are built by
 *  two different functions. */
function canonical(g: Geometry): string {
  return [
    `W${+g.edgeW}`, `N${+g.edgeN}`, `E${+g.edgeE}`, `S${+g.edgeS}`,
    `tl${+g.cornerTL}`, `tr${+g.cornerTR}`, `br${+g.cornerBR}`, `bl${+g.cornerBL}`,
  ].join(' ');
}

function expectedGeometry(c: Connections): Geometry {
  return {
    edgeW: !c.w,
    edgeN: !c.n,
    edgeE: !c.e,
    edgeS: !c.s,
    cornerTL: c.n && c.w && !c.nw,
    cornerTR: c.n && c.e && !c.ne,
    cornerBR: c.s && c.e && !c.se,
    cornerBL: c.s && c.w && !c.sw,
  };
}

describe('computeFloorShape validated against the engine shape table', () => {
  it('produces a shape whose drawn geometry matches the neighbours, for all 256 configurations', () => {
    const mismatches: string[] = [];

    for (let mask = 0; mask < 256; mask++) {
      const connections = connectionsFromMask(mask);
      const shape = computeFloorShape(connections);
      const actual = decodeShape(shape);
      const expected = expectedGeometry(connections);

      if (canonical(actual) !== canonical(expected)) {
        mismatches.push(
          `mask ${mask} -> shape ${shape}\n  expected ${canonical(expected)}\n  drawn    ${canonical(actual)}`
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('only ever emits shapes 0-46', () => {
    for (let mask = 0; mask < 256; mask++) {
      const shape = computeFloorShape(connectionsFromMask(mask));
      expect(shape).toBeGreaterThanOrEqual(0);
      expect(shape).toBeLessThanOrEqual(46);
    }
  });

  it('maps distinct geometries to distinct shapes', () => {
    // Every shape the function emits should be reachable by exactly one
    // geometry, otherwise the numbering collapses cases together.
    const geometryByShape = new Map<number, string>();
    for (let mask = 0; mask < 256; mask++) {
      const c = connectionsFromMask(mask);
      const shape = computeFloorShape(c);
      const geometry = canonical(expectedGeometry(c));
      const seen = geometryByShape.get(shape);
      if (seen === undefined) geometryByShape.set(shape, geometry);
      else expect(geometry).toBe(seen);
    }
  });
});

describe('computeFloorShape anchors', () => {
  const all = (value: boolean): Connections => ({
    n: value, e: value, s: value, w: value,
    nw: value, ne: value, se: value, sw: value,
  });

  it('is the full centre tile when every neighbour matches', () => {
    expect(computeFloorShape(all(true))).toBe(SHAPE_FULL);
  });

  it('is the isolated tile when nothing matches', () => {
    expect(computeFloorShape(all(false))).toBe(SHAPE_ISOLATED);
  });

  it('picks single-edge shapes', () => {
    expect(computeFloorShape({ ...all(true), w: false, nw: false, sw: false })).toBe(16);
    expect(computeFloorShape({ ...all(true), n: false, nw: false, ne: false })).toBe(20);
    expect(computeFloorShape({ ...all(true), e: false, ne: false, se: false })).toBe(24);
    expect(computeFloorShape({ ...all(true), s: false, se: false, sw: false })).toBe(28);
  });

  it('picks inner-corner shapes when only a diagonal is missing', () => {
    expect(computeFloorShape({ ...all(true), nw: false })).toBe(1);
    expect(computeFloorShape({ ...all(true), ne: false })).toBe(2);
    expect(computeFloorShape({ ...all(true), se: false })).toBe(4);
    expect(computeFloorShape({ ...all(true), sw: false })).toBe(8);
  });

  it('ignores a missing diagonal when the adjacent side is already an edge', () => {
    // nw cannot form a corner if w is not connected — the edge covers it.
    const withEdge = { ...all(true), w: false, sw: false };
    expect(computeFloorShape({ ...withEdge, nw: true })).toBe(
      computeFloorShape({ ...withEdge, nw: false })
    );
  });
});

describe('tile id helpers', () => {
  it('round-trips kind and shape', () => {
    const id = makeAutotileId(20, 33);
    expect(getAutotileKind(id)).toBe(20);
    expect(getAutotileShape(id)).toBe(33);
  });

  it('classifies the A2 ground range', () => {
    expect(isTileA2(TILE_ID_A2)).toBe(true);
    expect(isTileA2(TILE_ID_A2 - 1)).toBe(false);
    expect(isTileA2(TILE_ID_A4)).toBe(false);
    expect(isAutotile(TILE_ID_A2)).toBe(true);
    expect(isAutotile(0)).toBe(false);
  });

  it('matches tiles of the same kind regardless of shape', () => {
    expect(isSameKindTile(makeAutotileId(16, 0), makeAutotileId(16, 46))).toBe(true);
    expect(isSameKindTile(makeAutotileId(16, 0), makeAutotileId(17, 0))).toBe(false);
    expect(isSameKindTile(5, 5)).toBe(true);
    expect(isSameKindTile(5, 6)).toBe(false);
  });
});

// A2 kinds start at 16: (2816 - 2048) / 48 === 16
const GRASS = makeAutotileId(16, 0);
const DIRT = makeAutotileId(17, 0);
const EMPTY = 0;

function grid(rows: number[][]): number[][] {
  return rows.map((row) => [...row]);
}

describe('refreshAutotileShapes', () => {
  it('gives a 3x3 block correct corners, edges, and centre', () => {
    const before = grid([
      [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY],
      [EMPTY, GRASS, GRASS, GRASS, EMPTY],
      [EMPTY, GRASS, GRASS, GRASS, EMPTY],
      [EMPTY, GRASS, GRASS, GRASS, EMPTY],
      [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY],
    ]);

    const after = refreshAutotileShapes(before);

    // centre is fully surrounded
    expect(getAutotileShape(after[2][2])).toBe(SHAPE_FULL);
    // top-left of the block has top+left edges, no free corner
    expect(getAutotileShape(after[1][1])).toBe(34);
    // top-middle has only a top edge
    expect(getAutotileShape(after[1][2])).toBe(20);
    // middle-left has only a left edge
    expect(getAutotileShape(after[2][1])).toBe(16);
    // bottom-right has bottom+right edges
    expect(getAutotileShape(after[3][3])).toBe(38);
  });

  it('marks a lone tile as isolated', () => {
    const after = refreshAutotileShapes(grid([
      [EMPTY, EMPTY, EMPTY],
      [EMPTY, GRASS, EMPTY],
      [EMPTY, EMPTY, EMPTY],
    ]));

    expect(getAutotileShape(after[1][1])).toBe(SHAPE_ISOLATED);
  });

  it('keeps the material and only changes the shape', () => {
    const after = refreshAutotileShapes(grid([[GRASS, GRASS], [GRASS, GRASS]]));
    for (const row of after) {
      for (const id of row) expect(getAutotileKind(id)).toBe(16);
    }
  });

  it('treats a different material as an edge, not a connection', () => {
    const after = refreshAutotileShapes(grid([
      [DIRT, DIRT, DIRT],
      [DIRT, GRASS, DIRT],
      [DIRT, DIRT, DIRT],
    ]));

    expect(getAutotileShape(after[1][1])).toBe(SHAPE_ISOLATED);
  });

  it('runs a material to the border without an edge by default', () => {
    const after = refreshAutotileShapes(grid([
      [GRASS, GRASS],
      [GRASS, GRASS],
    ]));

    for (const row of after) {
      for (const id of row) expect(getAutotileShape(id)).toBe(SHAPE_FULL);
    }
  });

  it('draws a border edge when outOfBounds is "different"', () => {
    const after = refreshAutotileShapes(
      grid([[GRASS, GRASS], [GRASS, GRASS]]),
      { outOfBounds: 'different' }
    );

    // every tile is on a corner of this 2x2, so each has two edges
    expect(getAutotileShape(after[0][0])).toBe(34); // top+left
    expect(getAutotileShape(after[1][1])).toBe(38); // bottom+right
  });

  it('leaves non-A2 tiles untouched', () => {
    const wall = TILE_ID_A4 + 5;
    const after = refreshAutotileShapes(grid([
      [wall, wall],
      [wall, EMPTY],
    ]));

    expect(after[0][0]).toBe(wall);
    expect(after[1][1]).toBe(EMPTY);
  });

  it('does not mutate the input grid', () => {
    const before = grid([[GRASS, EMPTY], [EMPTY, EMPTY]]);
    const snapshot = JSON.stringify(before);
    refreshAutotileShapes(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('fillRect', () => {
  it('paints a rectangle and shapes it correctly', () => {
    const before = grid([
      [EMPTY, EMPTY, EMPTY, EMPTY],
      [EMPTY, EMPTY, EMPTY, EMPTY],
      [EMPTY, EMPTY, EMPTY, EMPTY],
      [EMPTY, EMPTY, EMPTY, EMPTY],
    ]);

    const after = fillRect(before, { x: 1, y: 1, width: 2, height: 2 }, GRASS);

    expect(getAutotileKind(after[1][1])).toBe(16);
    expect(getAutotileShape(after[1][1])).toBe(34); // top+left
    expect(getAutotileShape(after[2][2])).toBe(38); // bottom+right
    expect(after[0][0]).toBe(EMPTY);
  });

  it('reshapes existing neighbours the new area touches', () => {
    // A lone grass tile is isolated; painting beside it must un-isolate it.
    // Kept off the border so the default outOfBounds:'same' does not connect it.
    const before = grid([
      [EMPTY, EMPTY, EMPTY, EMPTY],
      [EMPTY, GRASS, EMPTY, EMPTY],
      [EMPTY, EMPTY, EMPTY, EMPTY],
      [EMPTY, EMPTY, EMPTY, EMPTY],
    ]);
    expect(getAutotileShape(refreshAutotileShapes(before)[1][1])).toBe(SHAPE_ISOLATED);

    const after = fillRect(before, { x: 2, y: 1, width: 1, height: 1 }, GRASS);
    expect(getAutotileShape(after[1][1])).not.toBe(SHAPE_ISOLATED);
    expect(getAutotileShape(after[1][1])).toBe(43); // W, N, S edges — open to the east
  });

  it('only rewrites tiles within one step of the painted area', () => {
    // A distant tile whose neighbourhood did not change must keep its exact id,
    // shape included — filling a corner should not rewrite the whole map.
    const before = grid([
      [GRASS, GRASS, EMPTY, EMPTY, EMPTY],
      [GRASS, GRASS, EMPTY, EMPTY, EMPTY],
      [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY],
      [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY],
      [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY],
    ]);
    // Deliberately wrong shape on a far-away tile.
    before[0][0] = makeAutotileId(16, 46);

    const after = fillRect(before, { x: 4, y: 4, width: 1, height: 1 }, GRASS);

    expect(after[0][0]).toBe(makeAutotileId(16, 46)); // untouched, still "wrong"
    expect(getAutotileKind(after[4][4])).toBe(16); // painted
  });

  it('produces the same result as a full refresh inside the affected area', () => {
    const before = grid([
      [EMPTY, EMPTY, EMPTY, EMPTY],
      [EMPTY, EMPTY, EMPTY, EMPTY],
      [EMPTY, EMPTY, EMPTY, EMPTY],
      [EMPTY, EMPTY, EMPTY, EMPTY],
    ]);

    const scoped = fillRect(before, { x: 1, y: 1, width: 2, height: 2 }, GRASS);
    const full = refreshAutotileShapes(
      fillRect(before, { x: 1, y: 1, width: 2, height: 2 }, GRASS)
    );

    expect(scoped).toEqual(full);
  });

  it('clips a rectangle that runs past the edge', () => {
    const before = grid([[EMPTY, EMPTY], [EMPTY, EMPTY]]);
    const after = fillRect(before, { x: 1, y: 1, width: 5, height: 5 }, GRASS);

    expect(getAutotileKind(after[1][1])).toBe(16);
    expect(after[0][0]).toBe(EMPTY);
    expect(after).toHaveLength(2);
  });
});
