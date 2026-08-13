import { describe, it, expect } from 'vitest';
import {
  torchEventPage,
  torchEvent,
  treasureEventPages,
  treasureEvent,
  planDressing,
  CHEST_CLOSED_DIRECTION,
  CHEST_OPEN_DIRECTION,
  type DressingOptions,
  rejectSealingSlots,
} from '../../src/core/dungeon-dressing.js';
import { generateDungeon, floodFill } from '../../src/core/mapgen.js';

describe('torchEventPage', () => {
  it('uses the settings 499 of the 635 shipped torches use', () => {
    const page = torchEventPage();
    expect(page.trigger).toBe(0);         // action button
    expect(page.priorityType).toBe(1);    // same as characters
    expect(page.stepAnime).toBe(true);    // the flame flickers in place
    expect(page.walkAnime).toBe(true);
    expect(page.directionFix).toBe(true); // it never turns to face you
    expect(page.through).toBe(false);
    expect(page.image.characterName).toBe('!Flame');
  });

  it('does nothing when spoken to — it is scenery', () => {
    expect(torchEventPage().list.map((c) => c.code)).toEqual([0]);
  });

  it('takes another sheet', () => {
    const page = torchEventPage({ characterName: '!Other1', characterIndex: 3 });
    expect(page.image).toMatchObject({ characterName: '!Other1', characterIndex: 3 });
  });

  it('makes an event with one page', () => {
    const event = torchEvent(5, 3, 4);
    expect(event).toMatchObject({ id: 5, x: 3, y: 4 });
    expect(event.pages).toHaveLength(1);
  });
});

describe('treasureEventPages', () => {
  it('matches the pickup sequence 16 of the 20 shipped ones use', () => {
    // play a sound, say what you got, hand it over, remember it happened
    const [closed] = treasureEventPages();
    expect(closed.list.map((c) => c.code)).toEqual([250, 101, 401, 126, 123, 0]);
  });

  it('hands over the item and flips the self switch', () => {
    const [closed] = treasureEventPages({
      loot: { kind: 'item', dataId: 7, name: 'Potion', price: 100, amount: 3 },
    });
    const give = closed.list.find((c) => c.code === 126)!;
    const remember = closed.list.find((c) => c.code === 123)!;
    // [itemId, operation (0 = gain), operand (0 = constant), amount]
    expect(give.parameters).toEqual([7, 0, 0, 3]);
    // [switch, value (0 = ON)]
    expect(remember.parameters).toEqual(['A', 0]);
  });

  it('uses the command that matches the database the reward came from', () => {
    // command126 gains $dataItems, 127 $dataWeapons, 128 $dataArmors — emitting
    // 126 for a weapon id hands over whichever *item* shares that number.
    const weapon = treasureEventPages({
      loot: { kind: 'weapon', dataId: 4, name: 'Sword', price: 500, amount: 1 },
    })[0];
    expect(weapon.list.map((c) => c.code)).toEqual([250, 101, 401, 127, 123, 0]);
    // the equipment commands carry includeEquip as a fifth parameter
    expect(weapon.list.find((c) => c.code === 127)!.parameters).toEqual([4, 0, 0, 1, false]);

    const armor = treasureEventPages({
      loot: { kind: 'armor', dataId: 9, name: 'Shield', price: 300, amount: 1 },
    })[0];
    expect(armor.list.find((c) => c.code === 128)!.parameters).toEqual([9, 0, 0, 1, false]);
  });

  it('names the reward in the message rather than saying "something"', () => {
    const [closed] = treasureEventPages({
      loot: { kind: 'item', dataId: 7, name: 'Potion', price: 100, amount: 1 },
    });
    const body = closed.list.find((c) => c.code === 401)!;
    expect(body.parameters[0]).toBe('You found \\c[6]Potion\\c[0]!');
  });

  it('leaves a second page behind the self switch that does nothing', () => {
    const pages = treasureEventPages();
    expect(pages).toHaveLength(2);
    expect(pages[1].conditions.selfSwitchValid).toBe(true);
    expect(pages[1].conditions.selfSwitchCh).toBe('A');
    expect(pages[1].list.map((c) => c.code)).toEqual([0]);
  });

  it('opens by direction, the way the sheet is drawn', () => {
    // The !Chest sheet lays its four rows out closed / ajar / half / open, so
    // the lid is animated by turning the event — the !Door1 trick.
    const [closed, opened] = treasureEventPages();
    expect(closed.image.direction).toBe(CHEST_CLOSED_DIRECTION);
    expect(opened.image.direction).toBe(CHEST_OPEN_DIRECTION);
    expect(opened.image.characterName).toBe(closed.image.characterName);
    expect(closed.directionFix).toBe(true); // or walking past would turn the lid
  });

  it('keeps both pages on the same sprite when one is chosen', () => {
    const pages = treasureEventPages({ characterName: '!SF_Chest', characterIndex: 2 });
    for (const page of pages) {
      expect(page.image.characterName).toBe('!SF_Chest');
      expect(page.image.characterIndex).toBe(2);
    }
  });

  it('honours a different self switch on both pages', () => {
    const pages = treasureEventPages({ selfSwitch: 'C' });
    expect(pages[0].list.find((c) => c.code === 123)!.parameters).toEqual(['C', 0]);
    expect(pages[1].conditions.selfSwitchCh).toBe('C');
  });

  it('makes an event with both pages', () => {
    expect(treasureEvent(2, 8, 9).pages).toHaveLength(2);
  });
});

/** '.' walkable, '#' solid. */
function grid(rows: string[]): boolean[][] {
  return rows.map((r) => [...r].map((c) => c === '.'));
}

function options(over: Partial<DressingOptions> = {}): DressingOptions {
  return {
    seed: 1,
    torchCount: 4,
    treasureCount: 2,
    floorPropDensity: 0.1,
    wallPropDensity: 0.1,
    ...over,
  };
}

describe('planDressing', () => {
  /** A room, a corridor, and two dead-end stubs off it. */
  const map = grid([
    '##########',
    '#....#...#',
    '#....#.#.#',
    '#....#.#.#',
    '#.........',
    '#....#.#.#',
    '##########',
  ]);

  it('puts torches only on solid tiles with floor below them', () => {
    const plan = planDressing(map, options({ torchCount: 20, torchSpacing: 1 }));
    expect(plan.torches.length).toBeGreaterThan(0);
    for (const t of plan.torches) {
      expect(map[t.y][t.x], `torch on floor at ${t.x},${t.y}`).toBe(false);
      expect(map[t.y + 1][t.x], `torch with no floor below at ${t.x},${t.y}`).toBe(true);
    }
  });

  it('keeps torches apart', () => {
    const plan = planDressing(map, options({ torchCount: 20, torchSpacing: 3 }));
    for (let i = 0; i < plan.torches.length; i++) {
      for (let j = i + 1; j < plan.torches.length; j++) {
        const a = plan.torches[i];
        const b = plan.torches[j];
        const apart = Math.abs(a.x - b.x) >= 3 || Math.abs(a.y - b.y) >= 3;
        expect(apart, `${a.x},${a.y} too near ${b.x},${b.y}`).toBe(true);
      }
    }
  });

  it('puts treasure only in dead ends', () => {
    // A chest blocks its tile. A dead end has one way in and nothing beyond it,
    // so blocking one can never cut anything off — anywhere else could.
    const plan = planDressing(map, options({ treasureCount: 10 }));
    expect(plan.treasure.length).toBeGreaterThan(0);
    for (const t of plan.treasure) {
      const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .filter(([dx, dy]) => map[t.y + dy]?.[t.x + dx]).length;
      expect(neighbours, `treasure at ${t.x},${t.y} is not a dead end`).toBe(1);
    }
  });

  it('places fewer chests rather than putting one where it could seal a corridor', () => {
    const plan = planDressing(map, options({ treasureCount: 99 }));
    expect(plan.treasure.length).toBe(plan.deadEnds);
    expect(plan.treasure.length).toBeLessThan(99);
  });

  it('places no treasure in a dungeon with no dead ends', () => {
    const openRoom = grid(['#####', '#...#', '#...#', '#####']);
    const plan = planDressing(openRoom, options({ treasureCount: 3 }));
    expect(plan.deadEnds).toBe(0);
    expect(plan.treasure).toEqual([]);
  });

  it('never puts two things on the same tile', () => {
    const plan = planDressing(map, options({ torchCount: 20, torchSpacing: 1, treasureCount: 10 }));
    const all = [...plan.torches, ...plan.treasure, ...plan.floorProps, ...plan.wallProps]
      .map((s) => `${s.x},${s.y}`);
    expect(new Set(all).size).toBe(all.length);
  });

  it('leaves blocked tiles alone', () => {
    const blocked = [{ x: 1, y: 1 }, { x: 7, y: 5 }];
    const plan = planDressing(map, options({ torchCount: 20, torchSpacing: 1, blocked }));
    const used = new Set(
      [...plan.torches, ...plan.treasure, ...plan.floorProps, ...plan.wallProps]
        .map((s) => `${s.x},${s.y}`)
    );
    for (const b of blocked) expect(used.has(`${b.x},${b.y}`)).toBe(false);
  });

  it('keeps floor props on the floor and wall props on wall faces', () => {
    const plan = planDressing(map, options({ floorPropDensity: 0.5, wallPropDensity: 0.5 }));
    for (const s of plan.floorProps) expect(map[s.y][s.x]).toBe(true);
    for (const s of plan.wallProps) {
      expect(map[s.y][s.x]).toBe(false);
      expect(map[s.y + 1][s.x]).toBe(true);
    }
  });

  it('reproduces the same plan from the same seed', () => {
    expect(planDressing(map, options({ seed: 8 }))).toEqual(planDressing(map, options({ seed: 8 })));
    expect(planDressing(map, options({ seed: 8 })).torches)
      .not.toEqual(planDressing(map, options({ seed: 9 })).torches);
  });

  it('places nothing when asked for nothing', () => {
    const plan = planDressing(map, options({
      torchCount: 0, treasureCount: 0, floorPropDensity: 0, wallPropDensity: 0,
    }));
    expect(plan.torches).toEqual([]);
    expect(plan.treasure).toEqual([]);
    expect(plan.floorProps).toEqual([]);
    expect(plan.wallProps).toEqual([]);
  });
});

describe('rejectSealingSlots', () => {
  /** `#` solid, `.` open. */
  const mask = (art: string): boolean[][] =>
    art.trim().split('\n').map((line) => [...line.trim()].map((c) => c === '.'));

  it('keeps every prop that cannot block anything, without checking', () => {
    const floor = mask(`
      #####
      #...#
      #####
    `);
    const slots = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }];
    // Gravel and crystals are walked over; nothing to check.
    const { kept, sealed } = rejectSealingSlots(floor, slots, [false, false, false]);
    expect(kept).toEqual([0, 1, 2]);
    expect(sealed).toEqual([]);
  });

  it('drops a solid prop that would wall off the far end of a corridor', () => {
    // Blocking the middle of the corridor strands 3,1 and 4,1.
    const floor = mask(`
      ######
      #....#
      ######
    `);
    const { kept, sealed } = rejectSealingSlots(floor, [{ x: 2, y: 1 }], [true]);
    expect(kept).toEqual([]);
    expect(sealed).toEqual([0]);
  });

  it('allows a solid prop at a dead end, where nothing is beyond it', () => {
    const floor = mask(`
      ######
      #....#
      ######
    `);
    // 4,1 is the tip: blocking it costs only itself.
    expect(rejectSealingSlots(floor, [{ x: 4, y: 1 }], [true]).kept).toEqual([0]);
  });

  it('allows a solid prop in open space the map can walk around', () => {
    const floor = mask(`
      #####
      #...#
      #...#
      #...#
      #####
    `);
    expect(rejectSealingSlots(floor, [{ x: 2, y: 2 }], [true]).kept).toEqual([0]);
  });

  it('catches two props that are each harmless alone and seal together', () => {
    // A ring corridor. Closing one tile leaves a path round the other way;
    // closing a second on the far side cuts the ring into two halves.
    const floor = mask(`
      #######
      #.....#
      #.###.#
      #.###.#
      #.....#
      #######
    `);
    const top = { x: 3, y: 1 };
    const bottom = { x: 3, y: 4 };
    expect(rejectSealingSlots(floor, [top], [true]).kept).toEqual([0]);
    expect(rejectSealingSlots(floor, [bottom], [true]).kept).toEqual([0]);

    // Together the second has to go — which a check that measured each against
    // the untouched map, rather than incrementally, would wave through.
    const both = rejectSealingSlots(floor, [top, bottom], [true, true]);
    expect(both.kept).toEqual([0]);
    expect(both.sealed).toEqual([1]);
  });

  it('measures against what the map was, not against being fully connected', () => {
    // The pocket at 4,1 is already cut off. A prop elsewhere is still fine.
    const floor = mask(`
      #####
      #.#.#
      #.###
      #.###
      #####
    `);
    expect(rejectSealingSlots(floor, [{ x: 1, y: 3 }], [true]).kept).toEqual([0]);
  });

  it('never lets a prop make a reachable tile unreachable, over generated dungeons', () => {
    for (const seed of [1, 3, 7, 11, 19]) {
      const { floor } = generateDungeon({ width: 34, height: 26, seed });
      const plan = planDressing(floor, {
        seed, torchCount: 0, treasureCount: 0,
        floorPropDensity: 0.15, wallPropDensity: 0,
      });
      // Worst case: every scattered prop is a solid one.
      const blocks = plan.floorProps.map(() => true);
      const { kept } = rejectSealingSlots(floor, plan.floorProps, blocks);

      const placed = new Set(kept.map((i) => `${plan.floorProps[i].x},${plan.floorProps[i].y}`));
      const after = floor.map((row, y) =>
        row.map((open, x) => open && !placed.has(`${x},${y}`))
      );

      // Flood both from the same tile — one the props never touch — so the two
      // reachable sets are directly comparable.
      let start: { x: number; y: number } | null = null;
      for (let y = 0; y < floor.length && start === null; y++) {
        for (let x = 0; x < floor[y].length; x++) {
          if (after[y][x]) { start = { x, y }; break; }
        }
      }
      expect(start).not.toBeNull();

      const before = floodFill(floor, start!.x, start!.y);
      const reachable = floodFill(after, start!.x, start!.y);
      expect(before.flat().filter(Boolean).length).toBeGreaterThan(100);

      let lost = 0;
      for (let y = 0; y < floor.length; y++) {
        for (let x = 0; x < floor[y].length; x++) {
          if (before[y][x] && !placed.has(`${x},${y}`) && !reachable[y][x]) lost++;
        }
      }
      expect({ seed, lost }).toEqual({ seed, lost: 0 });
      expect(kept.length).toBeGreaterThan(0);
    }
  });
});
