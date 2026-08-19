import { describe, it, expect } from 'vitest';
import {
  computeWallShape,
  refreshWallShapes,
  fillWallRect,
  fillWallCells,
  WALL_SHAPE_LEFT,
  WALL_SHAPE_RIGHT,
  WALL_SHAPE_BOTTOM,
  usesWallAutotileTable,
  isTileA3,
  isTileA4,
} from '../../src/core/wall-autotile.js';
import {
  makeAutotileId,
  getAutotileShape,
  getAutotileKind,
  TILE_ID_A2,
  TILE_ID_A3,
  TILE_ID_A4,
} from '../../src/core/autotile.js';

/**
 * Tilemap.WALL_AUTOTILE_TABLE, copied from the corescript. Each entry lists the
 * source quadrant (x, y) for the tile's top-left, top-right, bottom-left and
 * bottom-right corners, in half-tile units within the 4x4 block.
 *
 * The shape numbering is checked against this geometry rather than against
 * itself: x=0 means the left edge is drawn, x=3 the right, y=0 the top and
 * y=3 the bottom.
 */
const WALL_AUTOTILE_TABLE: [number, number][][] = [
  [[2, 2], [1, 2], [2, 1], [1, 1]],
  [[0, 2], [1, 2], [0, 1], [1, 1]],
  [[2, 0], [1, 0], [2, 1], [1, 1]],
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[2, 2], [3, 2], [2, 1], [3, 1]],
  [[0, 2], [3, 2], [0, 1], [3, 1]],
  [[2, 0], [3, 0], [2, 1], [3, 1]],
  [[0, 0], [3, 0], [0, 1], [3, 1]],
  [[2, 2], [1, 2], [2, 3], [1, 3]],
  [[0, 2], [1, 2], [0, 3], [1, 3]],
  [[2, 0], [1, 0], [2, 3], [1, 3]],
  [[0, 0], [1, 0], [0, 3], [1, 3]],
  [[2, 2], [3, 2], [2, 3], [3, 3]],
  [[0, 2], [3, 2], [0, 3], [3, 3]],
  [[2, 0], [3, 0], [2, 3], [3, 3]],
  [[0, 0], [3, 0], [0, 3], [3, 3]],
];

/** Read back which edges a shape actually draws, from the table's geometry. */
function edgesDrawnBy(shape: number): { left: boolean; top: boolean; right: boolean; bottom: boolean } {
  const quads = WALL_AUTOTILE_TABLE[shape];
  return {
    left: quads.some(([qx]) => qx === 0),
    top: quads.some(([, qy]) => qy === 0),
    right: quads.some(([qx]) => qx === 3),
    bottom: quads.some(([, qy]) => qy === 3),
  };
}

const A3_KIND = 56;
const wall = (shape: number) => makeAutotileId(A3_KIND, shape);
const otherWall = (shape: number) => makeAutotileId(60, shape);

describe('computeWallShape', () => {
  it('agrees with WALL_AUTOTILE_TABLE for all 16 neighbour configurations', () => {
    for (let mask = 0; mask < 16; mask++) {
      const connections = {
        w: (mask & 1) !== 0,
        n: (mask & 2) !== 0,
        e: (mask & 4) !== 0,
        s: (mask & 8) !== 0,
      };
      const shape = computeWallShape(connections);
      const drawn = edgesDrawnBy(shape);

      expect(drawn.left, `shape ${shape} left`).toBe(!connections.w);
      expect(drawn.top, `shape ${shape} top`).toBe(!connections.n);
      expect(drawn.right, `shape ${shape} right`).toBe(!connections.e);
      expect(drawn.bottom, `shape ${shape} bottom`).toBe(!connections.s);
    }
  });

  it('draws every edge when nothing matches, and none when all four do', () => {
    expect(computeWallShape({ n: false, e: false, s: false, w: false })).toBe(15);
    expect(computeWallShape({ n: true, e: true, s: true, w: true })).toBe(0);
  });
});

describe('usesWallAutotileTable', () => {
  it('is true for every A3 tile', () => {
    expect(usesWallAutotileTable(TILE_ID_A3)).toBe(true);
    expect(usesWallAutotileTable(makeAutotileId(79, 0))).toBe(true);
  });

  it('is false for A2 ground', () => {
    expect(usesWallAutotileTable(TILE_ID_A2)).toBe(false);
  });

  /**
   * The subtlety worth a test: A4 alternates. Odd block rows are walls and use
   * this table; even rows are wall *tops* and are drawn with the floor table, so
   * running the wall refresh over them would corrupt their shapes.
   */
  it('is true only for the odd A4 block rows', () => {
    expect(Math.floor(getAutotileKind(TILE_ID_A4) / 8)).toBe(10);
    expect(usesWallAutotileTable(makeAutotileId(80, 0))).toBe(false); // row 10, wall top
    expect(usesWallAutotileTable(makeAutotileId(88, 0))).toBe(true); // row 11, wall
    expect(usesWallAutotileTable(makeAutotileId(96, 0))).toBe(false); // row 12, wall top
    expect(usesWallAutotileTable(makeAutotileId(104, 0))).toBe(true); // row 13, wall
  });

  it('classifies the families', () => {
    expect(isTileA3(TILE_ID_A3)).toBe(true);
    expect(isTileA3(TILE_ID_A4)).toBe(false);
    expect(isTileA4(TILE_ID_A4)).toBe(true);
    expect(isTileA4(TILE_ID_A3)).toBe(false);
  });
});

describe('fillWallCells', () => {
  const WALL = makeAutotileId(57, 0);

  function blank(width: number, height: number): number[][] {
    return Array.from({ length: height }, () => new Array<number>(width).fill(0));
  }

  it('paints only the cells it is given, and shapes them from what is there', () => {
    // The wall band of an L notched at its bottom-right: columns 0-1 keep the
    // bottom row, column 2 stops a row higher.
    const cells = [
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 0, y: 3 },
      { x: 1, y: 3 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ];
    const grid = fillWallCells(blank(4, 4), cells, WALL);

    // Nothing outside the cell list was painted — the notch stays empty.
    expect(grid[3][2]).toBe(0);
    expect(grid[1][0]).toBe(0);

    // The step is a real edge in both directions: the tall wing draws its right
    // side where the short wing has stopped, and the short wing draws its left
    // side where the tall wing has not started.
    expect(getAutotileShape(grid[3][1]) & WALL_SHAPE_RIGHT).toBe(WALL_SHAPE_RIGHT);
    expect(getAutotileShape(grid[1][2]) & WALL_SHAPE_LEFT).toBe(WALL_SHAPE_LEFT);
    expect(getAutotileShape(grid[2][2]) & WALL_SHAPE_BOTTOM).toBe(WALL_SHAPE_BOTTOM);
    // Inside the band nothing spurious: (1,2) has wall left, right and below.
    expect(getAutotileShape(grid[2][1]) & WALL_SHAPE_RIGHT).toBe(0);
  });

  it('matches fillWallRect when the cells are a rectangle', () => {
    const rect = { x: 1, y: 1, width: 3, height: 2 };
    const cells = [];
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) cells.push({ x, y });
    }
    expect(fillWallCells(blank(5, 5), cells, WALL)).toEqual(
      fillWallRect(blank(5, 5), rect, WALL)
    );
  });

  it('leaves the grid alone when given nothing to paint', () => {
    expect(fillWallCells(blank(3, 3), [], WALL)).toEqual(blank(3, 3));
  });
});

describe('fillWallRect', () => {
  const blank = (w: number, h: number) =>
    Array.from({ length: h }, () => Array<number>(w).fill(0));

  it('gives a solid block the border shapes that make it read as a building', () => {
    const grid = fillWallRect(blank(5, 4), { x: 1, y: 1, width: 3, height: 2 }, wall(0));
    const shapes = grid.slice(1, 3).map((row) => row.slice(1, 4).map(getAutotileShape));

    // top row: left+top, top, right+top   bottom row: left+bottom, bottom, right+bottom
    expect(shapes).toEqual([
      [3, 2, 6],
      [9, 8, 12],
    ]);
  });

  it('gives a single tile every edge', () => {
    const grid = fillWallRect(blank(3, 3), { x: 1, y: 1, width: 1, height: 1 }, wall(0));
    expect(getAutotileShape(grid[1][1])).toBe(15);
  });

  it('keeps the material and only changes the shape', () => {
    const grid = fillWallRect(blank(3, 3), { x: 0, y: 0, width: 3, height: 3 }, wall(7));
    for (const row of grid) {
      for (const tileId of row) expect(getAutotileKind(tileId)).toBe(A3_KIND);
    }
    expect(getAutotileShape(grid[1][1])).toBe(0);
  });

  it('joins a block painted next to an earlier one of the same material', () => {
    let grid = fillWallRect(blank(6, 3), { x: 1, y: 1, width: 2, height: 1 }, wall(0));
    grid = fillWallRect(grid, { x: 3, y: 1, width: 2, height: 1 }, wall(0));

    // the seam tiles lose their facing edges and the run reads as one wall
    expect(grid[1].slice(1, 5).map(getAutotileShape)).toEqual([11, 10, 10, 14]);
  });

  it('does not merge two different materials', () => {
    let grid = fillWallRect(blank(5, 3), { x: 1, y: 1, width: 2, height: 1 }, wall(0));
    grid = fillWallRect(grid, { x: 3, y: 1, width: 1, height: 1 }, otherWall(0));

    expect(getAutotileShape(grid[1][2])).toBe(14); // still edged on its right
    expect(getAutotileShape(grid[1][3])).toBe(15); // the newcomer is isolated
  });

  it('leaves floor autotiles and plain tiles alone', () => {
    const grid = blank(3, 3);
    grid[0][0] = makeAutotileId(16, 20); // A2 floor with a deliberate shape
    grid[0][1] = 137; // a plain B-sheet object tile
    const next = refreshWallShapes(grid);

    expect(next[0][0]).toBe(makeAutotileId(16, 20));
    expect(next[0][1]).toBe(137);
  });

  it('treats out of bounds as the same material by default, matching the editor', () => {
    const inBounds = fillWallRect(blank(4, 4), { x: 0, y: 0, width: 2, height: 2 }, wall(0));
    // the corner at (0,0) runs to the map edge, so no edge is drawn there
    expect(getAutotileShape(inBounds[0][0])).toBe(0);

    const cut = fillWallRect(
      blank(4, 4),
      { x: 0, y: 0, width: 2, height: 2 },
      wall(0),
      { outOfBounds: 'different' }
    );
    expect(getAutotileShape(cut[0][0])).toBe(3); // left + top
  });

  it('scoped refresh matches a full refresh', () => {
    const scoped = fillWallRect(blank(8, 8), { x: 2, y: 2, width: 3, height: 3 }, wall(0));

    const manual = blank(8, 8);
    for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) manual[y][x] = wall(0);
    const full = refreshWallShapes(manual);

    expect(scoped).toEqual(full);
  });
});
