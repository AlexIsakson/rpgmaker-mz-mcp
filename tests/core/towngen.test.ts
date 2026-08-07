import { describe, it, expect } from 'vitest';
import {
  planTown,
  renderTownAscii,
  TownError,
  TOWN_DEFAULTS,
  type TownOptions,
  type TownPlan,
} from '../../src/core/towngen.js';
import type { Rect } from '../../src/core/autotile.js';

function options(over: Partial<TownOptions> = {}): TownOptions {
  return { width: 44, height: 34, seed: 1, ...TOWN_DEFAULTS, ...over };
}

const inRect = (r: Rect, x: number, y: number) =>
  x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

const onRoad = (plan: TownPlan, x: number, y: number) =>
  plan.roads.some((r) => inRect(r, x, y));

const onBuilding = (plan: TownPlan, x: number, y: number) =>
  plan.buildings.some((b) => inRect(b.rect, x, y));

/** Seeds to sweep, so a property is not proved by one lucky layout. */
const SEEDS = Array.from({ length: 25 }, (_, i) => i + 1);

describe('planTown', () => {
  it('produces the same town for the same seed', () => {
    expect(planTown(options({ seed: 7 }))).toEqual(planTown(options({ seed: 7 })));
  });

  it('produces different towns for different seeds', () => {
    const a = renderTownAscii(planTown(options({ seed: 1 })));
    const b = renderTownAscii(planTown(options({ seed: 2 })));
    expect(a).not.toEqual(b);
  });

  it('builds something on a reasonable map', () => {
    const plan = planTown(options());
    expect(plan.buildings.length).toBeGreaterThan(3);
    expect(plan.roads.length).toBeGreaterThan(1);
    expect(plan.warnings).toEqual([]);
  });
});

describe('layout invariants', () => {
  it('keeps everything inside the map', () => {
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed }));
      for (const b of plan.buildings) {
        expect(b.rect.x).toBeGreaterThanOrEqual(0);
        expect(b.rect.y).toBeGreaterThanOrEqual(0);
        expect(b.rect.x + b.rect.width).toBeLessThanOrEqual(plan.width);
        expect(b.rect.y + b.rect.height).toBeLessThanOrEqual(plan.height);
      }
      for (const s of [...plan.decorSlots, ...plan.frameSlots]) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThan(plan.width);
        expect(s.y).toBeLessThan(plan.height);
      }
    }
  });

  it('never overlaps two buildings', () => {
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed }));
      for (let i = 0; i < plan.buildings.length; i++) {
        for (let j = i + 1; j < plan.buildings.length; j++) {
          const a = plan.buildings[i].rect;
          const b = plan.buildings[j].rect;
          const overlap =
            a.x < b.x + b.width && b.x < a.x + a.width &&
            a.y < b.y + b.height && b.y < a.y + a.height;
          expect(overlap, `seed ${seed}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(false);
        }
      }
    }
  });

  it('never builds on a street', () => {
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed }));
      for (const b of plan.buildings) {
        for (let y = b.rect.y; y < b.rect.y + b.rect.height; y++) {
          for (let x = b.rect.x; x < b.rect.x + b.rect.width; x++) {
            expect(onRoad(plan, x, y), `seed ${seed}: building at ${x},${y}`).toBe(false);
          }
        }
      }
    }
  });

  it('opens every door onto a street', () => {
    // The property the whole band layout exists to guarantee: a door is on a
    // building's bottom row and entered from the tile below, so that tile has
    // to be road. Without it a house is decoration.
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed }));
      expect(plan.buildings.length).toBeGreaterThan(0);
      for (const b of plan.buildings) {
        expect(b.door.y).toBe(b.rect.y + b.rect.height - 1);
        expect(b.door.approach.y).toBe(b.door.y + 1);
        expect(
          onRoad(plan, b.door.approach.x, b.door.approach.y),
          `seed ${seed}: door approach ${b.door.approach.x},${b.door.approach.y}`
        ).toBe(true);
      }
    }
  });

  it('puts the door on the building, away from its corners where it can', () => {
    for (const seed of SEEDS) {
      for (const b of planTown(options({ seed })).buildings) {
        expect(b.doorOffsetX).toBeGreaterThanOrEqual(0);
        expect(b.doorOffsetX).toBeLessThan(b.rect.width);
        if (b.rect.width >= 3) {
          expect(b.doorOffsetX).toBeGreaterThan(0);
          expect(b.doorOffsetX).toBeLessThan(b.rect.width - 1);
        }
      }
    }
  });

  it('connects the whole street network', () => {
    // Cross streets intersect every road, so this holds by construction — which
    // is exactly why it is worth asserting: a change to the street layout that
    // broke it would otherwise produce a town split into unreachable halves.
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed }));
      const road: boolean[][] = Array.from({ length: plan.height }, () =>
        new Array<boolean>(plan.width).fill(false)
      );
      let total = 0;
      for (let y = 0; y < plan.height; y++) {
        for (let x = 0; x < plan.width; x++) {
          if (onRoad(plan, x, y)) { road[y][x] = true; total++; }
        }
      }

      const start = (() => {
        for (let y = 0; y < plan.height; y++)
          for (let x = 0; x < plan.width; x++) if (road[y][x]) return { x, y };
        return null;
      })();
      expect(start).not.toBeNull();

      const seen = Array.from({ length: plan.height }, () => new Array<boolean>(plan.width).fill(false));
      const stack = [start!];
      seen[start!.y][start!.x] = true;
      let reached = 0;
      while (stack.length > 0) {
        const { x, y } = stack.pop()!;
        reached++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= plan.width || ny >= plan.height) continue;
          if (!road[ny][nx] || seen[ny][nx]) continue;
          seen[ny][nx] = true;
          stack.push({ x: nx, y: ny });
        }
      }
      expect(reached, `seed ${seed}`).toBe(total);
    }
  });

  it('reaches the map edge, so the town can be entered', () => {
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed }));
      const touchesTop = plan.roads.some((r) => r.y === 0);
      const touchesLeft = plan.roads.some((r) => r.x === 0);
      expect(touchesTop, `seed ${seed}`).toBe(true);
      expect(touchesLeft, `seed ${seed}`).toBe(true);
    }
  });
});

describe('decoration placement', () => {
  it('never puts a prop on a building or in the street', () => {
    // The placement-audit finding, enforced before anything is written: props
    // used to land on bakery walls and across roofs.
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed }));
      for (const s of plan.decorSlots) {
        expect(onBuilding(plan, s.x, s.y), `seed ${seed}: decor on building at ${s.x},${s.y}`).toBe(false);
        expect(onRoad(plan, s.x, s.y), `seed ${seed}: decor on road at ${s.x},${s.y}`).toBe(false);
      }
    }
  });

  it('never blocks a door', () => {
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed }));
      const decor = new Set(plan.decorSlots.map((s) => `${s.x},${s.y}`));
      for (const b of plan.buildings) {
        expect(decor.has(`${b.door.approach.x},${b.door.approach.y}`)).toBe(false);
      }
    }
  });

  it('never places the same slot twice', () => {
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed }));
      const keys = plan.decorSlots.map((s) => `${s.x},${s.y}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('puts props against walls and streets before the open middle', () => {
    // Uniform scatter leaves a lone crate in the centre of a field. At the
    // default density there is always more edge than there are props, so every
    // one of them should be touching something.
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed }));
      const beside = (x: number, y: number) => {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if (onRoad(plan, x + dx, y + dy) || onBuilding(plan, x + dx, y + dy)) return true;
        return false;
      };
      for (const s of plan.decorSlots) {
        expect(beside(s.x, s.y), `seed ${seed}: lone prop at ${s.x},${s.y}`).toBe(true);
      }
    }
  });

  it('scales with decorDensity, and places nothing at zero', () => {
    expect(planTown(options({ decorDensity: 0 })).decorSlots).toEqual([]);
    const sparse = planTown(options({ decorDensity: 0.05 })).decorSlots.length;
    const dense = planTown(options({ decorDensity: 0.4 })).decorSlots.length;
    expect(dense).toBeGreaterThan(sparse);
  });
});

describe('the frame around the edge', () => {
  it('stays in the border band and off the streets', () => {
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed }));
      const usable: Rect = {
        x: TOWN_DEFAULTS.border,
        y: TOWN_DEFAULTS.border,
        width: plan.width - TOWN_DEFAULTS.border * 2,
        height: plan.height - TOWN_DEFAULTS.border * 2,
      };
      expect(plan.frameSlots.length).toBeGreaterThan(0);
      for (const s of plan.frameSlots) {
        expect(inRect(usable, s.x, s.y), `seed ${seed}: frame inside town at ${s.x},${s.y}`).toBe(false);
        for (let dy = 0; dy < TOWN_DEFAULTS.framePropHeight; dy++) {
          expect(onRoad(plan, s.x, s.y + dy), `seed ${seed}: frame on road`).toBe(false);
        }
      }
    }
  });

  it('leaves the outermost ring clear so the outside stays joined to the roads', () => {
    // A tree's canopy is walkable and its trunk is not, so a tree line flush
    // against the map edge seals a strip of ground outside it. Leaving the
    // outer ring open keeps that strip connected to the streets that cut
    // through the trees.
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed }));
      for (const s of plan.frameSlots) {
        expect(s.x).toBeGreaterThan(0);
        expect(s.y).toBeGreaterThan(0);
        expect(s.x).toBeLessThan(plan.width - 1);
        expect(s.y + TOWN_DEFAULTS.framePropHeight).toBeLessThanOrEqual(plan.height - 1);
      }
    }
  });

  it('never overlaps two framing props', () => {
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed }));
      const used = new Set<string>();
      for (const s of plan.frameSlots) {
        for (let dy = 0; dy < TOWN_DEFAULTS.framePropHeight; dy++) {
          const key = `${s.x},${s.y + dy}`;
          expect(used.has(key)).toBe(false);
          used.add(key);
        }
      }
    }
  });

  it('places no frame at all with a zero border', () => {
    expect(planTown(options({ border: 0 })).frameSlots).toEqual([]);
  });
});

describe('refusals', () => {
  it('refuses a town with no cross street', () => {
    expect(() => planTown(options({ crossStreets: 0 }))).toThrow(TownError);
    expect(() => planTown(options({ crossStreets: 0 }))).toThrow(/at least one cross street/);
  });

  it('refuses a map too small to hold a band and its road', () => {
    expect(() => planTown(options({ width: 14, height: 12 }))).toThrow(TownError);
  });

  it('refuses a band with no gap above the shortest building', () => {
    expect(() => planTown(options({ bandHeight: 4, minBuildingHeight: 4 }))).toThrow(/no gap above/);
  });

  it('refuses a building too short for a roof', () => {
    // wallHeight 4 needs 6 rows before a nine-slice roof fits.
    expect(() => planTown(options({ wallHeight: 4, maxBuildingHeight: 5 }))).toThrow(/plus two roof rows/);
  });

  it('refuses more cross streets than the map can carry', () => {
    expect(() => planTown(options({ crossStreets: 4, width: 30 }))).toThrow(/Use fewer/);
  });

  it('refuses a 1-wide building, which a nine-slice roof cannot cover', () => {
    expect(() => planTown(options({ minBuildingWidth: 1 }))).toThrow(/no 1-wide form/);
  });
});

describe('renderTownAscii', () => {
  it('draws the plan at map size with a door on every building', () => {
    const plan = planTown(options());
    const rows = renderTownAscii(plan).split('\n');
    expect(rows).toHaveLength(plan.height);
    expect(rows[0]).toHaveLength(plan.width);
    expect(renderTownAscii(plan).split('+').length - 1).toBe(plan.buildings.length);
  });
});
