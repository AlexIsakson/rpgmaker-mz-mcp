import type { Event, EventCommand, EventPage } from '../schemas/event.js';

/**
 * Levers — the thing that *sets* a switch.
 *
 * `place_locked_door` can lock a door behind a flag and `place_key_for_door`
 * refuses one, correctly: a switch has no key to put in a chest, it has
 * something that throws it. This is that something.
 *
 * **There is no lever anywhere in the corpus to copy.** Of 422 events, 38 pages
 * set a switch, and not one of them is an object the player pulls: they are
 * cutscenes, autoruns, parallel processes and NPCs. So the shape here is
 * assembled from what *has* been measured — the chest's Action-Button object
 * page, the switch page condition used on 59 pages — and from the engine, which
 * settles more of it than one might expect.
 *
 * **The art was measured off the sheets, since nothing shipped uses them.**
 * `!Switch1` and `!Switch2` are 576x384, eight character slots of 48x48, and in
 * every slot the four *direction* rows are four frames of one movement rather
 * than four facings: `!Switch1` slot 0 is a lever whose handle swings from one
 * side to the other, slot 4 a button that presses flat, `!Switch2` slot 0 a wall
 * lever whose handle drops from top to bottom. The three pattern columns differ
 * by 2-3% — an idle bob, not a state. That is the same layout `!Chest` uses
 * (closed / ajar / half / open along the direction axis), so **direction 2 is
 * resting and direction 8 is thrown**.
 *
 * **Which makes `directionFix` load-bearing, not cosmetic.** `Game_Event.start`
 * calls `lock()` for triggers 0, 1 and 2, and `lock()` calls
 * `turnTowardPlayer()` — so the instant the player uses a lever, the engine
 * turns it to face them. On a sheet whose direction axis carries *state*, that
 * is the lever visibly jumping to another frame. `setDirection` is the guard:
 *
 * ```js
 * if (!this.isDirectionFixed() && d) { this._direction = d; }
 * ```
 *
 * so `directionFix: true` makes it a no-op. This is why the measured chest and
 * torch pages both set it, which until now looked like a stylistic habit.
 *
 * **The second page is gated on the switch itself, not on a self switch.** A
 * lever is the flag's display: if a quest or another lever turns the switch off,
 * the lever should spring back, and a self switch would freeze it thrown for
 * good. That is also the difference from a chest, whose self switch is right
 * because "already looted" is a fact about the chest rather than about the world.
 *
 * **Setting the switch does not cut the page short.** `Game_Map.setupStartingMapEvent`
 * hands `event.list()` to the interpreter, which keeps its own reference
 * (`this._list = list`), so the page change a switch triggers cannot truncate
 * the list already running — a lever can say something after throwing itself.
 * This is the opposite of the transfer case in `locked-door.ts`, where the
 * interpreter is destroyed with its map.
 *
 * This module is pure — it builds events, and never reads a file.
 */

const CODE_CONTROL_SWITCHES = 121;
const CODE_PLAY_SE = 250;
const CODE_SHOW_TEXT = 101;
const CODE_SHOW_TEXT_BODY = 401;
const CODE_END = 0;

/** `$gameSwitches.setValue(i, params[2] === 0)` — 0 turns it on, 1 off. */
const SWITCH_ON = 0;
const SWITCH_OFF = 1;

/** Resting and thrown, read off `!Switch1` / `!Switch2` / `!Chest`. */
export const LEVER_RESTING_DIRECTION = 2;
export const LEVER_THROWN_DIRECTION = 8;

/** The SE named for exactly this, in the shipped audio. */
export const LEVER_SE = 'Switch1';

export class LeverError extends Error {}

/**
 * Control Switches for a single flag.
 *
 * The command takes a *range*, and all 38 measured uses write a range of one
 * (`[n, n, value]`), which is what the editor emits for a single switch.
 */
export function setSwitchCommand(switchId: number, on: boolean): EventCommand {
  if (!Number.isInteger(switchId) || switchId < 1) {
    throw new LeverError(
      `Switch ${switchId} is not a usable id. Game_Switches.setValue is guarded by ` +
        '`switchId > 0`, so switch 0 can never hold anything.'
    );
  }
  return {
    code: CODE_CONTROL_SWITCHES,
    indent: 0,
    parameters: [switchId, switchId, on ? SWITCH_ON : SWITCH_OFF],
  };
}

function blankConditions() {
  return {
    actorId: 1, actorValid: false,
    itemId: 1, itemValid: false,
    selfSwitchCh: 'A', selfSwitchValid: false,
    switch1Id: 1, switch1Valid: false,
    switch2Id: 1, switch2Valid: false,
    variableId: 1, variableValid: false, variableValue: 0,
  };
}

function idleRoute() {
  return { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false };
}

function audio(name: string) {
  return { name, volume: 90, pitch: 100, pan: 0 };
}

function textCommands(text: string): EventCommand[] {
  if (text.trim() === '') return [];
  return [
    // [faceName, faceIndex, background (0 = window), position (2 = bottom), speaker]
    { code: CODE_SHOW_TEXT, indent: 0, parameters: ['', 0, 0, 2, ''] },
    { code: CODE_SHOW_TEXT_BODY, indent: 0, parameters: [text] },
  ];
}

export interface LeverOptions {
  /** The flag this throws. */
  switchId: number;
  characterName?: string;
  characterIndex?: number;
  se?: string;
  /** Said when it is thrown. */
  text?: string;
  /**
   * Whether it can be pulled back.
   *
   * Off by default: a lever that opens a gate should not close it again by
   * accident, and a one-way lever's thrown page has no commands at all — which
   * `Game_Event.start` treats as nothing to run, since it needs
   * `list.length > 1` before an event will even start.
   */
  toggle?: boolean;
  /** Said when it is pulled back. Only reachable when `toggle` is on. */
  offText?: string;
  restingDirection?: number;
  thrownDirection?: number;
}

function leverPage(
  options: LeverOptions,
  state: 'resting' | 'thrown'
): EventPage {
  const {
    switchId,
    characterName = '!Switch1',
    characterIndex = 0,
    se = LEVER_SE,
    text = '',
    offText = '',
    toggle = false,
    restingDirection = LEVER_RESTING_DIRECTION,
    thrownDirection = LEVER_THROWN_DIRECTION,
  } = options;

  const resting = state === 'resting';
  const acts = resting || toggle;

  const list: EventCommand[] = acts
    ? [
        { code: CODE_PLAY_SE, indent: 0, parameters: [audio(se)] },
        setSwitchCommand(switchId, resting),
        ...textCommands(resting ? text : offText),
        { code: CODE_END, indent: 0, parameters: [] },
      ]
    : [{ code: CODE_END, indent: 0, parameters: [] }];

  return {
    conditions: resting
      ? blankConditions()
      : { ...blankConditions(), switch1Id: switchId, switch1Valid: true },
    // Load-bearing: lock() turns the event toward the player on use, and the
    // direction axis of these sheets is the state, not the facing.
    directionFix: true,
    image: {
      characterIndex,
      characterName,
      direction: resting ? restingDirection : thrownDirection,
      pattern: 1,
      tileId: 0,
    },
    list,
    moveFrequency: 3,
    moveRoute: idleRoute(),
    moveSpeed: 3,
    moveType: 0,
    priorityType: 1,
    stepAnime: false,
    through: false,
    // Action Button: a lever is used, not walked into.
    trigger: 0,
    walkAnime: false,
  };
}

/**
 * The two pages of a lever: resting, and thrown.
 *
 * The thrown page comes second because `Game_Event.findProperPageIndex` scans
 * backwards and takes the first page whose conditions hold — the same ordering
 * the chest and the locked door need.
 */
export function leverPages(options: LeverOptions): EventPage[] {
  if (!Number.isInteger(options.switchId) || options.switchId < 1) {
    throw new LeverError(
      `Switch ${options.switchId} is not a usable id. Allocate one with allocate_switch.`
    );
  }
  return [leverPage(options, 'resting'), leverPage(options, 'thrown')];
}

export function leverEvent(
  id: number,
  x: number,
  y: number,
  options: LeverOptions & { name?: string }
): Event {
  return {
    id,
    name: options.name ?? `Lever${id}`,
    note: '',
    pages: leverPages(options),
    x,
    y,
  };
}
