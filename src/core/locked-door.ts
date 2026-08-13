import { doorEventPage, doorOpenCommands, doorTransferCommands, type DoorTarget } from './blueprint.js';
import type { EventCommand, EventPage, Event } from '../schemas/event.js';

/**
 * Doors that ask for something first.
 *
 * This is the smallest piece of game logic that needs all three of the things
 * the generators have never had: a condition, a second page, and a memory of
 * what the player already did.
 *
 * **The sample is one event.** Across every project on hand there is exactly one
 * locked door — `Wicked Heart` map 13, event 18 — and its shape is:
 *
 * ```
 * 111 [8, 35]     conditional branch: party has item 35 ("Inn Key")
 *   250           play SE
 *   117           call the common event that swings the door open
 *   0
 * 411             else
 *   250           play SE — the same one
 *   101/401       "Locked."
 *   0
 * 412
 * 0
 * ```
 *
 * One event settles nothing on its own, and this module says so rather than
 * dressing a single sample up as a convention. What it *does* show is which of
 * the two mechanisms the engine offers gets used, and there the corpus is not
 * thin at all: **`itemValid` — the engine's own "this page needs an item" page
 * condition — is used on 0 of 544 event pages**, while conditional branches on
 * an item appear 4 times and switch page conditions 59 times. So an item lock is
 * a branch, and a switch lock can be either.
 *
 * Three things about the branch itself are settled exactly, by the interpreter:
 *
 *  - **The parameter shape differs per database.** `command111` case 8 is
 *    `hasItem($dataItems[params[1]])` with no third parameter, but cases 9 and 10
 *    pass `params[2]` to `hasItem` as `includeEquip` — so a weapon lock can
 *    accept the key while it is equipped and an item lock has no such option.
 *  - **A branch body ends with a `0` at the body's own indent.** All 32 branches
 *    measured across the projects do this, and `skipBranch` walks purely by
 *    indent (`while (this._list[this._index + 1].indent > this._indent)`), so a
 *    body written flat is a body the engine runs unconditionally.
 *  - **Nothing may follow a transfer**, because `Game_Map.setup` rebuilds the
 *    event list and the running interpreter goes with it. The self switch that
 *    remembers the door is open is therefore written *before* the transfer, not
 *    after it the way a chest writes its own.
 *
 * And the second page goes last on purpose: `Game_Event.findProperPageIndex`
 * scans `for (let i = pages.length - 1; i >= 0; i--)` and takes the first page
 * whose conditions are met, so a conditioned page only ever wins if it sits
 * after the plain one.
 *
 * This module is pure — it builds events, and never reads a file.
 */

const CODE_CONDITIONAL_BRANCH = 111;
const CODE_ELSE = 411;
const CODE_END_BRANCH = 412;
const CODE_SHOW_TEXT = 101;
const CODE_SHOW_TEXT_BODY = 401;
const CODE_PLAY_SE = 250;
const CODE_CHANGE_ITEMS = 126;
const CODE_CHANGE_WEAPONS = 127;
const CODE_CHANGE_ARMORS = 128;
const CODE_SELF_SWITCH = 123;
const CODE_END = 0;

/** `Game_Interpreter.operateValue`: 0 gains, 1 loses. */
const OPERATION_LOSE = 1;
const OPERAND_CONSTANT = 0;

/** `command111` case numbers. */
const BRANCH_SWITCH = 0;
const BRANCH_ITEM = 8;
const BRANCH_WEAPON = 9;
const BRANCH_ARMOR = 10;

/** `$gameSwitches.value(id) === (params[2] === 0)`, so 0 tests for ON. */
const SWITCH_IS_ON = 0;

export const LOCK_KINDS = ['item', 'weapon', 'armor', 'switch'] as const;
export type LockKind = (typeof LOCK_KINDS)[number];

export interface Lock {
  kind: LockKind;
  /** Database id of the key, or the switch id for a `switch` lock. */
  dataId: number;
  /**
   * Whether a key a party member is wearing counts. Weapons and armours only:
   * `command111` passes `params[2]` straight to `hasItem`, and case 8 (item)
   * has no such parameter because an item cannot be equipped.
   */
  includeEquip?: boolean;
}

export class LockedDoorError extends Error {}

/** The parameters of the `111` that tests this lock. */
export function lockConditionParameters(lock: Lock): unknown[] {
  if (!Number.isInteger(lock.dataId) || lock.dataId < 1) {
    throw new LockedDoorError(
      `${lock.kind} ${lock.dataId} is not a usable id. Database ids start at 1 (index 0 of ` +
        'every database file is null), and switch 0 does not exist either — ' +
        '`Game_Switches.setValue` is guarded by `switchId > 0`.'
    );
  }

  switch (lock.kind) {
    case 'item':
      // case 8 is `hasItem($dataItems[params[1]])` — two parameters, no more.
      return [BRANCH_ITEM, lock.dataId];
    case 'weapon':
      return [BRANCH_WEAPON, lock.dataId, lock.includeEquip ?? false];
    case 'armor':
      return [BRANCH_ARMOR, lock.dataId, lock.includeEquip ?? false];
    case 'switch':
      return [BRANCH_SWITCH, lock.dataId, SWITCH_IS_ON];
  }
}

/** Shift a run of commands into an enclosing branch. */
export function indentBy(commands: EventCommand[], by: number): EventCommand[] {
  return by === 0 ? commands : commands.map((c) => ({ ...c, indent: c.indent + by }));
}

/**
 * A conditional branch around two bodies.
 *
 * The trailing `0` on each body is not decoration: it is what all 32 measured
 * branches write, and it is the marker the editor reads back as "end of this
 * branch". The `411` and `412` sit at the branch's own indent while the bodies
 * sit one deeper, which is the only thing `skipBranch` actually looks at.
 *
 * An empty `elseBody` emits no `411` at all — the engine's own "no else" shape,
 * used by 23 of the 32.
 */
export function conditionalBranch(
  parameters: unknown[],
  thenBody: EventCommand[],
  elseBody: EventCommand[] = [],
  indent = 0
): EventCommand[] {
  const inner = indent + 1;
  const out: EventCommand[] = [
    { code: CODE_CONDITIONAL_BRANCH, indent, parameters },
    ...indentBy(thenBody, inner),
    { code: CODE_END, indent: inner, parameters: [] },
  ];

  if (elseBody.length > 0) {
    out.push(
      { code: CODE_ELSE, indent, parameters: [] },
      ...indentBy(elseBody, inner),
      { code: CODE_END, indent: inner, parameters: [] }
    );
  }

  out.push({ code: CODE_END_BRANCH, indent, parameters: [] });
  return out;
}

/** The command that takes the key off the player. */
export function consumeKeyCommand(lock: Lock, amount = 1): EventCommand {
  if (lock.kind === 'switch') {
    throw new LockedDoorError('A switch lock has no key to consume.');
  }
  const base = [lock.dataId, OPERATION_LOSE, OPERAND_CONSTANT, amount];
  switch (lock.kind) {
    case 'item':
      return { code: CODE_CHANGE_ITEMS, indent: 0, parameters: base };
    case 'weapon':
      // `includeEquip` on a *loss* lets gainItem strip the key off whoever is
      // holding it, which is the only place the flag does anything.
      return { code: CODE_CHANGE_WEAPONS, indent: 0, parameters: [...base, lock.includeEquip ?? false] };
    case 'armor':
      return { code: CODE_CHANGE_ARMORS, indent: 0, parameters: [...base, lock.includeEquip ?? false] };
  }
}

function textCommands(text: string, speaker = ''): EventCommand[] {
  if (text.trim() === '') return [];
  return [
    // [faceName, faceIndex, background (0 = window), position (2 = bottom), speaker]
    { code: CODE_SHOW_TEXT, indent: 0, parameters: ['', 0, 0, 2, speaker] },
    { code: CODE_SHOW_TEXT_BODY, indent: 0, parameters: [text] },
  ];
}

function audio(name: string) {
  return { name, volume: 90, pitch: 100, pan: 0 };
}

export interface LockedDoorOptions {
  lock: Lock;
  /** Where the door leads. Omit for a door that opens onto the same map. */
  target?: DoorTarget;
  characterName?: string;
  characterIndex?: number;
  /** What the player is told when they do not have it. */
  lockedText?: string;
  /** Said once, on the way through. The measured door says nothing here. */
  unlockText?: string;
  openSe?: string;
  moveSe?: string;
  /**
   * Played when the door refuses.
   *
   * Defaults to the same SE the door opens with, which is what the one measured
   * locked door does — it plays `Door6` in both branches, a rattle rather than a
   * verdict. It is a parameter because one event cannot settle it.
   */
  lockedSe?: string;
  /** Take the key away on the way through. Off by default: a key is usually kept. */
  consumeKey?: boolean;
  /**
   * Remember that it has been opened, on a self switch, so the player is asked
   * for the key once and the door behaves like any other afterwards.
   *
   * Turn this off for a door that should follow its lock forever — a gate that
   * a quest switch can close again.
   */
  remember?: boolean;
  selfSwitch?: string;
}

/**
 * The pages of a locked door: the one that asks, and the one that no longer does.
 *
 * The asking page is **Action Button**, unlike the ordinary door's Player Touch.
 * That is what the measured locked door uses, and it is the only trigger that
 * makes sense for a refusal: a touch-triggered locked door tells the player it
 * is locked every time they brush past it.
 */
export function lockedDoorPages(options: LockedDoorOptions): EventPage[] {
  const {
    lock,
    target,
    characterName = '!Door1',
    characterIndex = 0,
    lockedText = "It's locked.",
    unlockText = '',
    openSe = 'Open1',
    moveSe = 'Move1',
    consumeKey = false,
    remember = true,
    selfSwitch = 'A',
  } = options;
  const lockedSe = options.lockedSe ?? openSe;

  const condition = lockConditionParameters(lock);

  // Order matters and is forced by the engine: the transfer is last, because
  // nothing after it runs, and the self switch is written before it for the
  // same reason. The door finishes swinging (the route waits) before either,
  // so refreshing the page cannot interrupt a route in flight.
  const opening: EventCommand[] = [
    ...textCommands(unlockText),
    ...doorOpenCommands({ openSe }),
    ...(consumeKey && lock.kind !== 'switch' ? [consumeKeyCommand(lock)] : []),
    // [self switch, value (0 = ON)]
    ...(remember
      ? [{ code: CODE_SELF_SWITCH, indent: 0, parameters: [selfSwitch, 0] } as EventCommand]
      : []),
    ...(target ? doorTransferCommands(target, moveSe) : []),
  ];

  const refusing: EventCommand[] = [
    { code: CODE_PLAY_SE, indent: 0, parameters: [audio(lockedSe)] },
    ...textCommands(lockedText),
  ];

  const base = doorEventPage({ characterName, characterIndex, target, openSe, moveSe });

  const asking: EventPage = {
    ...base,
    // Action Button: a locked door has to be tried, not bumped into.
    trigger: 0,
    list: [
      ...conditionalBranch(condition, opening, refusing),
      { code: CODE_END, indent: 0, parameters: [] },
    ],
  };

  if (!remember) return [asking];

  // Unlocked: an ordinary door, and it must come *after* the asking page —
  // findProperPageIndex scans backwards and takes the first page that matches.
  const opened: EventPage = {
    ...base,
    conditions: { ...base.conditions, selfSwitchCh: selfSwitch, selfSwitchValid: true },
  };

  return [asking, opened];
}

export function lockedDoorEvent(
  id: number,
  x: number,
  y: number,
  options: LockedDoorOptions & { name?: string }
): Event {
  return {
    id,
    name: options.name ?? `LockedDoor${id}`,
    note: '',
    pages: lockedDoorPages(options),
    x,
    y,
  };
}

/** How the lock reads in a report. */
export function describeLock(lock: Lock, name?: string): string {
  const label = name ? ` ("${name}")` : '';
  switch (lock.kind) {
    case 'switch':
      return `switch ${lock.dataId}${label} being ON`;
    case 'item':
      return `the party holding item ${lock.dataId}${label}`;
    case 'weapon':
    case 'armor':
      return (
        `the party holding ${lock.kind} ${lock.dataId}${label}` +
        (lock.includeEquip ? ', equipped or not' : ' in the bag (not counting equipped ones)')
      );
  }
}
