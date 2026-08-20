import type { Event, EventCommand, EventPage } from '../schemas/event.js';

/**
 * The thing standing at the end of a dungeon.
 *
 * `link_dungeon_floors` finds the deepest floor's far end — the tile furthest
 * from the way in — and deliberately leaves it clear, saying only "left clear
 * for whatever the dungeon is for." Nothing has ever filled it in. This module
 * is that: a boss guarding the way past a chokepoint, in the same two-page
 * shape `locked-door.ts` already uses for "ask, then remember" — except what it
 * asks for is a win, not a key.
 *
 * **The guard's battle is built by hand, not through the block-structure
 * pipeline `add_event_commands` uses.** That pipeline exists for a caller
 * writing an arbitrary list; here there is exactly one shape — battle, then
 * (only on a win) open the way through — so it is written directly the way
 * `locked-door.ts`'s `conditionalBranch` writes a branch: a `601` (If Win) at
 * the battle's own indent, the self-switch one level in, the corpus's own
 * blank-line-then-closer convention before `604` (End Battle), matching
 * `command-nesting.ts`'s `assignIndents` exactly without needing to run it.
 *
 * **A win is required, not merely survived.** With no `if_escape` / `if_lose`
 * arm, `command301`'s `_branch[_indent]` is left at whatever
 * `BattleManager.endBattle` passed — 0 win, 1 escape, 2 lose — and `601` skips
 * its body (`branch.get(indent) !== 0`) on anything but a win. An escaped fight
 * leaves the guard standing; `canLose: false` sends a defeat straight to
 * `Scene_Gameover` (matching the two armless battles the corpus shows, and
 * `command-nesting.ts`'s own `if_lose` refusal one level up), so there is no
 * dishonest "lost but the door opened anyway" state to reach.
 *
 * **The sprite has nothing in the corpus to measure.** 0 of 293 sample maps use
 * any of the RTP's own monster sheets (`Monster`, `SF_Monster`, `$BigMonster1`,
 * `$BigMonster2`, `Evil`) on any event — there is no on-map boss anywhere to
 * copy. `$BigMonster1` is the default here because it exists for exactly this
 * purpose (a `$`-prefixed sheet is one full-frame image rather than a grid of
 * facings, the shape the RTP uses for a large single creature), and it is a
 * stated choice, not a measured one — `characterName` overrides it.
 *
 * This module is pure — it builds events, and never reads a file.
 */

const CODE_SHOW_TEXT = 101;
const CODE_SHOW_TEXT_BODY = 401;
const CODE_BATTLE_PROCESSING = 301;
const CODE_IF_WIN = 601;
const CODE_END_BATTLE = 604;
const CODE_SELF_SWITCH = 123;
const CODE_END = 0;

/** `command301`'s designation: 0 is a direct troop id, matching 13 of 13 corpus battles. */
const DESIGNATION_DIRECT = 0;

export const DEFAULT_GUARD_SHEET = '$BigMonster1';

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

function textCommands(text: string): EventCommand[] {
  if (text.trim() === '') return [];
  return [
    { code: CODE_SHOW_TEXT, indent: 0, parameters: ['', 0, 0, 2, ''] },
    { code: CODE_SHOW_TEXT_BODY, indent: 0, parameters: [text] },
  ];
}

export class ClimaxError extends Error {}

export interface ClimaxGuardOptions {
  /** Troop this fights. Existence and non-empty membership are the caller's job. */
  troopId: number;
  /**
   * Whether the party can flee. Off by default: escaping leaves `_branch` at 1,
   * `601` skips its body either way, and the guard is left standing — the same
   * outcome as losing, but reachable without the party losing anyone, which
   * undersells a climax fight. A caller who wants an escape route sets this.
   */
  canEscape?: boolean;
  /**
   * Whether a defeat resumes the map. Off by default, matching the two armless
   * battles in the corpus: `BattleManager.updateBattleEnd` sends a party wipe
   * straight to `Scene_Gameover` unless this is on, and there is no `if_lose`
   * arm here to resume into regardless.
   */
  canLose?: boolean;
  characterName?: string;
  characterIndex?: number;
  /** Said once, Action Button, before the fight starts. */
  challengeText?: string;
  /** Flag that remembers the guard is beaten. */
  selfSwitch?: string;
}

/**
 * The guard's two pages: standing watch, and beaten.
 *
 * **Action Button, matching every other thing in this codebase you interact
 * with rather than bump into** — the chest, the lever, the locked door. A
 * touch-triggered boss would start the fight the instant the player rounds the
 * corner, with no chance to back off.
 *
 * The beaten page keeps the sprite rather than erasing it — a defeated guard is
 * still something that was there, the way an opened chest still is — but drops
 * `priorityType` to 0 and sets `through`, so what blocked the way through now
 * does not.
 */
export function climaxGuardPages(options: ClimaxGuardOptions): EventPage[] {
  if (!Number.isInteger(options.troopId) || options.troopId < 1) {
    throw new ClimaxError(`Troop ${options.troopId} is not a usable id.`);
  }

  const {
    troopId,
    canEscape = false,
    canLose = false,
    characterName = DEFAULT_GUARD_SHEET,
    characterIndex = 0,
    challengeText = '',
    selfSwitch = 'A',
  } = options;

  const list: EventCommand[] = [
    ...textCommands(challengeText),
    { code: CODE_BATTLE_PROCESSING, indent: 0, parameters: [DESIGNATION_DIRECT, troopId, canEscape, canLose] },
    { code: CODE_IF_WIN, indent: 0, parameters: [] },
    // [self switch, value (0 = ON)]
    { code: CODE_SELF_SWITCH, indent: 1, parameters: [selfSwitch, 0] },
    // The corpus's own blank line at the end of every block body, one level in.
    { code: CODE_END, indent: 1, parameters: [] },
    { code: CODE_END_BATTLE, indent: 0, parameters: [] },
    { code: CODE_END, indent: 0, parameters: [] },
  ];

  const guarding: EventPage = {
    conditions: blankConditions(),
    directionFix: true,
    image: { characterIndex, characterName, direction: 2, pattern: 1, tileId: 0 },
    list,
    moveFrequency: 3,
    moveRoute: idleRoute(),
    moveSpeed: 3,
    moveType: 0,
    priorityType: 1,
    stepAnime: true,
    through: false,
    trigger: 0,
    walkAnime: true,
  };

  // findProperPageIndex scans backwards, so the conditioned page has to sit
  // after the plain one to ever be reached.
  const beaten: EventPage = {
    ...guarding,
    conditions: { ...blankConditions(), selfSwitchCh: selfSwitch, selfSwitchValid: true },
    list: [{ code: CODE_END, indent: 0, parameters: [] }],
    priorityType: 0,
    through: true,
  };

  return [guarding, beaten];
}

export function climaxGuardEvent(
  id: number,
  x: number,
  y: number,
  options: ClimaxGuardOptions & { name?: string }
): Event {
  return {
    id,
    name: options.name ?? `Guardian${id}`,
    note: '',
    pages: climaxGuardPages(options),
    x,
    y,
  };
}
