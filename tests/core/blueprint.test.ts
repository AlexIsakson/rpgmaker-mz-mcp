import { describe, it, expect } from 'vitest';
import {
  sheetColumn,
  sheetRow,
  nineSliceTileId,
  nineSliceFits,
  nineSliceGrid,
  planBuilding,
  doorEventPage,
  doorEvent,
  pairedWallKind,
  isA3RoofKind,
  isA3WallKind,
  findRoofSet,
  BlueprintError,
  OUTSIDE_C_ROOF_SETS,
  type BuildingSpec,
} from '../../src/core/blueprint.js';

/**
 * Tilemap._addNormalTile, copied from the corescript (rmmz_core.js v1.9.0).
 * Where a tile is drawn from is the ground truth for how the object sheets are
 * addressed, so the nine-slice arithmetic is checked against this rather than
 * against a restatement of itself.
 */
const TILE_SIZE = 48;
function corescriptSource(tileId: number): { sx: number; sy: number } {
  return {
    sx: ((Math.floor(tileId / 128) % 2) * 8 + (tileId % 8)) * TILE_SIZE,
    sy: (Math.floor((tileId % 256) / 8) % 16) * TILE_SIZE,
  };
}

describe('object sheet geometry', () => {
  it('matches the corescript for every B/C/D/E tile', () => {
    for (let tileId = 0; tileId < 1024; tileId++) {
      const { sx, sy } = corescriptSource(tileId);
      expect(sheetColumn(tileId) * TILE_SIZE).toBe(sx);
      expect(sheetRow(tileId) * TILE_SIZE).toBe(sy);
    }
  });

  it('addresses a nine-slice block as a contiguous 3x3 of source tiles', () => {
    for (const set of OUTSIDE_C_ROOF_SETS) {
      const origin = corescriptSource(set.topLeft);
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const { sx, sy } = corescriptSource(nineSliceTileId(set.topLeft, col, row));
          expect(sx).toBe(origin.sx + col * TILE_SIZE);
          expect(sy).toBe(origin.sy + row * TILE_SIZE);
        }
      }
    }
  });

  it('rejects a block that would wrap to the other half of the sheet', () => {
    // The sheets are 16 wide but addressed as two 8-wide halves, so a block
    // starting in column 6 or 7 of a half runs off it.
    for (let tileId = 0; tileId < 1024; tileId++) {
      const col = sheetColumn(tileId) % 8;
      if (col > 5) expect(nineSliceFits(tileId)).toBe(false);
    }
    expect(nineSliceFits(384)).toBe(true);   // Outside_C green roof, column 8
    expect(nineSliceFits(390)).toBe(false);  // column 14 — two columns left
    expect(nineSliceFits(496)).toBe(false);  // row 14 — two rows left
  });
});

describe('nineSliceGrid', () => {
  it('lays a 3x3 set out cell for cell', () => {
    expect(nineSliceGrid(384, 3, 3)).toEqual([
      [384, 385, 386],
      [392, 393, 394],
      [400, 401, 402],
    ]);
  });

  it('repeats the middle for a larger roof, keeping the slopes and eave at the rim', () => {
    const grid = nineSliceGrid(384, 5, 4);
    expect(grid[0]).toEqual([384, 385, 385, 385, 386]);   // ridge
    expect(grid[1]).toEqual([392, 393, 393, 393, 394]);   // body
    expect(grid[2]).toEqual([392, 393, 393, 393, 394]);   // body repeats
    expect(grid[3]).toEqual([400, 401, 401, 401, 402]);   // eave
  });

  it('uses only the corners at the minimum 2x2', () => {
    expect(nineSliceGrid(384, 2, 2)).toEqual([
      [384, 386],
      [400, 402],
    ]);
  });
});

describe('A3 roof and wall rows', () => {
  it('alternates roof row and wall row down the sheet', () => {
    // Block rows 0 and 2 are roofs, 1 and 3 are walls.
    for (const kind of [48, 55, 64, 71]) {
      expect(isA3RoofKind(kind)).toBe(true);
      expect(isA3WallKind(kind)).toBe(false);
    }
    for (const kind of [56, 63, 72, 79]) {
      expect(isA3WallKind(kind)).toBe(true);
      expect(isA3RoofKind(kind)).toBe(false);
    }
  });

  it('pairs each roof with the wall one block row below it', () => {
    // The pairings counted in the shipped sample maps.
    expect(pairedWallKind(49)).toBe(57);
    expect(pairedWallKind(52)).toBe(60);
    expect(pairedWallKind(67)).toBe(75);
    expect(pairedWallKind(50)).toBe(58);
    for (const kind of [48, 49, 55, 64, 71]) {
      expect(isA3WallKind(pairedWallKind(kind))).toBe(true);
    }
  });
});

function spec(overrides: Partial<BuildingSpec> = {}): BuildingSpec {
  return {
    x: 4,
    y: 3,
    width: 4,
    height: 5,
    wallHeight: 2,
    wallKind: 57,
    roof: { style: 'nineslice', topLeft: 384 },
    doorOffsetX: 2,
    ...overrides,
  };
}

describe('planBuilding', () => {
  it('splits the footprint into roof on top and wall along the bottom', () => {
    const plan = planBuilding(spec());
    expect(plan.roofRect).toEqual({ x: 4, y: 3, width: 4, height: 3 });
    expect(plan.wallRect).toEqual({ x: 4, y: 6, width: 4, height: 2 });
    // The two rects tile the footprint exactly, with no gap and no overlap.
    expect(plan.roofRect.y + plan.roofRect.height).toBe(plan.wallRect.y);
    expect(plan.wallRect.y + plan.wallRect.height).toBe(3 + 5);
  });

  it('puts the door on the bottom wall row, approached from below', () => {
    const plan = planBuilding(spec());
    expect(plan.door).toEqual({ x: 6, y: 7, approach: { x: 6, y: 8 }, side: 'bottom' });
  });

  it('defaults to the bottom edge, which is what 88 of 88 sample doors use', () => {
    expect(planBuilding(spec()).door).toEqual(planBuilding(spec({ doorSide: 'bottom' })).door);
    expect(planBuilding(spec()).wallRect).toEqual(planBuilding(spec({ doorSide: 'bottom' })).wallRect);
  });

  describe('doorSide: top', () => {
    it('moves the wall band to the top and the roof below it', () => {
      const plan = planBuilding(spec({ doorSide: 'top' }));
      expect(plan.wallRect).toEqual({ x: 4, y: 3, width: 4, height: 2 });
      expect(plan.roofRect).toEqual({ x: 4, y: 5, width: 4, height: 3 });
      // Still tiles the footprint exactly, with no gap and no overlap.
      expect(plan.wallRect.y + plan.wallRect.height).toBe(plan.roofRect.y);
      expect(plan.roofRect.y + plan.roofRect.height).toBe(3 + 5);
    });

    it('puts the door on the top row, approached from above', () => {
      const plan = planBuilding(spec({ doorSide: 'top' }));
      expect(plan.door).toEqual({ x: 6, y: 3, approach: { x: 6, y: 2 }, side: 'top' });
    });

    it('keeps the door standing on wall, never on roof', () => {
      // The whole reason the wall band moves: a door sprite drawn over roof art
      // is a door painted on a roof.
      for (const doorSide of ['bottom', 'top'] as const) {
        for (const height of [4, 5, 6, 7]) {
          for (const wallHeight of [1, 2]) {
            const plan = planBuilding(spec({ doorSide, height, wallHeight }));
            const { y } = plan.door!;
            expect(y).toBeGreaterThanOrEqual(plan.wallRect.y);
            expect(y).toBeLessThan(plan.wallRect.y + plan.wallRect.height);
          }
        }
      }
    });

    it('puts the approach outside the footprint on both sides', () => {
      for (const doorSide of ['bottom', 'top'] as const) {
        const plan = planBuilding(spec({ doorSide }));
        const { approach } = plan.door!;
        expect(approach.y < 3 || approach.y >= 3 + 5).toBe(true);
        expect(approach.x).toBe(plan.door!.x);
        // Exactly one tile away, so the player steps straight in.
        expect(Math.abs(approach.y - plan.door!.y)).toBe(1);
      }
    });

    it('still refuses a door outside the footprint', () => {
      expect(() => planBuilding(spec({ doorSide: 'top', doorOffsetX: 4 }))).toThrow(BlueprintError);
    });

    it('warns about a mismatched roof/wall pairing the same way', () => {
      const plan = planBuilding(
        spec({ doorSide: 'top', roof: { style: 'autotile', kind: 49 }, wallKind: 58 })
      );
      expect(plan.warnings.join(' ')).toMatch(/usually paired with wall kind 57/);
    });
  });

  it('omits the door when asked to', () => {
    expect(planBuilding(spec({ doorOffsetX: null })).door).toBeNull();
  });

  it('refuses a footprint with no room for a roof', () => {
    expect(() => planBuilding(spec({ height: 2, wallHeight: 2 }))).toThrow(BlueprintError);
    expect(() => planBuilding(spec({ height: 2, wallHeight: 3 }))).toThrow(/no room for a roof/);
  });

  it('refuses a nine-slice roof smaller than 2x2', () => {
    expect(() => planBuilding(spec({ width: 1 }))).toThrow(/at least 2x2/);
    // height 3 with 2 rows of wall leaves a single roof row
    expect(() => planBuilding(spec({ height: 3 }))).toThrow(/at least 2x2/);
  });

  it('refuses a door outside the footprint', () => {
    expect(() => planBuilding(spec({ doorOffsetX: 4 }))).toThrow(BlueprintError);
  });

  it('accepts an A3 roof at any size and paints it on the ground layer', () => {
    const plan = planBuilding(
      spec({
        roof: { style: 'autotile', kind: 49 },
        width: 1,
        height: 2,
        wallHeight: 1,
        doorOffsetX: 0,
      })
    );
    expect(plan.roofTiles).toBeNull();
    expect(plan.roofTileId).toBe(2048 + 49 * 48);
    expect(plan.warnings).toEqual([]);
  });

  it('warns when the A3 roof and wall are not the +8 pair', () => {
    const plan = planBuilding(spec({ roof: { style: 'autotile', kind: 49 }, wallKind: 60 }));
    expect(plan.warnings.join(' ')).toMatch(/usually paired with wall kind 57/);
  });

  it('warns when a wall kind is really a roof row', () => {
    const plan = planBuilding(spec({ wallKind: 52 }));
    expect(plan.warnings.join(' ')).toMatch(/roof row of the sheet/);
  });

  it('says nothing when the pairing is right', () => {
    const plan = planBuilding(spec({ roof: { style: 'autotile', kind: 52 }, wallKind: 60 }));
    expect(plan.warnings).toEqual([]);
  });
});

describe('doorEventPage', () => {
  /**
   * The exact command sequence of the door pages that ship with the editor —
   * 60 of the 107 sample door pages are this, more than any other shape.
   */
  const SAMPLE_DOOR_CODES = [250, 205, 505, 505, 505, 505, 505, 505, 205, 505, 250, 201, 0];

  it('matches the sample maps command for command', () => {
    const page = doorEventPage({ target: { mapId: 5, x: 5, y: 11 } });
    expect(page.list.map((c) => c.code)).toEqual(SAMPLE_DOOR_CODES);
  });

  it('mirrors every route step as a 505 line except the end marker', () => {
    const page = doorEventPage({ target: { mapId: 2, x: 1, y: 1 } });
    const routes = page.list.filter((c) => c.code === 205);
    expect(routes).toHaveLength(2);

    for (const route of routes) {
      const index = page.list.indexOf(route);
      const steps = (route.parameters[1] as { list: { code: number }[] }).list;
      const mirrored = page.list
        .slice(index + 1)
        .filter((c, i, all) => all.slice(0, i + 1).every((x) => x.code === 505))
        .map((c) => (c.parameters[0] as { code: number }).code);

      // the route's own list carries a trailing end marker that is not mirrored
      expect(steps[steps.length - 1].code).toBe(0);
      expect(mirrored).toEqual(steps.slice(0, -1).map((s) => s.code));
    }
  });

  it('drops the transfer when the door has nowhere to go', () => {
    const page = doorEventPage();
    expect(page.list.map((c) => c.code)).not.toContain(201);
    expect(page.list.map((c) => c.code)).toEqual([250, 205, 505, 505, 505, 505, 505, 505, 205, 505, 0]);
  });

  it('carries the transfer destination', () => {
    const page = doorEventPage({ target: { mapId: 7, x: 12, y: 9 } });
    const transfer = page.list.find((c) => c.code === 201)!;
    // [designation, mapId, x, y, direction (0 = retain), fade (0 = black)]
    expect(transfer.parameters).toEqual([0, 7, 12, 9, 0, 0]);
  });

  it('uses the sprite and page settings the sample doors use', () => {
    const page = doorEventPage({ characterName: '!Door2', characterIndex: 4 });
    expect(page.image).toEqual({
      characterIndex: 4,
      characterName: '!Door2',
      direction: 2,
      pattern: 1,
      tileId: 0,
    });
    expect(page.trigger).toBe(1);        // player touch
    expect(page.priorityType).toBe(1);   // same as characters
    expect(page.walkAnime).toBe(false);
    expect(page.through).toBe(false);
  });

  it('animates by turning, because a door sprite stores its frames as directions', () => {
    const steps = (doorEventPage().list.find((c) => c.code === 205)!
      .parameters[1] as { list: { code: number }[] }).list;
    // turn left, wait, turn right, wait, turn up, through on, end
    expect(steps.map((s) => s.code)).toEqual([17, 15, 18, 15, 19, 37, 0]);
  });
});

describe('doorEvent', () => {
  it('places one page at the given tile', () => {
    const event = doorEvent(3, 10, 7);
    expect(event.id).toBe(3);
    expect(event.x).toBe(10);
    expect(event.y).toBe(7);
    expect(event.pages).toHaveLength(1);
  });
});

describe('roof set catalogue', () => {
  it('resolves by name', () => {
    expect(findRoofSet('green')!.topLeft).toBe(384);
    expect(findRoofSet('white')!.topLeft).toBe(389);
    expect(findRoofSet('gold')!.topLeft).toBe(408);
    expect(findRoofSet('brown')!.topLeft).toBe(413);
    expect(findRoofSet('teal')).toBeUndefined();
  });

  it('has sets that all fit on the sheet', () => {
    for (const set of OUTSIDE_C_ROOF_SETS) {
      expect(nineSliceFits(set.topLeft)).toBe(true);
    }
  });
});
