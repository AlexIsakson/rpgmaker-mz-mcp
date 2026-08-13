import { describe, it, expect } from 'vitest';
import {
  lockConditionParameters,
  conditionalBranch,
  consumeKeyCommand,
  lockedDoorPages,
  lockedDoorEvent,
  describeLock,
  indentBy,
  LockedDoorError,
} from '../../src/core/locked-door.js';
import type { EventCommand } from '../../src/schemas/event.js';

/**
 * The branch encoding is asserted against `Game_Interpreter.command111` and
 * `skipBranch` in the corescript. The *shape* of a locked door — a branch whose
 * else says the door is locked — rests on a single measured event
 * (`Wicked Heart` map 13, event 18), which is why only its structure is pinned
 * here and none of the wording is.
 */

const codes = (list: EventCommand[]) => list.map((c) => c.code);
const shape = (list: EventCommand[]) => list.map((c) => `${c.code}@${c.indent}`);

describe('lockConditionParameters', () => {
  it('gives an item branch two parameters and no includeEquip', () => {
    // case 8: hasItem($dataItems[params[1]]) — an item cannot be equipped, so
    // the engine never reads a third parameter here.
    expect(lockConditionParameters({ kind: 'item', dataId: 35 })).toEqual([8, 35]);
    expect(lockConditionParameters({ kind: 'item', dataId: 35, includeEquip: true })).toEqual([
      8, 35,
    ]);
  });

  it('passes includeEquip to weapon and armour branches', () => {
    // cases 9 and 10: hasItem($dataWeapons[params[1]], params[2]).
    expect(lockConditionParameters({ kind: 'weapon', dataId: 3 })).toEqual([9, 3, false]);
    expect(lockConditionParameters({ kind: 'armor', dataId: 4, includeEquip: true })).toEqual([
      10, 4, true,
    ]);
  });

  it('tests a switch for ON', () => {
    // case 0: $gameSwitches.value(params[1]) === (params[2] === 0).
    expect(lockConditionParameters({ kind: 'switch', dataId: 12 })).toEqual([0, 12, 0]);
  });

  it('refuses id 0 and non-integers', () => {
    expect(() => lockConditionParameters({ kind: 'item', dataId: 0 })).toThrow(LockedDoorError);
    expect(() => lockConditionParameters({ kind: 'switch', dataId: 0 })).toThrow(LockedDoorError);
    expect(() => lockConditionParameters({ kind: 'item', dataId: 1.5 })).toThrow(LockedDoorError);
  });
});

describe('conditionalBranch', () => {
  const body = (code: number): EventCommand[] => [{ code, indent: 0, parameters: [] }];

  it('matches the shape every measured branch has', () => {
    // 111, body one deeper, a 0 closing the body, 411, else body, 0, 412 —
    // exactly the run in Wicked Heart map 13 event 18.
    const list = conditionalBranch([8, 35], body(250), body(101));
    expect(shape(list)).toEqual([
      '111@0',
      '250@1',
      '0@1',
      '411@0',
      '101@1',
      '0@1',
      '412@0',
    ]);
  });

  it('omits the else entirely when there is no else body', () => {
    expect(shape(conditionalBranch([0, 3, 0], body(121)))).toEqual(['111@0', '121@1', '0@1', '412@0']);
  });

  it('nests, keeping every body one deeper than its own branch', () => {
    const inner = conditionalBranch([0, 2, 0], body(121));
    const list = conditionalBranch([0, 1, 0], inner);
    expect(shape(list)).toEqual([
      '111@0',
      '111@1',
      '121@2',
      '0@2',
      '412@1',
      '0@1',
      '412@0',
    ]);
  });

  it('starts where it is told to, for a branch already inside one', () => {
    const list = conditionalBranch([0, 1, 0], body(121), [], 2);
    expect(shape(list)).toEqual(['111@2', '121@3', '0@3', '412@2']);
  });
});

describe('indentBy', () => {
  it('returns the same array when there is nothing to shift', () => {
    const list: EventCommand[] = [{ code: 250, indent: 0, parameters: [] }];
    expect(indentBy(list, 0)).toBe(list);
  });

  it('never mutates its input', () => {
    const list: EventCommand[] = [{ code: 250, indent: 0, parameters: [] }];
    indentBy(list, 3);
    expect(list[0].indent).toBe(0);
  });
});

describe('consumeKeyCommand', () => {
  it('loses one of the key from the right database', () => {
    // operateValue(operation, operandType, operand): operation 1 negates.
    expect(consumeKeyCommand({ kind: 'item', dataId: 35 })).toEqual({
      code: 126,
      indent: 0,
      parameters: [35, 1, 0, 1],
    });
    expect(consumeKeyCommand({ kind: 'weapon', dataId: 3 }).code).toBe(127);
    expect(consumeKeyCommand({ kind: 'armor', dataId: 3 }).code).toBe(128);
  });

  it('carries includeEquip on equipment, where losing can strip a slot', () => {
    expect(consumeKeyCommand({ kind: 'armor', dataId: 3, includeEquip: true }).parameters).toEqual([
      3, 1, 0, 1, true,
    ]);
  });

  it('refuses a switch, which has no key', () => {
    expect(() => consumeKeyCommand({ kind: 'switch', dataId: 1 })).toThrow(LockedDoorError);
  });
});

describe('lockedDoorPages', () => {
  const lock = { kind: 'item' as const, dataId: 35 };

  it('asks on Action Button, unlike an ordinary door', () => {
    // Player Touch would announce the lock every time the player brushed past.
    const [asking] = lockedDoorPages({ lock });
    expect(asking.trigger).toBe(0);
    expect(asking.priorityType).toBe(1);
    expect(asking.image.characterName).toBe('!Door1');
  });

  it('puts the conditioned page last, where findProperPageIndex will see it', () => {
    // The engine scans pages backwards and takes the first match, so a page
    // conditioned on the self switch only wins if it comes after the plain one.
    const pages = lockedDoorPages({ lock });
    expect(pages).toHaveLength(2);
    expect(pages[0].conditions.selfSwitchValid).toBe(false);
    expect(pages[1].conditions.selfSwitchValid).toBe(true);
    expect(pages[1].conditions.selfSwitchCh).toBe('A');
  });

  it('leaves the unlocked page an ordinary Player Touch door', () => {
    const [, opened] = lockedDoorPages({ lock, target: { mapId: 4, x: 8, y: 9 } });
    expect(opened.trigger).toBe(1);
    expect(codes(opened.list)).toContain(201);
    expect(opened.list.some((c) => c.code === 111)).toBe(false);
  });

  it('is one page when it should not remember', () => {
    const pages = lockedDoorPages({ lock, remember: false });
    expect(pages).toHaveLength(1);
    expect(pages[0].list.some((c) => c.code === 123)).toBe(false);
  });

  it('writes the self switch before the transfer, which nothing survives', () => {
    // Game_Map.setup rebuilds _events on a transfer, taking the running
    // interpreter with it — a 123 after the 201 would never run.
    const [asking] = lockedDoorPages({ lock, target: { mapId: 4, x: 8, y: 9 } });
    const list = asking.list;
    const selfSwitch = list.findIndex((c) => c.code === 123);
    const transfer = list.findIndex((c) => c.code === 201);
    expect(selfSwitch).toBeGreaterThan(-1);
    expect(transfer).toBeGreaterThan(selfSwitch);
    // and the transfer is the last thing in the branch body
    expect(list[transfer + 1].code).toBe(0);
    expect(list[transfer + 1].indent).toBe(1);
  });

  it('opens the door before writing anything, so no route is interrupted', () => {
    const [asking] = lockedDoorPages({ lock });
    const list = asking.list;
    const lastRoute = list.map((c) => c.code).lastIndexOf(205);
    const selfSwitch = list.findIndex((c) => c.code === 123);
    expect(lastRoute).toBeGreaterThan(-1);
    expect(selfSwitch).toBeGreaterThan(lastRoute);
  });

  it('says the door is locked in the else branch, at the branch indent', () => {
    const [asking] = lockedDoorPages({ lock, lockedText: 'The gate holds fast.' });
    const list = asking.list;
    const elseAt = list.findIndex((c) => c.code === 411);
    expect(elseAt).toBeGreaterThan(-1);
    const after = list.slice(elseAt + 1);
    const body = after.slice(0, after.findIndex((c) => c.code === 412));
    expect(codes(body)).toEqual([250, 101, 401, 0]);
    expect(body.every((c) => c.indent === 1)).toBe(true);
    expect(body[2].parameters[0]).toBe('The gate holds fast.');
  });

  it('rattles with the door\'s own SE unless told otherwise', () => {
    // The one measured locked door plays the same SE in both branches.
    const [asking] = lockedDoorPages({ lock, openSe: 'Door6' });
    const ses = asking.list.filter((c) => c.code === 250);
    expect((ses[0].parameters[0] as { name: string }).name).toBe('Door6');
    expect((ses[ses.length - 1].parameters[0] as { name: string }).name).toBe('Door6');

    const [refusing] = lockedDoorPages({ lock, openSe: 'Open1', lockedSe: 'Buzzer1' });
    const refuseSe = refusing.list.filter((c) => c.code === 250).pop()!;
    expect((refuseSe.parameters[0] as { name: string }).name).toBe('Buzzer1');
  });

  it('only takes the key when asked to', () => {
    const [kept] = lockedDoorPages({ lock });
    expect(kept.list.some((c) => c.code === 126)).toBe(false);

    const [taken] = lockedDoorPages({ lock, consumeKey: true });
    const lose = taken.list.find((c) => c.code === 126)!;
    expect(lose.parameters).toEqual([35, 1, 0, 1]);
    expect(lose.indent).toBe(1);
  });

  it('ignores consumeKey on a switch lock, which has no key', () => {
    const [asking] = lockedDoorPages({ lock: { kind: 'switch', dataId: 12 }, consumeKey: true });
    expect(asking.list.some((c) => [126, 127, 128].includes(c.code))).toBe(false);
    expect(asking.list[0].parameters).toEqual([0, 12, 0]);
  });

  it('ends the page list at indent 0, so skipBranch always has somewhere to stop', () => {
    const [asking] = lockedDoorPages({ lock, target: { mapId: 2, x: 1, y: 1 } });
    const last = asking.list[asking.list.length - 1];
    expect(last.code).toBe(0);
    expect(last.indent).toBe(0);
  });
});

describe('lockedDoorEvent', () => {
  it('names itself after its id when nothing else is given', () => {
    const event = lockedDoorEvent(4, 10, 6, { lock: { kind: 'item', dataId: 35 } });
    expect(event).toMatchObject({ id: 4, name: 'LockedDoor4', x: 10, y: 6 });
    expect(event.pages).toHaveLength(2);
  });
});

describe('describeLock', () => {
  it('says what is being tested, with the name when there is one', () => {
    expect(describeLock({ kind: 'switch', dataId: 12 }, 'Gate open')).toBe(
      'switch 12 ("Gate open") being ON'
    );
    expect(describeLock({ kind: 'item', dataId: 35 }, 'Inn Key')).toBe(
      'the party holding item 35 ("Inn Key")'
    );
    expect(describeLock({ kind: 'weapon', dataId: 3, includeEquip: true })).toContain(
      'equipped or not'
    );
  });
});
