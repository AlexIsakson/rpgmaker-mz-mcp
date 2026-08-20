import { describe, it, expect } from 'vitest';
import {
  climaxGuardPages,
  climaxGuardEvent,
  ClimaxError,
  DEFAULT_GUARD_SHEET,
} from '../../src/core/dungeon-climax.js';
import { walkCommands } from '../../src/core/command-nesting.js';
import type { EventCommand } from '../../src/schemas/event.js';

const codes = (list: EventCommand[]) => list.map((c) => c.code);
const shape = (list: EventCommand[]) => list.map((c) => `${c.code}@${c.indent}`);

describe('climaxGuardPages', () => {
  it('refuses a non-positive or fractional troop id', () => {
    expect(() => climaxGuardPages({ troopId: 0 })).toThrow(ClimaxError);
    expect(() => climaxGuardPages({ troopId: -1 })).toThrow(ClimaxError);
    expect(() => climaxGuardPages({ troopId: 1.5 })).toThrow(ClimaxError);
  });

  it('matches the block shape command-nesting.ts computes for an armed battle with only a win arm', () => {
    // 301 (battle), 601 (if win), 123 one level in, the corpus's own blank
    // line at the body's own indent, 604 (end battle), 0 (list terminator).
    const [guarding] = climaxGuardPages({ troopId: 5 });
    expect(shape(guarding.list)).toEqual(['301@0', '601@0', '123@1', '0@1', '604@0', '0@0']);
  });

  it('puts designation 0 (direct troop) and the troop id in the battle command', () => {
    const [guarding] = climaxGuardPages({ troopId: 7, canEscape: true, canLose: true });
    const battle = guarding.list.find((c) => c.code === 301)!;
    expect(battle.parameters).toEqual([0, 7, true, true]);
  });

  it('defaults canEscape and canLose to false', () => {
    const [guarding] = climaxGuardPages({ troopId: 7 });
    const battle = guarding.list.find((c) => c.code === 301)!;
    expect(battle.parameters).toEqual([0, 7, false, false]);
  });

  it('sets the given self switch ON, not any other value', () => {
    const [guarding] = climaxGuardPages({ troopId: 1, selfSwitch: 'C' });
    const flip = guarding.list.find((c) => c.code === 123)!;
    // [self switch, value (0 = ON)]
    expect(flip.parameters).toEqual(['C', 0]);
  });

  it('prepends the challenge text, when given, before the battle', () => {
    const withText = climaxGuardPages({ troopId: 1, challengeText: 'Turn back.' })[0];
    expect(codes(withText.list).slice(0, 2)).toEqual([101, 401]);
    expect(withText.list[1].parameters).toEqual(['Turn back.']);

    const withoutText = climaxGuardPages({ troopId: 1 })[0];
    expect(codes(withoutText.list)[0]).toBe(301);
  });

  it('opens the way through only on a win, verified against the engine walk', () => {
    // A port of Game_Interpreter's own walk, not a restatement of this
    // module — see command-nesting.ts's walkCommands.
    const [guarding] = climaxGuardPages({ troopId: 9, selfSwitch: 'B' });
    const list = guarding.list;
    const selfSwitchIndex = list.findIndex((c) => c.code === 123);

    expect(walkCommands(list, { battles: [0] })).toContain(selfSwitchIndex);
    // Escape and loss leave _branch[_indent] at 1 or 2; 601 skips its body
    // unless the result was 0.
    expect(walkCommands(list, { battles: [1] })).not.toContain(selfSwitchIndex);
    expect(walkCommands(list, { battles: [2] })).not.toContain(selfSwitchIndex);
    // null stands for command301 never installing the callback at all — a
    // missing troop, command-nesting.ts's own WalkDecisions convention.
    expect(walkCommands(list, { battles: [null] })).not.toContain(selfSwitchIndex);
  });

  it('has a second page gated on the self switch, ordered after the first', () => {
    const [guarding, beaten] = climaxGuardPages({ troopId: 1, selfSwitch: 'D' });
    expect(guarding.conditions.selfSwitchValid).toBe(false);
    expect(beaten.conditions.selfSwitchValid).toBe(true);
    expect(beaten.conditions.selfSwitchCh).toBe('D');
  });

  it('blocks its tile while guarding and lets the player through once beaten', () => {
    const [guarding, beaten] = climaxGuardPages({ troopId: 1 });
    expect(guarding.priorityType).toBe(1);
    expect(guarding.through).toBe(false);
    expect(beaten.priorityType).toBe(0);
    expect(beaten.through).toBe(true);
  });

  it('is Action Button, not Player Touch', () => {
    const [guarding] = climaxGuardPages({ troopId: 1 });
    expect(guarding.trigger).toBe(0);
  });

  it('defaults to the RTP\'s single-frame monster sheet', () => {
    const [guarding] = climaxGuardPages({ troopId: 1 });
    expect(guarding.image.characterName).toBe(DEFAULT_GUARD_SHEET);
    expect(guarding.image.characterIndex).toBe(0);
  });
});

describe('climaxGuardEvent', () => {
  it('names itself and carries the pages through', () => {
    const event = climaxGuardEvent(4, 10, 12, { troopId: 2 });
    expect(event.id).toBe(4);
    expect(event.x).toBe(10);
    expect(event.y).toBe(12);
    expect(event.name).toBe('Guardian4');
    expect(event.pages).toHaveLength(2);
  });

  it('takes a caller-given name', () => {
    const event = climaxGuardEvent(4, 0, 0, { troopId: 2, name: 'FloorBoss' });
    expect(event.name).toBe('FloorBoss');
  });
});
