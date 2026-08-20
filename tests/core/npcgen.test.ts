import { describe, it, expect } from 'vitest';
import {
  isBigCharacterSheet,
  isObjectCharacterSheet,
  charactersOnSheet,
  wrapDialogue,
  dialogueCommands,
  npcEventPage,
  npcEvent,
  planNpcPlacement,
  moveTypeCode,
  NpcError,
  MESSAGE_LINES_PER_BOX,
  DEFAULT_WRAP_WIDTH,
  situationalLine,
  type Slot,
} from '../../src/core/npcgen.js';

describe('character sheet naming', () => {
  it('follows ImageManager: $ is one big character, ! is an object', () => {
    expect(isBigCharacterSheet('$BigMonster1')).toBe(true);
    expect(isBigCharacterSheet('!$Gate1')).toBe(true);
    expect(isBigCharacterSheet('People1')).toBe(false);
    expect(isBigCharacterSheet('Actor1$')).toBe(false); // the sign block is a prefix

    expect(isObjectCharacterSheet('!Door1')).toBe(true);
    expect(isObjectCharacterSheet('!$Gate1')).toBe(true);
    expect(isObjectCharacterSheet('$BigMonster1')).toBe(false);
    expect(isObjectCharacterSheet('People1')).toBe(false);
  });

  it('counts eight characters on a normal sheet and one on a big one', () => {
    expect(charactersOnSheet('People1')).toBe(8);
    expect(charactersOnSheet('!Door1')).toBe(8);
    expect(charactersOnSheet('$BigMonster1')).toBe(1);
    expect(charactersOnSheet('!$Gate1')).toBe(1);
  });
});

describe('wrapDialogue', () => {
  it('leaves short text alone', () => {
    expect(wrapDialogue('Hello there.')).toEqual(['Hello there.']);
  });

  it('breaks on word boundaries', () => {
    const lines = wrapDialogue('one two three four five six seven eight nine ten', 15);
    expect(lines.every((l) => l.length <= 15)).toBe(true);
    expect(lines.join(' ')).toBe('one two three four five six seven eight nine ten');
  });

  it('keeps the caller\'s own line breaks', () => {
    expect(wrapDialogue('first\nsecond')).toEqual(['first', 'second']);
  });

  it('cuts a word longer than the window rather than overflowing', () => {
    const lines = wrapDialogue('a'.repeat(30), 10);
    expect(lines).toEqual(['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaaaaaaa']);
  });

  it('never returns a line wider than asked for', () => {
    const text = 'The quick brown fox jumps over the lazy dog and keeps on running for a while.';
    for (const width of [8, 16, 24, DEFAULT_WRAP_WIDTH]) {
      for (const line of wrapDialogue(text, width)) {
        expect(line.length, `width ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('dialogueCommands', () => {
  it('emits Show Text then one body line each', () => {
    const commands = dialogueCommands('Hello.');
    expect(commands.map((c) => c.code)).toEqual([101, 401]);
    expect(commands[1].parameters).toEqual(['Hello.']);
  });

  it('writes the MZ parameter list the demo projects use', () => {
    // [faceName, faceIndex, background (0 = window), position (2 = bottom), speakerName]
    expect(dialogueCommands('Hi')[0].parameters).toEqual(['', 0, 0, 2, '']);
    expect(dialogueCommands('Hi', { face: { name: 'Actor1', index: 3 } })[0].parameters)
      .toEqual(['Actor1', 3, 0, 2, '']);
  });

  it('starts a new box every four lines', () => {
    const commands = dialogueCommands('a\nb\nc\nd\ne\nf');
    expect(commands.filter((c) => c.code === 101)).toHaveLength(2);
    expect(commands.filter((c) => c.code === 401)).toHaveLength(6);
    // and the second box opens exactly at the fifth line
    expect(commands[MESSAGE_LINES_PER_BOX + 1].code).toBe(101);
  });

  it('emits nothing for empty text', () => {
    expect(dialogueCommands('')).toEqual([]);
  });
});

describe('npcEventPage', () => {
  it('uses the settings real projects use', () => {
    const page = npcEventPage({ characterName: 'People1', characterIndex: 3, text: 'Hello.' });
    expect(page.trigger).toBe(0);         // action button
    expect(page.priorityType).toBe(1);    // same as characters, so it blocks its tile
    expect(page.moveType).toBe(0);        // fixed
    expect(page.walkAnime).toBe(true);
    expect(page.stepAnime).toBe(true);    // idles in place
    expect(page.directionFix).toBe(false);
    expect(page.image).toEqual({
      characterIndex: 3, characterName: 'People1', direction: 2, pattern: 1, tileId: 0,
    });
    expect(page.list[page.list.length - 1].code).toBe(0);
  });

  it('maps movement onto the codes Game_Event switches on', () => {
    expect(moveTypeCode('fixed')).toBe(0);
    expect(moveTypeCode('random')).toBe(1);
    expect(moveTypeCode('toward')).toBe(2);
    expect(npcEventPage({ characterName: 'People1', movement: 'random' }).moveType).toBe(1);
  });

  it('maps the trigger', () => {
    expect(npcEventPage({ characterName: 'People1', trigger: 'touch' }).trigger).toBe(1);
  });

  it('refuses an index the sheet does not hold', () => {
    expect(() => npcEventPage({ characterName: '$BigMonster1', characterIndex: 1 }))
      .toThrow(/holds 1 character/);
    expect(() => npcEventPage({ characterName: 'People1', characterIndex: 8 })).toThrow(NpcError);
    expect(() => npcEventPage({ characterName: 'People1', characterIndex: 7 })).not.toThrow();
  });

  it('refuses an NPC with no sprite, which would be invisible', () => {
    expect(() => npcEventPage({ characterName: '' })).toThrow(/needs a character sheet/);
  });

  it('refuses a direction that is not one of the four', () => {
    expect(() => npcEventPage({ characterName: 'People1', direction: 5 })).toThrow(NpcError);
  });

  it('makes an event with one page at the given tile', () => {
    const event = npcEvent(4, 9, 2, 'Baker', { characterName: 'People1' });
    expect(event).toMatchObject({ id: 4, x: 9, y: 2, name: 'Baker' });
    expect(event.pages).toHaveLength(1);
  });
});

/** Build a standable grid from an ASCII picture: '.' walkable, '#' solid. */
function grid(rows: string[]): boolean[][] {
  return rows.map((r) => [...r].map((c) => c === '.'));
}

function countReachable(standable: boolean[][], taken: Slot[], from: Slot): number {
  const blocked = new Set(taken.map((s) => `${s.x},${s.y}`));
  const seen = new Set<string>([`${from.x},${from.y}`]);
  const stack = [from];
  let n = 0;
  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    n++;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (ny < 0 || nx < 0 || ny >= standable.length || nx >= standable[0].length) continue;
      if (!standable[ny][nx] || blocked.has(`${nx},${ny}`) || seen.has(`${nx},${ny}`)) continue;
      seen.add(`${nx},${ny}`);
      stack.push({ x: nx, y: ny });
    }
  }
  return n;
}

describe('planNpcPlacement', () => {
  const open = grid([
    '##########',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '##########',
  ]);

  it('places what was asked for on open ground', () => {
    const result = planNpcPlacement(open, { count: 5, seed: 1 });
    expect(result.placed).toHaveLength(5);
    expect(result.ranOut).toBe(false);
  });

  it('never places two on the same tile', () => {
    const keys = planNpcPlacement(open, { count: 20, seed: 3 }).placed.map((s) => `${s.x},${s.y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('only ever uses walkable tiles', () => {
    for (const slot of planNpcPlacement(open, { count: 20, seed: 2 }).placed) {
      expect(open[slot.y][slot.x]).toBe(true);
    }
  });

  it('reproduces the same placement for a seed', () => {
    expect(planNpcPlacement(open, { count: 6, seed: 9 }).placed)
      .toEqual(planNpcPlacement(open, { count: 6, seed: 9 }).placed);
    expect(planNpcPlacement(open, { count: 6, seed: 9 }).placed)
      .not.toEqual(planNpcPlacement(open, { count: 6, seed: 10 }).placed);
  });

  it('leaves reserved tiles alone', () => {
    const blocked: Slot[] = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }];
    const result = planNpcPlacement(open, { count: 30, seed: 4, blocked });
    const used = new Set(result.placed.map((s) => `${s.x},${s.y}`));
    for (const b of blocked) expect(used.has(`${b.x},${b.y}`)).toBe(false);
  });

  describe('connectivity', () => {
    /** Two rooms joined by a single tile — the classic thing an NPC seals. */
    const corridor = grid([
      '#########',
      '#...#...#',
      '#....^..#'.replace('^', '.'),
      '#...#...#',
      '#########',
    ]);

    it('never stands in the one tile joining two halves', () => {
      // (4, 2) is the only way through. An NPC there cuts the map in two.
      const result = planNpcPlacement(corridor, { count: 40, seed: 1 });
      const used = new Set(result.placed.map((s) => `${s.x},${s.y}`));
      expect(used.has('4,2')).toBe(false);
      expect(result.rejected).toBeGreaterThan(0);
    });

    it('keeps everything reachable after every placement, across many seeds', () => {
      // The guarantee that matters: an NPC blocks its tile, so a bad one makes
      // part of the map silently unreachable with nothing to show why.
      for (let seed = 1; seed <= 20; seed++) {
        const result = planNpcPlacement(corridor, { count: 12, seed });
        const reference = { x: 1, y: 1 };
        const walkable = corridor.flat().filter(Boolean).length;
        const reachable = countReachable(corridor, result.placed, reference);
        expect(reachable, `seed ${seed}`).toBe(walkable - result.placed.length);
      }
    });

    it('measures connectivity from the given reference tile', () => {
      const result = planNpcPlacement(corridor, {
        count: 12, seed: 5, reference: { x: 7, y: 3 },
      });
      const walkable = corridor.flat().filter(Boolean).length;
      expect(countReachable(corridor, result.placed, { x: 7, y: 3 }))
        .toBe(walkable - result.placed.length);
    });

    it('reports running out rather than forcing a placement', () => {
      // A three-tile dead end: the two inner tiles cannot both be filled.
      const alley = grid([
        '#####',
        '#...#',
        '###.#',
        '###.#',
        '#####',
      ]);
      const result = planNpcPlacement(alley, { count: 10, seed: 1 });
      expect(result.ranOut).toBe(true);
      const walkable = alley.flat().filter(Boolean).length;
      expect(countReachable(alley, result.placed, { x: 1, y: 1 }))
        .toBe(walkable - result.placed.length);
    });
  });

  it('places nobody when asked for nobody', () => {
    expect(planNpcPlacement(open, { count: 0, seed: 1 }).placed).toEqual([]);
  });

  it('places nobody on a map with no walkable ground', () => {
    const solid = grid(['####', '####']);
    const result = planNpcPlacement(solid, { count: 3, seed: 1 });
    expect(result.placed).toEqual([]);
    expect(result.ranOut).toBe(true);
  });
});

describe('placement respects directional passability', () => {
  /**
   * The interior case, reduced: a strip of tiles beside the floor that is
   * standable but that nothing can step onto. A room's wall top is exactly
   * this — passable *along itself*, so it looks walkable and sits right next to
   * the floor, yet the player can never get on it.
   *
   * Plain adjacency thinks the two are one area and happily puts an NPC up on
   * the wall, which is what the first version of this did.
   */
  const room = grid([
    '....',   // row 0: the "wall top" — standable, but sealed off
    '....',   // row 1: floor
    '....',
  ]);

  /** Nothing may step between row 0 and row 1. */
  const canStep = (ax: number, ay: number, bx: number, by: number) =>
    !((ay === 0 && by === 1) || (ay === 1 && by === 0));

  it('never places on a strip the player cannot step onto', () => {
    const result = planNpcPlacement(room, {
      count: 20, seed: 1, reference: { x: 0, y: 1 }, canStep,
    });
    expect(result.placed.length).toBeGreaterThan(0);
    for (const slot of result.placed) {
      expect(slot.y, `placed on the sealed strip at ${slot.x},${slot.y}`).not.toBe(0);
    }
  });

  it('still keeps the reachable area connected', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const result = planNpcPlacement(room, {
        count: 4, seed, reference: { x: 0, y: 1 }, canStep,
      });
      // rows 1-2 are the reachable area: 8 tiles
      const blocked = new Set(result.placed.map((s) => `${s.x},${s.y}`));
      const seen = new Set(['0,1']);
      const stack = [{ x: 0, y: 1 }];
      let n = 0;
      while (stack.length > 0) {
        const { x, y } = stack.pop()!;
        n++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (ny < 0 || nx < 0 || ny > 2 || nx > 3) continue;
          if (blocked.has(`${nx},${ny}`) || seen.has(`${nx},${ny}`)) continue;
          if (!canStep(x, y, nx, ny)) continue;
          seen.add(`${nx},${ny}`);
          stack.push({ x: nx, y: ny });
        }
      }
      expect(n, `seed ${seed}`).toBe(8 - result.placed.length);
    }
  });

  it('defaults to plain adjacency, which is documented as not the engine rule', () => {
    // Without canStep the sealed strip is fair game — the default is a
    // convenience for callers with no map, not a model of the engine.
    const result = planNpcPlacement(room, { count: 12, seed: 1, reference: { x: 0, y: 1 } });
    expect(result.placed.some((s) => s.y === 0)).toBe(true);
  });
});

describe('planNpcPlacement allow list', () => {
  /**
   * `allow` narrows *where* an NPC may be put; it must not narrow what the
   * connectivity check looks at. A caller that knows its map's structure —
   * `generate_town`, which planned the streets — needs both halves of that, or
   * a villager listed as allowed can still seal off a tile that was not.
   */
  const open = grid([
    '##########',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '##########',
  ]);

  it('places only on the listed tiles', () => {
    const allow = [
      { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 2 }, { x: 5, y: 2 },
    ];
    const result = planNpcPlacement(open, { count: 4, seed: 3, allow });
    expect(result.placed).toHaveLength(4);
    for (const slot of result.placed) {
      expect(allow.some((a) => a.x === slot.x && a.y === slot.y)).toBe(true);
    }
  });

  it('runs out when the list is shorter than the count, rather than spilling', () => {
    const result = planNpcPlacement(open, {
      count: 6,
      seed: 1,
      allow: [{ x: 2, y: 2 }, { x: 3, y: 2 }],
    });
    expect(result.placed).toHaveLength(2);
    expect(result.ranOut).toBe(true);
  });

  it('still refuses a listed tile that would seal something off', () => {
    // A corridor with one room at each end: (3, 2) is the only way through, so
    // listing it as allowed must not make it placeable.
    const pinch = grid([
      '#####',
      '#...#',
      '#.#.#',
      '#...#',
      '#####',
    ]);
    // Blocking (1,2) and (3,2) both would cut the map in two; blocking either
    // alone leaves it whole, so ask for both and expect only one to land.
    const result = planNpcPlacement(pinch, {
      count: 2,
      seed: 1,
      allow: [{ x: 1, y: 2 }, { x: 3, y: 2 }],
      reference: { x: 1, y: 1 },
    });
    expect(result.placed).toHaveLength(1);
    expect(result.rejected).toBe(1);
  });

  it('ignores a listed tile that is not reachable at all', () => {
    const result = planNpcPlacement(open, {
      count: 2,
      seed: 1,
      allow: [{ x: 0, y: 0 }, { x: 2, y: 2 }],
    });
    expect(result.placed).toEqual([{ x: 2, y: 2 }]);
  });

  it('considers everything reachable when no list is given', () => {
    const result = planNpcPlacement(open, { count: 30, seed: 1 });
    expect(result.placed.length).toBeGreaterThan(4);
  });
});

describe('situationalLine', () => {
  const place = 'Riverside';

  it('names the place it was given', () => {
    const line = situationalLine(0, { x: 5, y: 5 }, { place, onStreet: true });
    expect(line).toContain(place);
  });

  it('draws from a different pool on the street than off it', () => {
    const street = new Set<string>();
    const ground = new Set<string>();
    for (let i = 0; i < 12; i++) {
      street.add(situationalLine(i, { x: 0, y: 0 }, { place, onStreet: true }));
      ground.add(situationalLine(i, { x: 0, y: 0 }, { place, onStreet: false }));
    }
    // Every one of the 6 openings in each pool gets a turn over 12 picks...
    expect(street.size).toBe(6);
    expect(ground.size).toBe(6);
    // ...and the two pools do not share a line.
    for (const line of street) expect(ground.has(line)).toBe(false);
  });

  it('two NPCs in different spots do not say the same thing', () => {
    const landmark = { label: 'The shop', at: { x: 20, y: 20 } };
    const a = situationalLine(0, { x: 5, y: 5 }, { place, onStreet: true, landmark });
    const b = situationalLine(1, { x: 5, y: 30 }, { place, onStreet: true, landmark });
    expect(a).not.toBe(b);
  });

  it('names a real direction and distance, not an invented one', () => {
    const landmark = { label: 'The well', at: { x: 30, y: 5 } };
    const line = situationalLine(0, { x: 5, y: 5 }, { place, onStreet: false, landmark });
    expect(line).toContain('The well is a long way to the east');
  });

  it('drops the landmark clause when it is right where the NPC stands', () => {
    const landmark = { label: 'The shop', at: { x: 5, y: 5 } };
    const line = situationalLine(0, { x: 5, y: 5 }, { place, onStreet: false, landmark });
    expect(line).not.toContain('shop');
  });

  it('is reproducible: same pick, same line', () => {
    const landmark = { label: 'The shop', at: { x: 20, y: 5 } };
    const a = situationalLine(4, { x: 5, y: 5 }, { place, onStreet: true, landmark });
    const b = situationalLine(4, { x: 5, y: 5 }, { place, onStreet: true, landmark });
    expect(a).toBe(b);
  });

  it('still wraps once fed through dialogueCommands', () => {
    const landmark = { label: 'The shop', at: { x: 60, y: 5 } };
    const line = situationalLine(0, { x: 5, y: 5 }, { place: 'Riverside', onStreet: true, landmark });
    const commands = dialogueCommands(line);
    for (const c of commands) {
      if (c.code === 401) expect(String(c.parameters[0]).length).toBeLessThanOrEqual(DEFAULT_WRAP_WIDTH);
    }
  });
});
