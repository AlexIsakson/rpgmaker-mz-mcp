import { describe, it, expect } from 'vitest';
import {
  articulationPoints,
  reachableFrom,
  findChokepoints,
  planFloorLock,
} from '../../src/core/chokepoint.js';

/**
 * The grids are written as strings so the shape being tested is visible: `#`
 * is solid, `.` walkable. Every case here is a floor plan someone could
 * actually generate.
 */

const grid = (rows: string[]): boolean[][] =>
  rows.map((row) => [...row].map((c) => c === '.'));

const at = (points: { x: number; y: number }[]) =>
  points.map((p) => `${p.x},${p.y}`).sort();

describe('articulationPoints', () => {
  it('finds the one tile joining two rooms', () => {
    //  a 3x3 room, a one-tile corridor, another 3x3 room
    const floor = grid([
      '#######',
      '#...#.#',
      '#...#.#',
      '#.......',
      '#...#.#',
      '#######',
    ]);
    // the corridor tiles at x=4,y=3 and the room mouths either side of it
    expect(at(articulationPoints(floor))).toContain('4,3');
  });

  it('finds nothing in an open room', () => {
    // Every tile has a way round it, so no single tile splits the floor.
    const floor = grid(['####', '#..#', '#..#', '####']);
    expect(articulationPoints(floor)).toEqual([]);
  });

  it('finds nothing in a loop', () => {
    // A ring corridor: cutting any one tile still leaves the long way round.
    const floor = grid([
      '#####',
      '#...#',
      '#.#.#',
      '#...#',
      '#####',
    ]);
    expect(articulationPoints(floor)).toEqual([]);
  });

  it('reports every tile whose loss strands something, not only the middle', () => {
    // A U: (1,2)-(1,1)-(2,1)-(3,1)-(3,2). Losing (2,1) halves it, but losing
    // (1,1) strands (1,2) and losing (3,1) strands (3,2) — all three are cut
    // vertices, which is why findChokepoints ranks them rather than trusting
    // the raw list.
    const floor = grid(['#####', '#...#', '#.#.#', '#####']);
    expect(at(articulationPoints(floor))).toEqual(['1,1', '2,1', '3,1']);
  });

  it('handles a floor in two unconnected pieces', () => {
    // Tarjan runs per component. The right-hand ring has no cut vertex at all;
    // the isolated left corridor has exactly its middle.
    const floor = grid([
      '#######',
      '#.#...#',
      '#.#.#.#',
      '#.#...#',
      '#######',
    ]);
    expect(at(articulationPoints(floor))).toEqual(['1,2']);
  });

  it('survives a long corridor without recursing', () => {
    // The reason the walk is iterative: a recursive DFS goes as deep as the
    // corridor is long.
    const row = '.'.repeat(4000);
    expect(() => articulationPoints(grid([row]))).not.toThrow();
    expect(articulationPoints(grid([row]))).toHaveLength(3998);
  });
});

describe('reachableFrom', () => {
  const floor = grid(['#####', '#...#', '#.#.#', '#...#', '#####']);

  it('walks the whole ring', () => {
    expect(reachableFrom(floor, { x: 1, y: 1 }).size).toBe(8);
  });

  it('treats the excluded tile as solid', () => {
    const withoutOne = reachableFrom(floor, { x: 1, y: 1 }, { x: 2, y: 1 });
    expect(withoutOne.has('2,1')).toBe(false);
    // the ring still connects the long way round
    expect(withoutOne.size).toBe(7);
  });

  it('is empty when the start is not walkable', () => {
    expect(reachableFrom(floor, { x: 0, y: 0 }).size).toBe(0);
  });
});

describe('findChokepoints', () => {
  //  left room (6 tiles) | corridor | right room (6 tiles)
  const floor = grid([
    '#########',
    '#..#...#',
    '#.......#',
    '#..#...#',
    '#########',
  ]);

  it('splits the floor at the corridor, relative to the entrance', () => {
    const found = findChokepoints(floor, { entrance: { x: 1, y: 1 }, minSideFraction: 0.1 });
    expect(found.length).toBeGreaterThan(0);
    const best = found[0];
    expect(best.nearSize).toBeGreaterThan(0);
    expect(best.farSize).toBeGreaterThan(0);
    // near + far + the door tile itself is the whole floor
    const total = floor.flat().filter(Boolean).length;
    expect(best.nearSize + best.farSize + 1).toBe(total);
  });

  it('will not put a door onto a cupboard', () => {
    // With minSideFraction at half, no split qualifies unless it is even.
    const found = findChokepoints(floor, { entrance: { x: 1, y: 1 }, minSideFraction: 0.5 });
    for (const point of found) {
      expect(Math.min(point.nearSize, point.farSize)).toBeGreaterThanOrEqual(
        Math.floor(floor.flat().filter(Boolean).length * 0.5)
      );
    }
  });

  it('refuses the tiles the caller has already used', () => {
    const all = findChokepoints(floor, { entrance: { x: 1, y: 1 }, minSideFraction: 0.1 });
    const blocked = [{ x: all[0].x, y: all[0].y }];
    const rest = findChokepoints(floor, {
      entrance: { x: 1, y: 1 },
      minSideFraction: 0.1,
      blocked,
    });
    expect(at(rest)).not.toContain(`${all[0].x},${all[0].y}`);
  });

  it('finds nothing in an open room', () => {
    expect(findChokepoints(grid(['####', '#..#', '#..#', '####']), {
      entrance: { x: 1, y: 1 },
    })).toEqual([]);
  });

  it('orders by the most even split', () => {
    const found = findChokepoints(floor, { entrance: { x: 1, y: 1 }, minSideFraction: 0.05 });
    const smaller = found.map((p) => Math.min(p.nearSize, p.farSize));
    expect([...smaller].sort((a, b) => b - a)).toEqual(smaller);
  });
});

describe('planFloorLock', () => {
  //  entrance ── corridor ── a room with a dead-end alcove
  const floor = grid([
    '##########',
    '#...#....#',
    '#...#....#',
    '#........#',
    '#...#....#',
    '#.#.#....#',
    '##########',
  ]);

  it('puts the opener on the near side', () => {
    const plan = planFloorLock(floor, { entrance: { x: 1, y: 1 }, minSideFraction: 0.1 })!;
    expect(plan).not.toBeNull();
    const nearKeys = plan.near.map((s) => `${s.x},${s.y}`);
    expect(nearKeys).toContain(`${plan.opener.x},${plan.opener.y}`);
    expect(nearKeys).not.toContain(`${plan.door.x},${plan.door.y}`);
  });

  it('prefers a dead end, the way treasure placement does', () => {
    const plan = planFloorLock(floor, { entrance: { x: 1, y: 1 }, minSideFraction: 0.1 })!;
    const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => {
      const nx = plan.opener.x + dx;
      const ny = plan.opener.y + dy;
      return floor[ny]?.[nx];
    }).length;
    expect(neighbours).toBe(1);
  });

  it('never puts the opener on the entrance itself', () => {
    const plan = planFloorLock(floor, { entrance: { x: 1, y: 1 }, minSideFraction: 0.1 })!;
    expect(`${plan.opener.x},${plan.opener.y}`).not.toBe('1,1');
  });

  it('returns null when the floor has no chokepoint at all', () => {
    expect(
      planFloorLock(grid(['#####', '#...#', '#...#', '#####']), { entrance: { x: 1, y: 1 } })
    ).toBeNull();
  });

  it('is deterministic', () => {
    const once = planFloorLock(floor, { entrance: { x: 1, y: 1 }, minSideFraction: 0.1 });
    const twice = planFloorLock(floor, { entrance: { x: 1, y: 1 }, minSideFraction: 0.1 });
    expect(once).toEqual(twice);
  });
});
