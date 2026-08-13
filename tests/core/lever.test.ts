import { describe, it, expect } from 'vitest';
import {
  setSwitchCommand,
  leverPages,
  leverEvent,
  LEVER_RESTING_DIRECTION,
  LEVER_THROWN_DIRECTION,
  LeverError,
} from '../../src/core/lever.js';
import { readLock } from '../../src/core/locked-door.js';

/**
 * Nothing in the corpus is a lever — of 422 events, the 38 pages that set a
 * switch are cutscenes, autoruns and NPCs — so what is pinned here is the
 * engine's part (`command121`, `Game_Event.start` → `lock()` → `turnTowardPlayer`,
 * `findProperPageIndex`) and the sprite layout measured off `!Switch1` and
 * `!Switch2`, whose four direction rows are four frames of one movement.
 */

const codes = (list: { code: number }[]) => list.map((c) => c.code);

describe('setSwitchCommand', () => {
  it('writes a range of one, the way the editor does', () => {
    // command121 loops params[0]..params[1] and sets each to params[2] === 0.
    expect(setSwitchCommand(12, true)).toEqual({
      code: 121,
      indent: 0,
      parameters: [12, 12, 0],
    });
  });

  it('uses 1 for off', () => {
    expect(setSwitchCommand(12, false).parameters).toEqual([12, 12, 1]);
  });

  it('refuses switch 0, which setValue can never write', () => {
    expect(() => setSwitchCommand(0, true)).toThrow(LeverError);
    expect(() => setSwitchCommand(-3, true)).toThrow(LeverError);
  });
});

describe('leverPages', () => {
  const options = { switchId: 12 };

  it('is an Action Button object that blocks its tile', () => {
    const [resting] = leverPages(options);
    expect(resting.trigger).toBe(0);
    expect(resting.priorityType).toBe(1);
    expect(resting.image.characterName).toBe('!Switch1');
  });

  it('fixes its direction, because the direction axis is the state', () => {
    // Game_Event.start calls lock() for triggers 0/1/2 and lock() calls
    // turnTowardPlayer, so without this the lever changes frame the moment it
    // is used. setDirection is a no-op while directionFix is set.
    for (const page of leverPages(options)) expect(page.directionFix).toBe(true);
  });

  it('shows the resting frame first and the thrown frame when the switch is on', () => {
    const [resting, thrown] = leverPages(options);
    expect(resting.image.direction).toBe(LEVER_RESTING_DIRECTION);
    expect(thrown.image.direction).toBe(LEVER_THROWN_DIRECTION);
  });

  it('gates the thrown page on the switch itself, not a self switch', () => {
    // A lever is the flag's display: if anything else turns the switch off it
    // must spring back, which a self switch would prevent forever.
    const [resting, thrown] = leverPages(options);
    expect(resting.conditions.switch1Valid).toBe(false);
    expect(thrown.conditions).toMatchObject({ switch1Valid: true, switch1Id: 12 });
    expect(thrown.conditions.selfSwitchValid).toBe(false);
  });

  it('puts the conditioned page last, where findProperPageIndex will see it', () => {
    const pages = leverPages(options);
    expect(pages).toHaveLength(2);
    expect(pages[1].conditions.switch1Valid).toBe(true);
  });

  it('turns the switch on, with a sound', () => {
    const [resting] = leverPages(options);
    expect(codes(resting.list)).toEqual([250, 121, 0]);
    expect(resting.list[1].parameters).toEqual([12, 12, 0]);
  });

  it('says its line after throwing, which the interpreter still runs', () => {
    // The interpreter keeps its own reference to the list (`this._list = list`),
    // so the page change the switch triggers cannot truncate the run.
    const [resting] = leverPages({ ...options, text: 'Something shifts below.' });
    expect(codes(resting.list)).toEqual([250, 121, 101, 401, 0]);
    expect(resting.list[3].parameters[0]).toBe('Something shifts below.');
  });

  it('is one-way by default: the thrown page does nothing at all', () => {
    const [, thrown] = leverPages(options);
    expect(codes(thrown.list)).toEqual([0]);
    // Game_Event.start needs list.length > 1, so this page never even starts.
    expect(thrown.list).toHaveLength(1);
  });

  it('turns the switch back off when it is a toggle', () => {
    const [, thrown] = leverPages({ ...options, toggle: true, offText: 'It grinds shut.' });
    expect(codes(thrown.list)).toEqual([250, 121, 101, 401, 0]);
    expect(thrown.list[1].parameters).toEqual([12, 12, 1]);
  });

  it('takes a different sprite and slot', () => {
    // !Switch1 slot 4 is a floor button; !Switch2 slot 0 a wall lever.
    const [resting] = leverPages({ ...options, characterName: '!Switch2', characterIndex: 0 });
    expect(resting.image.characterName).toBe('!Switch2');
  });

  it('refuses a switch id the engine could never write', () => {
    expect(() => leverPages({ switchId: 0 })).toThrow(LeverError);
  });

  it('is not itself a lock', () => {
    // place_lever scans the project with readLock to find the doors a switch
    // opens. A lever gates on a page condition rather than a branch, so it
    // cannot turn up in its own list of doors.
    expect(readLock(leverPages(options))).toBeNull();
  });
});

describe('leverEvent', () => {
  it('names itself after its id when nothing else is given', () => {
    const event = leverEvent(3, 7, 4, { switchId: 12 });
    expect(event).toMatchObject({ id: 3, name: 'Lever3', x: 7, y: 4 });
    expect(event.pages).toHaveLength(2);
  });
});
