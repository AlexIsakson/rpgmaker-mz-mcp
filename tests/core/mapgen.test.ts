import { describe, it, expect } from 'vitest';
import {
  makeRng,
  generateDungeon,
  generateCave,
  layoutToGrid,
  layoutStats,
  renderLayoutAscii,
  floodFill,
  growClump,
} from '../../src/core/mapgen.js';
import { getAutotileKind, getAutotileShape, SHAPE_FULL } from '../../src/core/autotile.js';

describe('makeRng', () => {
  it('is deterministic for a seed', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('differs between seeds', () => {
    expect(makeRng(1)()).not.toBe(makeRng(2)());
  });

  it('stays within [0, 1)', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 500; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('floodFill', () => {
  it('reaches only connected open cells', () => {
    const floor = [
      [true, true, false, true],
      [false, true, false, false],
      [true, true, false, true],
    ];

    const seen = floodFill(floor, 0, 0);
    expect(seen[0][0]).toBe(true);
    expect(seen[0][1]).toBe(true);
    expect(seen[2][1]).toBe(true);
    expect(seen[0][3]).toBe(false); // cut off by the solid column
    expect(seen[2][3]).toBe(false);
  });

  it('returns nothing when the start is solid', () => {
    const seen = floodFill([[false, false], [false, false]], 0, 0);
    expect(seen.flat().some(Boolean)).toBe(false);
  });
});

describe('generateDungeon', () => {
  it('is reproducible for a seed', () => {
    const a = generateDungeon({ width: 40, height: 30, seed: 123 });
    const b = generateDungeon({ width: 40, height: 30, seed: 123 });
    expect(a.floor).toEqual(b.floor);
    expect(a.rooms).toEqual(b.rooms);
  });

  it('produces different layouts for different seeds', () => {
    const a = generateDungeon({ width: 40, height: 30, seed: 1 });
    const b = generateDungeon({ width: 40, height: 30, seed: 2 });
    expect(a.floor).not.toEqual(b.floor);
  });

  it('matches the requested dimensions', () => {
    const layout = generateDungeon({ width: 35, height: 21, seed: 5 });
    expect(layout.height).toBe(21);
    expect(layout.floor).toHaveLength(21);
    expect(layout.floor[0]).toHaveLength(35);
  });

  it('leaves a solid margin so nothing runs off the map edge', () => {
    const layout = generateDungeon({ width: 30, height: 24, seed: 9 });
    const { floor, width, height } = layout;

    for (let x = 0; x < width; x++) {
      expect(floor[0][x]).toBe(false);
      expect(floor[height - 1][x]).toBe(false);
    }
    for (let y = 0; y < height; y++) {
      expect(floor[y][0]).toBe(false);
      expect(floor[y][width - 1]).toBe(false);
    }
  });

  it('never overlaps rooms', () => {
    const { rooms } = generateDungeon({ width: 50, height: 40, seed: 11, roomAttempts: 80 });
    expect(rooms.length).toBeGreaterThan(1);

    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i];
        const b = rooms[j];
        const overlaps =
          a.x < b.x + b.width && a.x + a.width > b.x &&
          a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('connects every open tile — the whole dungeon is walkable', () => {
    // The property that matters: corridors must actually join the rooms.
    for (const seed of [1, 2, 3, 7, 13, 42, 99]) {
      const layout = generateDungeon({ width: 45, height: 35, seed, roomAttempts: 60 });
      const stats = layoutStats(layout);
      expect(stats.openTiles).toBeGreaterThan(0);
      expect(stats.fullyConnected).toBe(true);
    }
  });

  it('carves rooms that are not all boxes', () => {
    // P5-10. `irregularRoomChance` defaults to 0.445 — the share of hand-made
    // *interior* room cores with a corner missing, 85 of 191, stated rather
    // than measured because the dungeon sample maps only offer whole floor
    // plans to measure and not single chambers.
    let shaped = 0;
    let boxes = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const layout = generateDungeon({
        width: 45, height: 35, seed, roomAttempts: 60, deadEndAttempts: 0,
      });
      for (const room of layout.rooms) {
        let filled = 0;
        for (let y = room.y; y < room.y + room.height; y++) {
          for (let x = room.x; x < room.x + room.width; x++) if (layout.floor[y][x]) filled++;
        }
        // A corridor can run through a room's bounding box and fill a cell the
        // shape took out, so only a shortfall proves a cut; a full box does not
        // prove the absence of one. Counting both directions is enough to show
        // the generator emits more than one shape.
        if (filled < room.width * room.height) shaped++;
        else boxes++;
      }
    }
    expect(shaped).toBeGreaterThan(0);
    expect(boxes).toBeGreaterThan(0);
    expect(shaped / (shaped + boxes)).toBeGreaterThan(0.2);
  });

  it('leaves every room a box when the chance is zero', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const layout = generateDungeon({
        width: 45, height: 35, seed, roomAttempts: 60,
        irregularRoomChance: 0, deadEndAttempts: 0,
      });
      for (const room of layout.rooms) {
        for (let y = room.y; y < room.y + room.height; y++) {
          for (let x = room.x; x < room.x + room.width; x++) {
            expect(layout.floor[y][x], `seed ${seed} at ${x},${y}`).toBe(true);
          }
        }
      }
    }
  });

  it('anchors a corridor on floor even when the room centre is rock', () => {
    // Corridors run between anchors, and a corridor ending on rock joins
    // nothing — which is how a shaped room could silently split a dungeon in
    // two. The connectivity sweep below is the property; this is the reason.
    for (let seed = 1; seed <= 60; seed++) {
      const layout = generateDungeon({ width: 45, height: 35, seed, roomAttempts: 60 });
      expect(layout.floor[layout.start.y][layout.start.x], `seed ${seed}`).toBe(true);
      expect(layoutStats(layout).fullyConnected, `seed ${seed}`).toBe(true);
    }
  });

  it('starts the player on an open tile', () => {
    for (const seed of [1, 5, 20]) {
      const layout = generateDungeon({ width: 40, height: 30, seed });
      expect(layout.floor[layout.start.y][layout.start.x]).toBe(true);
    }
  });

  it('produces more floor with more attempts', () => {
    const sparse = layoutStats(generateDungeon({ width: 60, height: 45, seed: 3, roomAttempts: 5 }));
    const dense = layoutStats(generateDungeon({ width: 60, height: 45, seed: 3, roomAttempts: 120 }));
    expect(dense.openTiles).toBeGreaterThan(sparse.openTiles);
  });

  it('survives a map too small for the requested rooms', () => {
    const layout = generateDungeon({ width: 6, height: 6, seed: 4, minRoomSize: 3, maxRoomSize: 20 });
    expect(layout.floor).toHaveLength(6);
    expect(layoutStats(layout).fullyConnected).toBe(true);
  });
});

describe('generateCave', () => {
  it('is reproducible for a seed', () => {
    const a = generateCave({ width: 40, height: 30, seed: 77 });
    const b = generateCave({ width: 40, height: 30, seed: 77 });
    expect(a.floor).toEqual(b.floor);
  });

  it('keeps a solid border', () => {
    const { floor, width, height } = generateCave({ width: 30, height: 24, seed: 8 });
    for (let x = 0; x < width; x++) {
      expect(floor[0][x]).toBe(false);
      expect(floor[height - 1][x]).toBe(false);
    }
  });

  it('leaves no sealed-off pockets', () => {
    // The whole point of keeping only the largest region.
    for (const seed of [1, 2, 3, 21, 55]) {
      const layout = generateCave({ width: 50, height: 38, seed });
      const stats = layoutStats(layout);
      if (stats.openTiles > 0) {
        expect(stats.fullyConnected).toBe(true);
      }
    }
  });

  it('opens up more space with a lower fill probability', () => {
    const tight = layoutStats(generateCave({ width: 50, height: 40, seed: 6, fillProbability: 0.6 }));
    const open = layoutStats(generateCave({ width: 50, height: 40, seed: 6, fillProbability: 0.35 }));
    expect(open.openTiles).toBeGreaterThan(tight.openTiles);
  });

  it('starts the player on an open tile when there is any', () => {
    const layout = generateCave({ width: 40, height: 30, seed: 12 });
    expect(layout.floor[layout.start.y][layout.start.x]).toBe(true);
  });
});

describe('layoutToGrid', () => {
  it('maps floor and surround to the requested materials', () => {
    const layout = generateDungeon({ width: 30, height: 24, seed: 3 });
    const grid = layoutToGrid(layout, 18, 16);

    for (let y = 0; y < layout.height; y++) {
      for (let x = 0; x < layout.width; x++) {
        expect(getAutotileKind(grid[y][x])).toBe(layout.floor[y][x] ? 18 : 16);
      }
    }
  });

  it('computes shapes rather than leaving everything at shape 0', () => {
    const layout = generateDungeon({ width: 30, height: 24, seed: 3 });
    const grid = layoutToGrid(layout, 18, 16);
    const shapes = new Set(grid.flat().map(getAutotileShape));

    expect(shapes.size).toBeGreaterThan(1);
    expect(shapes.has(SHAPE_FULL)).toBe(true);
  });

  it('gives an interior floor tile the full centre shape', () => {
    const layout = generateDungeon({ width: 40, height: 30, seed: 2, roomAttempts: 60 });
    const grid = layoutToGrid(layout, 18, 16);

    // Find a floor tile whose eight neighbours are all floor.
    let found = false;
    for (let y = 1; y < layout.height - 1 && !found; y++) {
      for (let x = 1; x < layout.width - 1 && !found; x++) {
        const surrounded =
          layout.floor[y][x] &&
          layout.floor[y - 1][x] && layout.floor[y + 1][x] &&
          layout.floor[y][x - 1] && layout.floor[y][x + 1] &&
          layout.floor[y - 1][x - 1] && layout.floor[y - 1][x + 1] &&
          layout.floor[y + 1][x - 1] && layout.floor[y + 1][x + 1];
        if (surrounded) {
          expect(getAutotileShape(grid[y][x])).toBe(SHAPE_FULL);
          found = true;
        }
      }
    }
    expect(found).toBe(true);
  });
});

describe('renderLayoutAscii', () => {
  it('draws open, solid, and the start marker', () => {
    const layout = generateDungeon({ width: 20, height: 12, seed: 3 });
    const text = renderLayoutAscii(layout);
    const lines = text.split('\n');

    expect(lines).toHaveLength(12);
    expect(lines[0]).toHaveLength(20);
    expect(text).toContain('@');
    expect(text).toContain('#');
    expect(text).toContain('.');
    expect(lines[layout.start.y][layout.start.x]).toBe('@');
  });
});

/**
 * Shape metrics, measured the same way as over the 55 dungeon-tileset maps that
 * ship with the editor. Connectivity was always asserted here, but a fully
 * connected map can still be a featureless blob — which is exactly what a visual
 * review found. These turn that complaint into something a test can hold.
 */
function shapeMetrics(layout: { width: number; height: number; floor: boolean[][] }) {
  const { width: w, height: h, floor } = layout;
  const neighbours = (x: number, y: number) =>
    [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(
      ([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h && floor[y + dy][x + dx]
    ).length;

  let floorTiles = 0;
  let edgeTiles = 0;
  let deadEnds = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!floor[y][x]) continue;
      floorTiles++;
      const n = neighbours(x, y);
      if (n < 4) edgeTiles++;
      if (n === 1) deadEnds++;
    }
  }

  // solid regions that never touch the map border — pillars, interior structure
  const seen = Array.from({ length: h }, () => new Array<boolean>(w).fill(false));
  let islands = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (floor[y][x] || seen[y][x]) continue;
      const stack = [[x, y]];
      seen[y][x] = true;
      let touchesBorder = false;
      while (stack.length > 0) {
        const [cx, cy] = stack.pop()!;
        if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) touchesBorder = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny][nx] || floor[ny][nx]) continue;
          seen[ny][nx] = true;
          stack.push([nx, ny]);
        }
      }
      if (!touchesBorder) islands++;
    }
  }

  return {
    floorFraction: floorTiles / (w * h),
    edgeDensity: floorTiles === 0 ? 0 : edgeTiles / floorTiles,
    deadEndsPer100: floorTiles === 0 ? 0 : (deadEnds / floorTiles) * 100,
    islands,
  };
}

const median = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Same regions `shapeMetrics` counts, but their tile counts rather than a total. */
function islandSizes(floor: boolean[][]): number[] {
  const h = floor.length;
  const w = floor[0]?.length ?? 0;
  const seen = Array.from({ length: h }, () => new Array<boolean>(w).fill(false));
  const sizes: number[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (floor[y][x] || seen[y][x]) continue;
      const stack = [[x, y]];
      seen[y][x] = true;
      let touchesBorder = false;
      let size = 0;
      while (stack.length > 0) {
        const [cx, cy] = stack.pop()!;
        size++;
        if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) touchesBorder = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny][nx] || floor[ny][nx]) continue;
          seen[ny][nx] = true;
          stack.push([nx, ny]);
        }
      }
      if (!touchesBorder) sizes.push(size);
    }
  }
  return sizes;
}

describe('layout shape, against the hand-made maps', () => {
  const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

  /**
   * Ranges taken from the 55 dungeon-tileset sample maps: p10..p90 of each
   * metric. Deliberately the *observed range*, not a tight band — the point is
   * to catch a regression to a blob, not to pin an aesthetic.
   */
  const HANDMADE = {
    floorFraction: [0.13, 0.80],
    edgeDensity: [0.452, 0.800],
    islands: [0, 21],
  };

  it('gives a cave walls to follow rather than one open blob', () => {
    // Before this was tuned: edge density 0.154, against a hand-made floor of
    // 0.452. That single number is what "one large open blob" meant.
    const rows = SEEDS.map((seed) => shapeMetrics(generateCave({ width: 40, height: 30, seed })));
    const edge = median(rows.map((r) => r.edgeDensity));
    expect(edge).toBeGreaterThanOrEqual(HANDMADE.edgeDensity[0]);
    expect(edge).toBeLessThanOrEqual(HANDMADE.edgeDensity[1]);
  });

  it('gives a cave something to walk around', () => {
    const islands = median(SEEDS.map((seed) =>
      shapeMetrics(generateCave({ width: 40, height: 30, seed })).islands));
    expect(islands).toBeGreaterThan(2);   // it used to be 2
    expect(islands).toBeLessThanOrEqual(HANDMADE.islands[1]);
  });

  it('leaves a cave hollow when the pillars are turned off', () => {
    const withPillars = median(SEEDS.map((seed) =>
      shapeMetrics(generateCave({ width: 40, height: 30, seed })).islands));
    const without = median(SEEDS.map((seed) =>
      shapeMetrics(generateCave({ width: 40, height: 30, seed, pillarDensity: 0 })).islands));
    expect(without).toBeLessThan(withPillars);
  });

  it('cuts dead ends into a dungeon', () => {
    // This was exactly 0.000 across every seed: every passage arrived somewhere.
    const deadEnds = median(SEEDS.map((seed) =>
      shapeMetrics(generateDungeon({ width: 40, height: 30, seed })).deadEndsPer100));
    expect(deadEnds).toBeGreaterThan(2);
    expect(deadEnds).toBeLessThanOrEqual(9.04);   // the hand-made p90
  });

  it('makes every passage arrive somewhere when dead ends are turned off', () => {
    const deadEnds = median(SEEDS.map((seed) =>
      shapeMetrics(generateDungeon({ width: 40, height: 30, seed, deadEndAttempts: 0 })).deadEndsPer100));
    expect(deadEnds).toBe(0);
  });

  it('keeps both styles inside the hand-made range for floor and edges', () => {
    for (const [label, generate] of [
      ['cave', (seed: number) => generateCave({ width: 40, height: 30, seed })],
      ['dungeon', (seed: number) => generateDungeon({ width: 40, height: 30, seed })],
    ] as const) {
      const rows = SEEDS.map((seed) => shapeMetrics(generate(seed)));
      const floor = median(rows.map((r) => r.floorFraction));
      const edge = median(rows.map((r) => r.edgeDensity));
      expect(floor, `${label} floor fraction`).toBeGreaterThanOrEqual(HANDMADE.floorFraction[0]);
      expect(floor, `${label} floor fraction`).toBeLessThanOrEqual(HANDMADE.floorFraction[1]);
      expect(edge, `${label} edge density`).toBeGreaterThanOrEqual(HANDMADE.edgeDensity[0]);
      expect(edge, `${label} edge density`).toBeLessThanOrEqual(HANDMADE.edgeDensity[1]);
    }
  });

  it('stays fully connected through all of it, across many seeds', () => {
    // The property that was already guaranteed, re-asserted because dead ends,
    // irregular rooms and pillars all touch the floor mask after it is built.
    for (const seed of Array.from({ length: 60 }, (_, i) => i + 1)) {
      expect(layoutStats(generateCave({ width: 40, height: 30, seed })).fullyConnected,
        `cave seed ${seed}`).toBe(true);
      expect(layoutStats(generateDungeon({ width: 40, height: 30, seed })).fullyConnected,
        `dungeon seed ${seed}`).toBe(true);
    }
  });

  it('still reproduces a layout exactly from its seed', () => {
    expect(generateCave({ width: 30, height: 20, seed: 12 }))
      .toEqual(generateCave({ width: 30, height: 20, seed: 12 }));
    expect(generateDungeon({ width: 30, height: 20, seed: 12 }))
      .toEqual(generateDungeon({ width: 30, height: 20, seed: 12 }));
  });

  describe('pillars in clumps', () => {
    // scripts/measure-cave-islands.mjs, over the 55 dungeon-tileset sample
    // maps: of 271 hand-made interior islands sized 1-4, 210 (77.5%) are a
    // single tile and 61 (22.5%) are 2-4 — the corpus this is measured
    // against, cited on CaveOptions.pillarClumpChance.

    it('produces some multi-tile islands, not only single-tile studs', () => {
      const sizes = SEEDS.flatMap((seed) =>
        islandSizes(generateCave({ width: 40, height: 30, seed }).floor));
      expect(sizes.some((s) => s > 1)).toBe(true);
      // still mostly single tiles — clumping is the minority case by design
      expect(sizes.some((s) => s === 1)).toBe(true);
    });

    it('grows fewer multi-tile islands when clumping is turned off', () => {
      // Not "every island is size 1": two single-tile pillars can still land
      // next to each other by chance and flood-fill together, on or off. What
      // the flag controls is *intentional* growth, so the single-tile share
      // should rise when it is disabled, not hit 100% — measured at 58.4%
      // (default) against 73.4% (off) over the same 30 seeds.
      const fractionSingle = (sizes: number[]) => sizes.filter((s) => s === 1).length / sizes.length;
      const on = fractionSingle(SEEDS.flatMap((seed) =>
        islandSizes(generateCave({ width: 40, height: 30, seed }).floor)));
      const off = fractionSingle(SEEDS.flatMap((seed) =>
        islandSizes(generateCave({ width: 40, height: 30, seed, pillarClumpChance: 0 }).floor)));
      expect(off).toBeGreaterThan(on);
    });

    it('stays fully connected under maximum clump pressure', () => {
      // pillarClumpChance 1 forces every accepted pillar to attempt a 2-4
      // tile clump rather than a single tile, and pillarDensity near its max
      // pushes as many attempts as possible through the neck of the cave —
      // the configuration most likely to expose a clump that was tested
      // tile-by-tile instead of as one unit, the exact bug the task named.
      for (const seed of Array.from({ length: 40 }, (_, i) => i + 1)) {
        const stats = layoutStats(generateCave({
          width: 40, height: 30, seed, pillarDensity: 0.2, pillarClumpChance: 1,
        }));
        expect(stats.fullyConnected, `seed ${seed}`).toBe(true);
      }
    });
  });
});

describe('growClump', () => {
  it('always includes the seed, and only eligible cells', () => {
    const eligible = new Set(['1,1', '2,1', '1,2', '0,1']);
    const isEligible = (x: number, y: number) => eligible.has(`${x},${y}`);
    const clump = growClump({ x: 1, y: 1 }, 10, isEligible, makeRng(1));
    expect(clump).toContainEqual({ x: 1, y: 1 });
    for (const c of clump) expect(isEligible(c.x, c.y)).toBe(true);
  });

  it('returns nothing for an ineligible seed', () => {
    expect(growClump({ x: 0, y: 0 }, 3, () => false, makeRng(1))).toEqual([]);
  });

  it('never exceeds the requested size', () => {
    const clump = growClump({ x: 5, y: 5 }, 4, () => true, makeRng(3));
    expect(clump.length).toBe(4);
  });

  it('stops rather than looping forever when the frontier runs dry', () => {
    // A single isolated eligible cell: nothing to grow into.
    const isEligible = (x: number, y: number) => x === 0 && y === 0;
    expect(growClump({ x: 0, y: 0 }, 10, isEligible, makeRng(1))).toEqual([{ x: 0, y: 0 }]);
  });

  it('never revisits a cell in a tight space reachable two ways', () => {
    // A 2-wide, 3-tall pocket: once both cells of a row are chosen, the next
    // row's cells are each reachable from two different chosen neighbours —
    // exactly the case where forgetting to dedupe the frontier would add one
    // cell twice and grow past `size`.
    const isEligible = (x: number, y: number) => x >= 0 && x < 2 && y >= 0 && y < 3;
    const clump = growClump({ x: 0, y: 0 }, 6, isEligible, makeRng(2));
    const keys = clump.map((c) => `${c.x},${c.y}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(clump.length).toBe(6); // the whole 2x3 pocket
  });

  it('produces a 4-connected shape', () => {
    const clump = growClump({ x: 0, y: 0 }, 5, () => true, makeRng(9));
    const keys = new Set(clump.map((c) => `${c.x},${c.y}`));
    for (const c of clump) {
      if (c.x === 0 && c.y === 0) continue;
      const hasNeighbour = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
        .some(([dx, dy]) => keys.has(`${c.x + dx},${c.y + dy}`));
      expect(hasNeighbour).toBe(true);
    }
  });

  it('is deterministic for a seeded rng', () => {
    const a = growClump({ x: 0, y: 0 }, 6, () => true, makeRng(4));
    const b = growClump({ x: 0, y: 0 }, 6, () => true, makeRng(4));
    expect(a).toEqual(b);
  });
});
