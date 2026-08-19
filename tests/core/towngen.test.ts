import { describe, it, expect } from 'vitest';
import {
  planTown,
  assessTownBuild,
  planTownPeople,
  planTownShop,
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
    // The property the whole band layout exists to guarantee: a door is on the
    // building's outermost wall row and entered from the tile beyond it, so that
    // tile has to be road. Without it a house is decoration. Swept with the
    // north-facing row both off and on, because a door that opens onto a roof
    // is exactly the way adding a second row could go wrong.
    for (const bothSidesOfStreet of [false, true]) {
      for (const seed of SEEDS) {
        const plan = planTown(options({ seed, bothSidesOfStreet, bandHeight: 12 }));
        expect(plan.buildings.length).toBeGreaterThan(0);
        for (const b of plan.buildings) {
          const outer = b.doorSide === 'top' ? b.rect.y : b.rect.y + b.rect.height - 1;
          const beyond = b.doorSide === 'top' ? outer - 1 : outer + 1;
          expect(b.door.y).toBe(outer);
          expect(b.door.approach.y).toBe(beyond);
          expect(
            onRoad(plan, b.door.approach.x, b.door.approach.y),
            `seed ${seed} (bothSides ${bothSidesOfStreet}): ${b.doorSide} door approach ` +
              `${b.door.approach.x},${b.door.approach.y}`
          ).toBe(true);
        }
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

describe('both sides of the street', () => {
  // A band tall enough for two buildings back to back. At TOWN_DEFAULTS the
  // budgets are floor((12 - 1) / 2) = 5 north and 6 south, against a shortest
  // legal building of max(minBuildingHeight 4, wallHeight 2 + 2 roof rows) = 4.
  const twoSided = (over: Partial<TownOptions> = {}) =>
    options({ height: 46, bandHeight: 12, bothSidesOfStreet: true, ...over });

  it('actually builds a north-facing row', () => {
    for (const seed of SEEDS) {
      const plan = planTown(twoSided({ seed }));
      const top = plan.buildings.filter((b) => b.doorSide === 'top');
      const bottom = plan.buildings.filter((b) => b.doorSide === 'bottom');
      expect(top.length, `seed ${seed}`).toBeGreaterThan(0);
      expect(bottom.length, `seed ${seed}`).toBeGreaterThan(0);
    }
  });

  it('leaves the town single-sided when switched off', () => {
    for (const seed of SEEDS) {
      const plan = planTown(twoSided({ seed, bothSidesOfStreet: false }));
      expect(plan.buildings.every((b) => b.doorSide === 'bottom'), `seed ${seed}`).toBe(true);
    }
  });

  it('stays single-sided on a band too short for two rows', () => {
    // floor((7 - 1) / 2) = 3, below the 4-row minimum, so the option is inert
    // rather than producing two rows that overlap. This is the default band.
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed, bandHeight: 7, bothSidesOfStreet: true }));
      expect(plan.buildings.every((b) => b.doorSide === 'bottom'), `seed ${seed}`).toBe(true);
    }
  });

  it('is off by default, so an unchanged call still builds bands', () => {
    // The render is the reason: a north-facing building shows its wall standing
    // on its roof, which matches 0 of 107 sample doors being entered from the
    // north. Turning it on has to be deliberate.
    expect(TOWN_DEFAULTS.bothSidesOfStreet).toBe(false);
    for (const seed of SEEDS) {
      const plan = planTown(options({ seed, bandHeight: 12 }));
      expect(plan.buildings.every((b) => b.doorSide === 'bottom'), `seed ${seed}`).toBe(true);
    }
  });

  it('never puts a north-facing row in the top band', () => {
    // The first band has the map border above it, not a road, so its top edge
    // has nothing to face.
    for (const seed of SEEDS) {
      const plan = planTown(twoSided({ seed }));
      const firstBand = plan.bands[0];
      for (const b of plan.buildings) {
        if (b.doorSide !== 'top') continue;
        expect(b.rect.y, `seed ${seed}`).not.toBe(firstBand.y);
      }
    }
  });

  it('keeps a gap between the two rows, so their roofs never touch', () => {
    for (const seed of SEEDS) {
      const plan = planTown(twoSided({ seed }));
      for (const top of plan.buildings.filter((b) => b.doorSide === 'top')) {
        for (const bottom of plan.buildings.filter((b) => b.doorSide === 'bottom')) {
          const overlapX =
            top.rect.x < bottom.rect.x + bottom.rect.width &&
            bottom.rect.x < top.rect.x + top.rect.width;
          if (!overlapX) continue;
          const topEnd = top.rect.y + top.rect.height;
          if (bottom.rect.y < topEnd) continue; // a different band entirely
          expect(bottom.rect.y, `seed ${seed}`).toBeGreaterThan(topEnd);
        }
      }
    }
  });

  it('is still reproducible from its seed', () => {
    expect(planTown(twoSided({ seed: 7 }))).toEqual(planTown(twoSided({ seed: 7 })));
  });

  it('houses more buildings than the single-sided layout', () => {
    // The point of the whole exercise: the ground above each row stops being
    // dead. Asserted as a total across the sweep rather than per seed, since a
    // single band can lose a row to the cross-street cuts.
    let two = 0;
    let one = 0;
    for (const seed of SEEDS) {
      two += planTown(twoSided({ seed })).buildings.length;
      one += planTown(twoSided({ seed, bothSidesOfStreet: false })).buildings.length;
    }
    expect(two).toBeGreaterThan(one);
  });

  it('marks the shop keeper outward from the door on either side', () => {
    for (const seed of SEEDS) {
      const plan = planTown(twoSided({ seed }));
      const people = planTownPeople(plan);
      const shop = planTownShop(plan, people);
      if (!shop || shop.candidates.length === 0) continue;
      const { approach } = shop.building.door;
      for (const c of shop.candidates) {
        // Never on the approach tile itself — that would block the shop's door.
        expect(c.x === approach.x && c.y === approach.y).toBe(false);
        // And never inside the building it belongs to.
        expect(inRect(shop.building.rect, c.x, c.y), `seed ${seed}`).toBe(false);
      }
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

describe('assessTownBuild', () => {
  /**
   * The rule under test: a map with streets and no buildings is not a town, and
   * `generate_town` used to report one as a success. A partial loss is a
   * different thing — still a town, but the count has to be said out loud.
   */
  it('refuses when nothing was planned, and points at the geometry', () => {
    const { refusal, summary } = assessTownBuild(0, 0, [], 4);
    expect(refusal).toContain('No building fitted the plan');
    expect(refusal).toContain('minBuildingWidth (4)');
    expect(refusal).toContain('Nothing was written');
    expect(summary).toBe('Buildings: none planned.');
  });

  it('refuses when every planned building was refused, quoting the first reason', () => {
    const { refusal } = assessTownBuild(2, 0, [
      '(4, 6): Wall kind 128 is outside the wall families — A3 is 48-79 and A4 is 80-127.',
      '(19, 6): Wall kind 128 is outside the wall families — A3 is 48-79 and A4 is 80-127.',
    ], 4);
    expect(refusal).toContain('All 2 planned building(s) were refused');
    expect(refusal).toContain('Wall kind 128');
    expect(refusal).toContain('Nothing was written');
  });

  it('says so rather than crashing when no reason was recorded', () => {
    expect(assessTownBuild(3, 0, [], 4).refusal).toContain('(no reason recorded)');
  });

  it('accepts a partial placement but names the loss on the buildings line', () => {
    const { refusal, summary } = assessTownBuild(13, 11, ['a', 'b'], 4);
    expect(refusal).toBeNull();
    expect(summary).toBe('Buildings: 11 of 13 planned — 2 refused and lost');
  });

  it('keeps the plain line when nothing was lost', () => {
    const { refusal, summary } = assessTownBuild(13, 13, [], 4);
    expect(refusal).toBeNull();
    expect(summary).toBe('Buildings: 13 of 13 planned');
  });
});

describe('the window where a plan yields no building', () => {
  /**
   * `planTown` warns and carries on when nothing fits, which is what let a
   * building-less town through. Measured here rather than asserted from memory:
   * at TOWN_DEFAULTS the window is widths 22-24 and nothing else, so the
   * refusal above cannot fight ordinary use.
   */
  it('is width 22-24 at the defaults, and never from 25 up', () => {
    const zeroWidths = new Set<number>();
    const okWidths = new Set<number>();
    for (let width = 25; width <= 60; width++) {
      for (let seed = 1; seed <= 3; seed++) {
        const plan = planTown(options({ width, height: 30, seed }));
        (plan.buildings.length === 0 ? zeroWidths : okWidths).add(width);
      }
    }
    expect([...zeroWidths]).toEqual([]);
    expect(okWidths.size).toBe(36);

    // Width 22 is the one that always comes out empty.
    for (let seed = 1; seed <= 3; seed++) {
      expect(planTown(options({ width: 22, height: 30, seed })).buildings).toHaveLength(0);
    }
  });
});

describe('planTownPeople', () => {
  /**
   * The rule under test: the planner hands down where a townsperson may stand,
   * instead of a later pass inferring it from passage flags and sprite names.
   * Everything here is asserted against the plan's own rects, so a failure
   * points at the derivation rather than at the town generator.
   */
  const plan = planTown(options());
  const people = planTownPeople(plan);
  const has = (list: { x: number; y: number }[], x: number, y: number) =>
    list.some((s) => s.x === x && s.y === y);

  it('blocks exactly the door approach tiles, one per building', () => {
    expect(people.blocked).toHaveLength(plan.buildings.length);
    for (const building of plan.buildings) {
      expect(has(people.blocked, building.door.approach.x, building.door.approach.y)).toBe(true);
    }
  });

  it('never offers a tile inside a building footprint', () => {
    for (const building of plan.buildings) {
      const r = building.rect;
      for (let y = r.y; y < r.y + r.height; y++) {
        for (let x = r.x; x < r.x + r.width; x++) {
          expect(has(people.candidates, x, y)).toBe(false);
        }
      }
    }
  });

  it('never offers a tile a prop already stands on', () => {
    for (const slot of [...plan.decorSlots, ...plan.frameSlots]) {
      expect(has(people.candidates, slot.x, slot.y)).toBe(false);
    }
  });

  it('never offers a door approach tile', () => {
    for (const slot of people.blocked) {
      expect(has(people.candidates, slot.x, slot.y)).toBe(false);
    }
  });

  it('does offer the streets, which is where townsfolk go', () => {
    // Every road tile that no building, prop or approach has taken.
    const road = plan.roads[0];
    let offered = 0;
    for (let y = road.y; y < road.y + road.height; y++) {
      for (let x = road.x; x < road.x + road.width; x++) {
        if (has(people.candidates, x, y)) offered++;
      }
    }
    expect(offered).toBeGreaterThan(0);
  });

  it('is reproducible: the same seed gives the same candidates', () => {
    const again = planTownPeople(planTown(options()));
    expect(again.candidates).toEqual(people.candidates);
    expect(again.blocked).toEqual(people.blocked);
  });

  it('holds across seeds', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const p = planTown(options({ seed }));
      const q = planTownPeople(p);
      expect(q.blocked).toHaveLength(p.buildings.length);
      expect(q.candidates.length).toBeGreaterThan(0);
      for (const b of p.buildings) {
        expect(has(q.candidates, b.door.approach.x, b.door.approach.y)).toBe(false);
        // The door tile itself is on the building's bottom row, so the
        // footprint rule already covers it — assert it rather than assume.
        expect(has(q.candidates, b.door.x, b.door.y)).toBe(false);
      }
    }
  });
});

describe('planTownShop', () => {
  /**
   * Two stated judgements under test — which building, and where the keeper
   * stands. Neither is measured, because the only shop on this machine is an
   * invisible trigger inside an inn (see the module comment); what *is*
   * enforced is that the keeper never takes the door approach, since that would
   * block the very shop it belongs to.
   */
  const plan = planTown(options());
  const people = planTownPeople(plan);
  const shop = planTownShop(plan, people)!;

  it('picks the building whose door is nearest the middle of the map', () => {
    const cx = (plan.width - 1) / 2;
    const cy = (plan.height - 1) / 2;
    const dist = (b: typeof shop.building) =>
      Math.abs(b.door.x - cx) + Math.abs(b.door.y - cy);
    for (const other of plan.buildings) {
      expect(dist(shop.building)).toBeLessThanOrEqual(dist(other));
    }
  });

  it('never offers the door approach tile, which would block the shop', () => {
    const a = shop.building.door.approach;
    expect(shop.candidates.some((s) => s.x === a.x && s.y === a.y)).toBe(false);
  });

  it('offers only tiles a townsperson could also stand on', () => {
    const open = new Set(people.candidates.map((s) => `${s.x},${s.y}`));
    for (const slot of shop.candidates) {
      expect(open.has(`${slot.x},${slot.y}`)).toBe(true);
    }
  });

  it('keeps the keeper next to the door rather than anywhere in town', () => {
    const a = shop.building.door.approach;
    for (const slot of shop.candidates) {
      expect(Math.abs(slot.x - a.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(slot.y - a.y)).toBeLessThanOrEqual(1);
    }
  });

  it('is reproducible without a seed — a shop is a fixed part of a map', () => {
    const again = planTownShop(planTown(options()), planTownPeople(planTown(options())))!;
    expect(again.building.rect).toEqual(shop.building.rect);
    expect(again.candidates).toEqual(shop.candidates);
  });

  it('finds a building and somewhere to stand across seeds', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const p = planTown(options({ seed }));
      const q = planTownPeople(p);
      const s = planTownShop(p, q);
      expect(s).not.toBeNull();
      expect(s!.candidates.length).toBeGreaterThan(0);
      expect(p.buildings).toContain(s!.building);
    }
  });

  it('returns null when the town has no buildings to make a shop of', () => {
    const empty = planTown(options({ width: 22, height: 30 }));
    expect(empty.buildings).toHaveLength(0);
    expect(planTownShop(empty, planTownPeople(empty))).toBeNull();
  });
});
