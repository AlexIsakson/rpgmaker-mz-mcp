import { describe, it, expect } from 'vitest';
import {
  makeRng,
  generateDungeon,
  generateCave,
  layoutToGrid,
  layoutStats,
  renderLayoutAscii,
  floodFill,
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
