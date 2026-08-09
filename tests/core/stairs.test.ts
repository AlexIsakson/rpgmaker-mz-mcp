import { describe, it, expect } from 'vitest';
import {
  transferEventPage,
  stairEvent,
  transferTargetOf,
  planStairEnds,
  StairError,
  STAIR_SE,
} from '../../src/core/stairs.js';
import { exitEventPage } from '../../src/core/interiorgen.js';
import { generateDungeon, generateCave, floodFill } from '../../src/core/mapgen.js';

/** Parse `#`/`.` art into a floor mask, so a test layout reads as what it is. */
function mask(art: string): boolean[][] {
  return art
    .trim()
    .split('\n')
    .map((line) => [...line.trim()].map((c) => c === '.'));
}

/** Longest shortest path between any two open tiles — the true diameter. */
function bruteForceDiameter(floor: boolean[][]): number {
  const height = floor.length;
  const width = floor[0].length;
  let best = 0;
  for (let sy = 0; sy < height; sy++) {
    for (let sx = 0; sx < width; sx++) {
      if (!floor[sy][sx]) continue;
      const dist = Array.from({ length: height }, () => new Array<number>(width).fill(-1));
      dist[sy][sx] = 0;
      const queue = [[sx, sy]];
      for (let head = 0; head < queue.length; head++) {
        const [x, y] = queue[head];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (!floor[ny][nx] || dist[ny][nx] !== -1) continue;
          dist[ny][nx] = dist[y][x] + 1;
          queue.push([nx, ny]);
        }
      }
      for (const row of dist) for (const d of row) if (d > best) best = d;
    }
  }
  return best;
}

describe('transferEventPage', () => {
  it('is the page all 157 shipped stair events use', () => {
    const page = transferEventPage({ mapId: 4, x: 7, y: 9 });

    expect(page.trigger).toBe(1);              // player touch, 157/157
    expect(page.priorityType).toBe(0);         // below characters, 157/157
    expect(page.image.characterName).toBe(''); // invisible, 157/157
    expect(page.through).toBe(false);          // 157/157
    expect(page.list.map((c) => c.code)).toEqual([250, 201, 0]);
  });

  it('plays Move1, the SE all 157 of them play', () => {
    const [se] = transferEventPage({ mapId: 1, x: 1, y: 1 }).list;
    expect(se.parameters[0]).toMatchObject({ name: STAIR_SE, volume: 90, pitch: 100, pan: 0 });
  });

  it('transfers direct, to a black fade', () => {
    const page = transferEventPage({ mapId: 12, x: 3, y: 4 });
    const transfer = page.list.find((c) => c.code === 201)!;
    // [designation, mapId, x, y, direction, fade]
    expect(transfer.parameters).toEqual([0, 12, 3, 4, 0, 0]);
  });

  it('retains facing by default, and takes one when given', () => {
    const kept = transferEventPage({ mapId: 1, x: 0, y: 0 });
    expect((kept.list.find((c) => c.code === 201)!.parameters as number[])[4]).toBe(0);

    const faced = transferEventPage({ mapId: 1, x: 0, y: 0, direction: 8 });
    expect((faced.list.find((c) => c.code === 201)!.parameters as number[])[4]).toBe(8);
  });

  it('blocks nothing, which is what makes placement unconstrained', () => {
    // A chest is priorityType 1 and has to go in a dead end so it cannot seal a
    // corridor. Priority 0 is why a stair carries no such argument.
    expect(transferEventPage({ mapId: 1, x: 0, y: 0 }).priorityType).toBe(0);
  });

  it('is the same page an interior exit uses — the two were measured separately', () => {
    const target = { mapId: 9, x: 5, y: 6 };
    expect(exitEventPage(target)).toEqual(transferEventPage(target));
  });
});

describe('stairEvent', () => {
  it('makes a one-page event where it was asked for', () => {
    const event = stairEvent(3, 10, 12, { mapId: 2, x: 1, y: 1 });
    expect(event).toMatchObject({ id: 3, x: 10, y: 12 });
    expect(event.pages).toHaveLength(1);
  });

  it('takes a name, so the editor shows what it is', () => {
    expect(stairEvent(1, 0, 0, { mapId: 2, x: 0, y: 0 }, 'StairsDown').name).toBe('StairsDown');
  });
});

describe('transferTargetOf', () => {
  it('reads a destination back', () => {
    const page = transferEventPage({ mapId: 7, x: 2, y: 3, direction: 4 });
    expect(transferTargetOf(page)).toEqual({ mapId: 7, x: 2, y: 3, direction: 4 });
  });

  it('reports nothing for a variable-driven transfer, rather than a bogus map id', () => {
    const page = transferEventPage({ mapId: 7, x: 2, y: 3 });
    const transfer = page.list.find((c) => c.code === 201)!;
    transfer.parameters = [1, 11, 12, 13, 0, 0]; // designation 1 = from variables
    expect(transferTargetOf(page)).toBeNull();
  });

  it('reports nothing for a page that does not transfer', () => {
    expect(transferTargetOf({ ...transferEventPage({ mapId: 1, x: 0, y: 0 }), list: [] })).toBeNull();
  });
});

describe('planStairEnds', () => {
  it('puts the two ends at the tips of a corridor', () => {
    const floor = mask(`
      #######
      #.....#
      #######
    `);
    const ends = planStairEnds(floor);
    expect(ends.distance).toBe(4);
    expect([ends.entrance, ends.exit].map((s) => s.x).sort()).toEqual([1, 5]);
    expect(ends.entrance.y).toBe(1);
    expect(ends.exit.y).toBe(1);
  });

  it('measures the walk, not the crow flight', () => {
    // The two open tiles at 1,1 and 3,1 are two apart on screen and a long way
    // round the U. Picking by straight-line distance would put both stairs in
    // the same corner of the map.
    const floor = mask(`
      #####
      #.#.#
      #.#.#
      #...#
      #####
    `);
    const ends = planStairEnds(floor);
    expect(ends.distance).toBe(6);
    expect(new Set([`${ends.entrance.x},${ends.entrance.y}`, `${ends.exit.x},${ends.exit.y}`]))
      .toEqual(new Set(['1,1', '3,1']));
  });

  it('makes the end nearer the map border the way in', () => {
    // A corridor from the map edge inwards: 1,1 is one tile from the left edge,
    // 4,4 is four from every edge. The player comes in from outside, so the
    // stair at the edge is the entrance and the one buried inside is the way on.
    const floor = mask(`
      #########
      #.#######
      #.#######
      #.#######
      #....####
      #########
      #########
      #########
      #########
    `);
    const ends = planStairEnds(floor);
    expect(ends.entrance).toEqual({ x: 1, y: 1 });
    expect(ends.exit).toEqual({ x: 4, y: 4 });
  });

  it('will not put a stair on a tile that already has an event', () => {
    const floor = mask(`
      #######
      #.....#
      #######
    `);
    const ends = planStairEnds(floor, { blocked: [{ x: 1, y: 1 }, { x: 5, y: 1 }] });
    for (const slot of [ends.entrance, ends.exit]) {
      expect(slot).not.toEqual({ x: 1, y: 1 });
      expect(slot).not.toEqual({ x: 5, y: 1 });
      expect(floor[slot.y][slot.x]).toBe(true);
    }
    expect(ends.entrance).not.toEqual(ends.exit);
  });

  it('is deterministic — a seeded map has to reproduce its stairs too', () => {
    const floor = generateDungeon({ width: 30, height: 25, seed: 77 }).floor;
    const first = planStairEnds(floor);
    for (let i = 0; i < 5; i++) expect(planStairEnds(floor)).toEqual(first);
  });

  it('refuses a map with nowhere to stand', () => {
    expect(() => planStairEnds(mask(`
      ###
      ###
    `))).toThrow(StairError);
  });

  it('refuses when only one tile is free, rather than stacking both stairs on it', () => {
    expect(() => planStairEnds(mask(`
      ###
      #.#
      ###
    `))).toThrow(StairError);

    const twoTiles = mask(`
      ####
      #..#
      ####
    `);
    expect(() => planStairEnds(twoTiles, { blocked: [{ x: 1, y: 1 }] })).toThrow(StairError);
  });

  it('finds the true diameter on the layouts the dungeon generator produces', () => {
    // The double sweep is exact on a tree and an approximation once a layout has
    // loops. Dungeon layouts are loop-light, so this asserts it stays exact —
    // if it ever stops being, the stairs are no longer as far apart as they can be.
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
      const { floor } = generateDungeon({ width: 27, height: 21, seed });
      const ends = planStairEnds(floor);
      expect(ends.distance).toBe(bruteForceDiameter(floor));
    }
  });

  it('puts both ends on reachable floor, for dungeons and caves alike', () => {
    for (const seed of [1, 4, 9, 16, 25]) {
      for (const { floor } of [
        generateDungeon({ width: 30, height: 24, seed }),
        generateCave({ width: 30, height: 24, seed }),
      ]) {
        const ends = planStairEnds(floor);
        expect(floor[ends.entrance.y][ends.entrance.x]).toBe(true);
        expect(floor[ends.exit.y][ends.exit.x]).toBe(true);
        expect(ends.entrance).not.toEqual(ends.exit);

        // The way out has to be walkable from the way in, or the dungeon is a
        // trap: the player arrives and can never reach the stairs down.
        const reached = floodFill(floor, ends.entrance.x, ends.entrance.y);
        expect(reached[ends.exit.y][ends.exit.x]).toBe(true);
      }
    }
  });

  it('separates the stairs by most of the map, rather than dropping them side by side', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { floor } = generateDungeon({ width: 30, height: 24, seed });
      // A dungeon you cross in a few steps is not one you traverse.
      expect(planStairEnds(floor).distance).toBeGreaterThan(24);
    }
  });
});
