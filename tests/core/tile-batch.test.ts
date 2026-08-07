import { describe, it, expect } from 'vitest';
import { applyPlacements, type Placement } from '../../src/core/tile-batch.js';
import {
  refreshAutotileShapes,
  makeAutotileId,
  getAutotileShape,
  getAutotileKind,
  SHAPE_FULL,
  SHAPE_ISOLATED,
} from '../../src/core/autotile.js';
import { refreshWallShapes } from '../../src/core/wall-autotile.js';

const GRASS = 16;   // an A2 ground kind
const STONE = 17;   // a different A2 ground kind
const WALL = 57;    // an A3 wall kind
const PROP = 118;   // a B-sheet object tile — no shape

const ground = (kind: number) => makeAutotileId(kind, 0);

function emptyGrid(width: number, height: number, fill = 0): number[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => fill));
}

describe('applyPlacements', () => {
  it('writes every placement and reports the count', () => {
    const result = applyPlacements(emptyGrid(6, 6), [
      { x: 1, y: 1, tileId: PROP },
      { x: 4, y: 2, tileId: PROP },
      { x: 2, y: 5, tileId: PROP },
    ]);

    expect(result.painted).toBe(3);
    expect(result.grid[1][1]).toBe(PROP);
    expect(result.grid[2][4]).toBe(PROP);
    expect(result.grid[5][2]).toBe(PROP);
  });

  it('leaves the input grid alone', () => {
    const grid = emptyGrid(4, 4);
    applyPlacements(grid, [{ x: 1, y: 1, tileId: PROP }]);
    expect(grid[1][1]).toBe(0);
  });

  it('discards placements outside the grid instead of throwing', () => {
    const result = applyPlacements(emptyGrid(4, 4), [
      { x: 1, y: 1, tileId: PROP },
      { x: -1, y: 2, tileId: PROP },
      { x: 4, y: 0, tileId: PROP },
      { x: 0, y: 9, tileId: PROP },
    ]);

    expect(result.painted).toBe(1);
    expect(result.outOfBounds).toEqual([
      { x: -1, y: 2, tileId: PROP },
      { x: 4, y: 0, tileId: PROP },
      { x: 0, y: 9, tileId: PROP },
    ]);
  });

  it('lets a later placement win, and counts the collision', () => {
    const result = applyPlacements(emptyGrid(4, 4), [
      { x: 1, y: 1, tileId: PROP },
      { x: 1, y: 1, tileId: PROP + 1 },
    ]);

    expect(result.grid[1][1]).toBe(PROP + 1);
    expect(result.duplicates).toBe(1);
  });

  it('counts tiles it replaced', () => {
    const grid = emptyGrid(4, 4);
    grid[1][1] = PROP;
    const result = applyPlacements(grid, [{ x: 1, y: 1, tileId: PROP + 1 }]);
    expect(result.overwritten).toBe(1);
    expect(result.duplicates).toBe(0);
  });

  it('clears a cell when given tile 0', () => {
    const grid = emptyGrid(4, 4);
    grid[2][2] = PROP;
    const result = applyPlacements(grid, [{ x: 2, y: 2, tileId: 0 }]);
    expect(result.grid[2][2]).toBe(0);
  });

  describe('skipOccupied', () => {
    it('leaves cells that already hold something', () => {
      const grid = emptyGrid(4, 4);
      grid[1][1] = PROP;
      const result = applyPlacements(
        grid,
        [{ x: 1, y: 1, tileId: PROP + 1 }, { x: 2, y: 2, tileId: PROP + 1 }],
        { skipOccupied: true }
      );

      expect(result.grid[1][1]).toBe(PROP);
      expect(result.grid[2][2]).toBe(PROP + 1);
      expect(result.skipped).toBe(1);
      expect(result.painted).toBe(1);
    });

    it('also protects a cell the batch itself just filled', () => {
      // The point of skipOccupied is that a later object cannot clobber an
      // earlier one; that has to hold within a batch too, or batching would
      // quietly change the meaning of the flag.
      const result = applyPlacements(
        emptyGrid(4, 4),
        [{ x: 1, y: 1, tileId: PROP }, { x: 1, y: 1, tileId: PROP + 1 }],
        { skipOccupied: true }
      );

      expect(result.grid[1][1]).toBe(PROP);
      expect(result.skipped).toBe(1);
    });
  });
});

describe('shape computation', () => {
  it('shapes the batch against itself, not against an empty neighbourhood', () => {
    // Three cells in a row, all present before any shape is computed, so the
    // middle one joins its neighbours rather than being written as isolated and
    // corrected afterwards.
    const placements: Placement[] = [
      { x: 1, y: 1, tileId: ground(STONE) },
      { x: 2, y: 1, tileId: ground(STONE) },
      { x: 3, y: 1, tileId: ground(STONE) },
    ];
    const result = applyPlacements(emptyGrid(6, 4, ground(GRASS)), placements);

    // the middle tile has stone on both sides, so it draws no left or right edge
    const middle = getAutotileShape(result.grid[1][2]);
    const left = getAutotileShape(result.grid[1][1]);
    expect(middle).not.toBe(SHAPE_ISOLATED);
    expect(left).not.toBe(SHAPE_ISOLATED);
    expect(getAutotileKind(result.grid[1][2])).toBe(STONE);
  });

  it('matches a full-layer refresh — the bounding box is scoping, not approximation', () => {
    const placements: Placement[] = [
      { x: 2, y: 2, tileId: ground(STONE) },
      { x: 3, y: 2, tileId: ground(STONE) },
      { x: 2, y: 3, tileId: ground(STONE) },
      { x: 7, y: 6, tileId: ground(STONE) },
      { x: 8, y: 6, tileId: makeAutotileId(WALL, 0) },
    ];

    const scoped = applyPlacements(emptyGrid(12, 10, ground(GRASS)), placements);
    const unscoped = applyPlacements(emptyGrid(12, 10, ground(GRASS)), placements, {
      computeShapes: false,
    });
    const full = refreshWallShapes(refreshAutotileShapes(unscoped.grid));

    expect(scoped.grid).toEqual(full);
  });

  it('runs both tables, so a batch spanning ground and walls comes out right', () => {
    const grid = emptyGrid(8, 8, ground(GRASS));
    const result = applyPlacements(grid, [
      { x: 2, y: 2, tileId: makeAutotileId(WALL, 0) },
      { x: 3, y: 2, tileId: makeAutotileId(WALL, 0) },
      { x: 5, y: 5, tileId: ground(STONE) },
    ]);

    // the two wall tiles join: neither draws an edge on the side they share
    expect(getAutotileShape(result.grid[2][2]) & 4).toBe(0);   // no right edge
    expect(getAutotileShape(result.grid[2][3]) & 1).toBe(0);   // no left edge
    // and the ground tile was shaped by the floor table, not left at shape 0
    expect(getAutotileKind(result.grid[5][5])).toBe(STONE);
    expect(getAutotileShape(result.grid[5][5])).toBe(SHAPE_ISOLATED);
  });

  it('leaves object tiles exactly as given', () => {
    const result = applyPlacements(emptyGrid(6, 6, ground(GRASS)), [
      { x: 2, y: 2, tileId: PROP },
      { x: 3, y: 2, tileId: PROP },
    ]);
    expect(result.grid[2][2]).toBe(PROP);
    expect(result.grid[2][3]).toBe(PROP);
  });

  it('writes raw autotile ids untouched when shape computation is off', () => {
    // The case this exists for: shapes worked out elsewhere and written verbatim.
    const handShaped = makeAutotileId(STONE, 12);
    const result = applyPlacements(emptyGrid(6, 6, ground(GRASS)), [
      { x: 2, y: 2, tileId: handShaped },
    ], { computeShapes: false });

    expect(result.grid[2][2]).toBe(handShaped);
    // with shapes on, the same call would recompute it against its neighbours
    const shaped = applyPlacements(emptyGrid(6, 6, ground(GRASS)), [
      { x: 2, y: 2, tileId: handShaped },
    ]);
    expect(getAutotileShape(shaped.grid[2][2])).toBe(SHAPE_ISOLATED);
  });

  it('fixes up the tiles already around the batch', () => {
    // An existing patch of stone; the batch extends it by one tile. The tile
    // that was on the patch edge has to lose the edge it was drawing.
    const grid = emptyGrid(8, 8, ground(GRASS));
    let seeded = applyPlacements(grid, [
      { x: 3, y: 3, tileId: ground(STONE) },
      { x: 4, y: 3, tileId: ground(STONE) },
      { x: 3, y: 4, tileId: ground(STONE) },
      { x: 4, y: 4, tileId: ground(STONE) },
    ]).grid;

    const before = getAutotileShape(seeded[3][4]);
    seeded = applyPlacements(seeded, [{ x: 5, y: 3, tileId: ground(STONE) }]).grid;
    const after = getAutotileShape(seeded[3][4]);

    expect(after).not.toBe(before);
    expect(getAutotileShape(seeded[3][4]) & 2).toBe(0); // no right-hand corner bit
  });

  it('reports no bounds and changes nothing for an all-out-of-bounds batch', () => {
    const grid = emptyGrid(4, 4, ground(GRASS));
    const result = applyPlacements(grid, [{ x: 9, y: 9, tileId: PROP }]);
    expect(result.bounds).toBeNull();
    expect(result.painted).toBe(0);
    expect(result.grid).toEqual(grid);
  });

  it('reports the bounding box of what it wrote', () => {
    const result = applyPlacements(emptyGrid(10, 10), [
      { x: 2, y: 3, tileId: PROP },
      { x: 6, y: 1, tileId: PROP },
      { x: 4, y: 8, tileId: PROP },
    ]);
    expect(result.bounds).toEqual({ x: 2, y: 1, width: 5, height: 8 });
  });
});

describe('equivalence with painting one tile at a time', () => {
  it('lands on the same grid as sequential single-tile calls', () => {
    // The whole justification for the tool: a batch is not a different answer,
    // it is the same answer in one write and one refresh. If this ever stopped
    // holding, replacing 440 calls with one would be a behaviour change rather
    // than an optimisation.
    const placements: Placement[] = [
      { x: 2, y: 2, tileId: ground(STONE) },
      { x: 3, y: 2, tileId: ground(STONE) },
      { x: 4, y: 2, tileId: ground(STONE) },
      { x: 4, y: 3, tileId: ground(STONE) },
      { x: 4, y: 4, tileId: ground(STONE) },
    ];

    const batched = applyPlacements(emptyGrid(10, 10, ground(GRASS)), placements).grid;

    let sequential = emptyGrid(10, 10, ground(GRASS));
    for (const placement of placements) {
      sequential = applyPlacements(sequential, [placement]).grid;
    }

    expect(batched).toEqual(sequential);
  });
});

describe('a full-map fill through the batch path', () => {
  it('leaves no edges drawn at the map border', () => {
    // Out-of-bounds neighbours count as the same material, matching the editor.
    const placements: Placement[] = [];
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) placements.push({ x, y, tileId: ground(GRASS) });
    }
    const result = applyPlacements(emptyGrid(5, 5), placements);
    for (const row of result.grid) {
      for (const tileId of row) expect(getAutotileShape(tileId)).toBe(SHAPE_FULL);
    }
  });
});
