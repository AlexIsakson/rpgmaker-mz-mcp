import { dialogueCommands } from './npcgen.js';
import type { Event, EventCommand, EventPage } from '../schemas/event.js';
import type { GoodsKind } from './shop.js';

/**
 * What a locked room is *for*.
 *
 * `lock_dungeon_floor` could already divide a floor, lock a door and put a
 * reward behind it, and the result still had a hole in the middle: nothing said
 * why the door was locked, the key was called "Key to map 2", and the door said
 * "It's locked." A player meeting that has no reason to think a key exists at
 * all — which makes the lock a wall they wander away from rather than a thing to
 * solve.
 *
 * So a theme supplies the three pieces that have to agree with each other: what
 * the room is, what its key is called, and what the door says. It also decides
 * what is worth locking up — an armoury holds weapons and armour, a storeroom
 * holds supplies — so the fiction reaches the loot table rather than stopping at
 * the text.
 *
 * **The hint is the part that is generated rather than written.** An inscription
 * near the door names the direction the key was actually placed in, worked out
 * from the two coordinates. It is the only sentence here that could be wrong,
 * and it cannot be: it is read off the placement the tool just made.
 *
 * **The sign shape is measured**, and thinly: across the projects there are 39
 * single-page events whose commands are nothing but Show Text, and **37 are
 * Action Button** — that part is settled. Only 4 have no sprite at all, the
 * true "inscription" case, and they split 2/2 between priority 1 and priority 0.
 * With the sample tied, the tie-break is the engine's: an inscription goes
 * beside a locked door, a locked door stands on a chokepoint, and a priority-1
 * event blocks its tile. Priority 0 cannot seal anything, and
 * `Game_Player.triggerButtonAction` starts it through `checkEventTriggerHere([0])`
 * when the player stands on it and presses — so the safe choice is also a
 * working one.
 *
 * This module is pure — it builds events and picks words, and never reads a file.
 */

const CODE_END = 0;

export const VAULT_THEMES = [
  'treasury',
  'armoury',
  'storeroom',
  'cell',
  'crypt',
] as const;
export type VaultTheme = (typeof VAULT_THEMES)[number];

export interface ThemeCopy {
  /** The room, as it appears in prose: "the treasury". */
  room: string;
  /** What the key is called in the database. */
  keyName: string;
  /** What the door says when the player has nothing. */
  lockedText: string;
  /** Said by the inscription, before the direction clause. */
  inscription: string;
  /**
   * The same, for a door opened by a lever.
   *
   * Not decoration: the armoury's key inscription says "no key, no blade", which
   * on a lever-locked door is a sign contradicting the door beside it. The
   * fiction has to agree with the mechanism or it is worse than no fiction.
   */
  leverInscription: string;
  /** Which databases the reward is drawn from. A storeroom holds supplies. */
  rewardKinds: GoodsKind[];
  /** Name given to the door event, so the map reads as something. */
  doorName: string;
}

/**
 * The five rooms.
 *
 * This is writing, not measurement, and it is kept in one table so it is
 * obvious which parts of this server are which. What each theme *does* — the
 * databases its reward comes from — is the part that reaches the game.
 */
export const THEME_COPY: Record<VaultTheme, ThemeCopy> = {
  treasury: {
    room: 'the treasury',
    keyName: 'Treasury Key',
    lockedText:
      'The treasury door. Iron, banded, and the lock is set flush into it — no prising this one.',
    inscription: "Scratched into the stone: 'What we took, we keep. The steward holds the key.'",
    leverInscription:
      "Scratched into the stone: 'What we took, we keep. The bolt draws from within.'",
    rewardKinds: ['item', 'weapon', 'armor'],
    doorName: 'TreasuryDoor',
  },
  armoury: {
    room: 'the armoury',
    keyName: 'Armoury Key',
    lockedText: 'The armoury. You can hear the racks shift behind it, and the lock holds.',
    inscription: "A notice, half rotted: 'Arms are drawn against the key. No key, no blade.'",
    leverInscription:
      "A notice, half rotted: 'The racks are held shut. The release is not kept here.'",
    rewardKinds: ['weapon', 'armor'],
    doorName: 'ArmouryDoor',
  },
  storeroom: {
    room: 'the storeroom',
    keyName: 'Storeroom Key',
    lockedText: 'The storeroom door, and it is locked. Someone was counting what went in.',
    inscription: "A tally is chalked here, and beneath it: 'Key with the quartermaster.'",
    leverInscription:
      "A tally is chalked here, and beneath it: 'Quartermaster works the winch.'",
    rewardKinds: ['item'],
    doorName: 'StoreroomDoor',
  },
  cell: {
    room: 'the cell block',
    keyName: 'Cell Key',
    lockedText: 'A cell door. The grille is dark, and the lock does not turn.',
    inscription: "Carved by a fingernail, low on the wall: 'The gaoler never carries it far.'",
    leverInscription:
      "Carved by a fingernail, low on the wall: 'They throw it from the guardroom.'",
    rewardKinds: ['item', 'armor'],
    doorName: 'CellDoor',
  },
  crypt: {
    room: 'the crypt',
    keyName: 'Crypt Key',
    lockedText: 'The crypt is sealed. The stone is cold enough to hurt.',
    inscription: "An epitaph, worn nearly smooth: 'Sealed by the last of us. The key went with him.'",
    leverInscription:
      "An epitaph, worn nearly smooth: 'Sealed by the last of us. The stone answers to the lever.'",
    rewardKinds: ['armor', 'item'],
    doorName: 'CryptDoor',
  },
};

/**
 * Which theme a lock gets when the caller does not say.
 *
 * Rotating by how many locks the floor already has matters mechanically, not
 * just for variety: two treasuries on one floor would want the same key name,
 * and a key is reused by name — so both doors would open with one key and the
 * second lock would be free.
 */
export function defaultTheme(existingLocks: number): VaultTheme {
  return VAULT_THEMES[existingLocks % VAULT_THEMES.length];
}

// --- the hint ---------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

/**
 * Which way `to` lies from `from`, in words.
 *
 * Screen coordinates, so a larger y is south. A diagonal is only named when
 * both components are worth mentioning — "north-east" for a key that is barely
 * east of the door reads as a wrong answer even though it is a true one, so the
 * lesser axis has to be at least half the greater to be named at all.
 */
export function describeDirection(from: Point, to: Point): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return 'right here';

  const horizontal = dx > 0 ? 'east' : 'west';
  const vertical = dy > 0 ? 'south' : 'north';

  if (Math.abs(dx) >= Math.abs(dy) * 2) return horizontal;
  if (Math.abs(dy) >= Math.abs(dx) * 2) return vertical;
  return `${vertical}-${horizontal}`;
}

/** How far apart two tiles are, in words a sign would use. */
export function describeDistance(from: Point, to: Point): string {
  const steps = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
  if (steps <= 6) return 'not far';
  if (steps <= 20) return 'some way';
  return 'a long way';
}

export type OpenerKind = 'key' | 'lever';

/**
 * The line the inscription says.
 *
 * The second sentence is derived from where the opener actually went, which is
 * the only claim here that could be checked against the map — and the reason
 * the hint is worth placing at all. A sign that says "a key exists somewhere"
 * is scenery; one that says which way is a lead.
 */
export function hintText(
  theme: VaultTheme,
  opener: OpenerKind,
  door: Point,
  openerAt: Point
): string {
  const copy = THEME_COPY[theme];
  const direction = describeDirection(door, openerAt);
  const distance = describeDistance(door, openerAt);
  const opening = opener === 'key' ? copy.inscription : copy.leverInscription;

  const lead =
    opener === 'key'
      ? `The key lies ${distance} to the ${direction}.`
      : `The mechanism that opens it stands ${distance} to the ${direction}.`;

  return direction === 'right here' ? opening : `${opening} ${lead}`;
}

// --- the sign ---------------------------------------------------------------

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

export interface SignOptions {
  /**
   * Action Button (0) or Player Touch (1).
   *
   * Action Button is what 37 of the 39 measured text events use. Touch is
   * offered because a hint nobody presses is a hint that does not exist, and a
   * caller who would rather not risk that can say so.
   */
  trigger?: 0 | 1;
  /** Sprite sheet, if the inscription should be something you can see. */
  characterName?: string;
  characterIndex?: number;
}

/**
 * A sprite-less event that says one thing.
 *
 * Priority 0 — it never blocks its tile, which matters because this goes beside
 * a door standing on a chokepoint, where a blocking event could cut the floor in
 * half. A caller who gives it a sprite gets priority 1 instead, because an
 * invisible thing you cannot walk over is a bug and a visible one is a signpost.
 */
export function signPage(text: string, options: SignOptions = {}): EventPage {
  const { trigger = 0, characterName = '', characterIndex = 0 } = options;

  // Wrapped rather than written as one line: a message box shows four lines and
  // measures text in pixels, so a long inscription emitted as a single 401 runs
  // off the window. dialogueCommands is the same wrapping the NPC pages use, and
  // starts a new box every fourth line.
  const list: EventCommand[] = [
    ...dialogueCommands(text),
    { code: CODE_END, indent: 0, parameters: [] },
  ];

  return {
    conditions: blankConditions(),
    directionFix: true,
    image: { characterIndex, characterName, direction: 2, pattern: 1, tileId: 0 },
    list,
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3,
    moveType: 0,
    priorityType: characterName === '' ? 0 : 1,
    stepAnime: false,
    through: false,
    trigger,
    walkAnime: false,
  };
}

export function signEvent(
  id: number,
  x: number,
  y: number,
  text: string,
  options: SignOptions & { name?: string } = {}
): Event {
  return {
    id,
    name: options.name ?? `Inscription${id}`,
    note: '',
    pages: [signPage(text, options)],
    x,
    y,
  };
}
