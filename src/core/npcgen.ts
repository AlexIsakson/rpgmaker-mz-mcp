import { makeRng } from './mapgen.js';
import type { Event, EventCommand, EventPage } from '../schemas/event.js';

/**
 * People to put in the places the other generators build.
 *
 * The page settings are the ones real projects use, counted across the 70
 * talking NPC pages in the demo projects that ship with the editor — the
 * `samplemaps` folder is scenery templates and has none, so the DLC demos are
 * the ground truth here:
 *
 *  - **Action Button, priority "same as characters", fixed movement**, with
 *    `walkAnime` and `stepAnime` both on so the sprite idles in place: 28 of 70.
 *    Player Touch with everything else identical is next at 21.
 *  - **Show Text carries `[faceName, faceIndex, background, positionType]`**
 *    plus MZ's speaker name, and a message box holds **four lines**; a fifth
 *    line needs a second box. 31 pages use `["", 0, 0, 2, ""]` — no face,
 *    window background, bottom of the screen.
 *
 * Sprite sheets follow `ImageManager`: a name beginning `$` holds one big
 * character, anything else holds eight in a 4x2 grid, and a leading `!` means
 * the sprite is an object drawn without a shadow.
 *
 * This module is pure — it builds events and picks tiles, and never reads a file.
 */

// --- character sheets -------------------------------------------------------

/** `ImageManager.isBigCharacter`: a `$` in the leading sign block. */
export function isBigCharacterSheet(name: string): boolean {
  const sign = name.match(/^[!$]+/);
  return sign !== null && sign[0].includes('$');
}

/** `ImageManager.isObjectCharacter`: a `!` in the leading sign block. */
export function isObjectCharacterSheet(name: string): boolean {
  const sign = name.match(/^[!$]+/);
  return sign !== null && sign[0].includes('!');
}

/**
 * How many characters a sheet holds. `characterBlockX`/`characterBlockY` index
 * a big sheet at 0 and lay a normal one out four across and two down.
 */
export function charactersOnSheet(name: string): number {
  return isBigCharacterSheet(name) ? 1 : 8;
}

// --- dialogue ---------------------------------------------------------------

/** A message box shows four lines; a fifth needs a new box. */
export const MESSAGE_LINES_PER_BOX = 4;

/**
 * Characters per line before wrapping.
 *
 * This is a conservative default rather than a measured constant: the real
 * limit depends on the font and on whether a face is shown, and the engine
 * measures text in pixels. Wrapping short is harmless; wrapping long runs off
 * the window.
 */
export const DEFAULT_WRAP_WIDTH = 46;

/**
 * Break text into display lines, on word boundaries where there are any.
 *
 * Deliberately separate from the profile/description wrapping in
 * `database-tools`: that one is tuned for the status window's full-width CJK
 * text, and a message window is a different width with different break rules.
 */
export function wrapDialogue(text: string, width = DEFAULT_WRAP_WIDTH): string[] {
  const out: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= width) {
      out.push(paragraph);
      continue;
    }

    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line === '') {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
      // a single word longer than the window has to be cut somewhere
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    if (line !== '') out.push(line);
  }

  return out;
}

const CODE_SHOW_TEXT = 101;
const CODE_SHOW_TEXT_BODY = 401;
const CODE_END = 0;

export interface Face {
  name: string;
  index: number;
}

/**
 * Turn dialogue into Show Text commands, starting a new box every four lines.
 *
 * Parameters are `[faceName, faceIndex, background, positionType, speakerName]`
 * — MZ added the speaker name, and the demo projects write it as an empty
 * string rather than leaving it off.
 */
export function dialogueCommands(
  text: string,
  options: { face?: Face; wrapAt?: number } = {}
): EventCommand[] {
  // No text means no message box. Wrapping an empty string yields one empty
  // line, and emitting that opens a blank window in the player's face.
  if (text.trim() === '') return [];

  const lines = wrapDialogue(text, options.wrapAt ?? DEFAULT_WRAP_WIDTH);
  const face = options.face;
  const commands: EventCommand[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (i % MESSAGE_LINES_PER_BOX === 0) {
      commands.push({
        code: CODE_SHOW_TEXT,
        indent: 0,
        // [face, faceIndex, background (0 = window), position (2 = bottom), speaker]
        parameters: [face?.name ?? '', face?.index ?? 0, 0, 2, ''],
      });
    }
    commands.push({ code: CODE_SHOW_TEXT_BODY, indent: 0, parameters: [lines[i]] });
  }

  return commands;
}

// --- the NPC event ----------------------------------------------------------

/** `Game_Event.updateSelfMovement` switches on these. */
export const MOVE_TYPES = ['fixed', 'random', 'toward'] as const;
export type MoveType = (typeof MOVE_TYPES)[number];

export function moveTypeCode(type: MoveType): number {
  return MOVE_TYPES.indexOf(type);
}

/** Action Button, Player Touch, Event Touch, Autorun, Parallel. */
export const NPC_TRIGGERS = ['action', 'touch'] as const;
export type NpcTrigger = (typeof NPC_TRIGGERS)[number];

export interface NpcOptions {
  characterName: string;
  characterIndex?: number;
  text?: string;
  face?: Face;
  trigger?: NpcTrigger;
  movement?: MoveType;
  /** 2 down, 4 left, 6 right, 8 up. */
  direction?: number;
  wrapAt?: number;
  /**
   * Commands appended after the dialogue and before the terminator — what the
   * NPC *does* once it has finished talking.
   *
   * A shopkeeper is a talking NPC that then opens a shop, so it belongs on this
   * page rather than on a copy of it: the settings here rest on 70 measured
   * pages, and the four shop pages on hand agree with them.
   */
  commands?: EventCommand[];
}

export class NpcError extends Error {}

export function npcEventPage(options: NpcOptions): EventPage {
  const {
    characterName,
    characterIndex = 0,
    text = '',
    face,
    trigger = 'action',
    movement = 'fixed',
    direction = 2,
    wrapAt,
    commands = [],
  } = options;

  if (characterName === '') {
    throw new NpcError('An NPC needs a character sheet, or nothing is drawn on the map.');
  }
  const max = charactersOnSheet(characterName) - 1;
  if (characterIndex < 0 || characterIndex > max) {
    throw new NpcError(
      `Character index ${characterIndex} is outside "${characterName}", which holds ` +
        `${max + 1} character(s) (index 0${max > 0 ? `-${max}` : ''}). A sheet whose name starts ` +
        'with $ holds one big character; anything else holds eight in a 4x2 grid.'
    );
  }
  if (![2, 4, 6, 8].includes(direction)) {
    throw new NpcError(`Direction ${direction} is not one of 2 (down), 4 (left), 6 (right), 8 (up).`);
  }

  const list: EventCommand[] = [
    ...dialogueCommands(text, { face, wrapAt }),
    ...commands,
    { code: CODE_END, indent: 0, parameters: [] },
  ];

  return {
    conditions: {
      actorId: 1, actorValid: false,
      itemId: 1, itemValid: false,
      selfSwitchCh: 'A', selfSwitchValid: false,
      switch1Id: 1, switch1Valid: false,
      switch2Id: 1, switch2Valid: false,
      variableId: 1, variableValid: false, variableValue: 0,
    },
    directionFix: false,
    image: { characterIndex, characterName, direction, pattern: 1, tileId: 0 },
    list,
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3,
    moveType: moveTypeCode(movement),
    priorityType: 1,
    stepAnime: true,
    through: false,
    trigger: trigger === 'action' ? 0 : 1,
    walkAnime: true,
  };
}

export function npcEvent(id: number, x: number, y: number, name: string, options: NpcOptions): Event {
  return { id, name, note: '', pages: [npcEventPage(options)], x, y };
}

// --- placement --------------------------------------------------------------

export interface Slot {
  x: number;
  y: number;
}

export interface NpcPlacementOptions {
  count: number;
  seed: number;
  /** Tiles nothing may stand on: existing events, and the way in to every door. */
  blocked?: Slot[];
  /** A tile the player can reach; everything must stay connected to it. */
  reference?: Slot;
  /**
   * Whether the player can step from one tile to an adjacent one.
   *
   * Defaults to "both are standable", which is **not** what the engine does:
   * passage flags are directional, so two adjacent standable tiles can be
   * mutually unreachable. A room's wall top is standable and sits right beside
   * the floor, yet the player can never step onto it — take the default and
   * NPCs end up on top of the walls. Callers with a map and its flags should
   * pass `canPass` from walkability.ts.
   */
  canStep?: (ax: number, ay: number, bx: number, by: number) => boolean;
}

const key = (x: number, y: number) => `${x},${y}`;

function shuffle<T>(rng: () => number, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

type CanStep = (ax: number, ay: number, bx: number, by: number) => boolean;

/** The tiles reachable from `from`, treating `taken` as solid. */
function flood(
  standable: boolean[][],
  taken: Set<string>,
  from: Slot,
  canStep: CanStep
): Set<string> {
  const height = standable.length;
  const width = standable[0]?.length ?? 0;
  if (from.y < 0 || from.x < 0 || from.y >= height || from.x >= width) return new Set();
  if (!standable[from.y][from.x] || taken.has(key(from.x, from.y))) return new Set();

  const seen = new Set<string>([key(from.x, from.y)]);
  const stack = [from];

  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!standable[ny][nx] || taken.has(key(nx, ny)) || seen.has(key(nx, ny))) continue;
      if (!canStep(x, y, nx, ny)) continue;
      seen.add(key(nx, ny));
      stack.push({ x: nx, y: ny });
    }
  }

  return seen;
}

export interface NpcPlacement {
  placed: Slot[];
  /** Candidates rejected because standing there would have sealed something off. */
  rejected: number;
  /** True when there were fewer usable tiles than `count`. */
  ranOut: boolean;
}

/**
 * Choose tiles for NPCs.
 *
 * An NPC has priority "same as characters", so it **blocks its tile** — which
 * makes placement a connectivity problem, not a scattering one. One standing in
 * a doorway or a one-tile alley seals off whatever is behind it, and the player
 * has no way to know why. So each candidate is accepted only if the walkable
 * area stays exactly as connected with it as without: the guarantee is checked
 * per placement rather than audited afterwards.
 */
export function planNpcPlacement(
  standable: boolean[][],
  options: NpcPlacementOptions
): NpcPlacement {
  const height = standable.length;
  const width = standable[0]?.length ?? 0;
  const blocked = new Set((options.blocked ?? []).map((s) => key(s.x, s.y)));
  const canStep: CanStep = options.canStep ?? (() => true);

  if (options.count <= 0) return { placed: [], rejected: 0, ranOut: false };

  let reference = options.reference ?? null;
  if (reference === null) {
    for (let y = 0; y < height && reference === null; y++) {
      for (let x = 0; x < width; x++) {
        if (standable[y][x] && !blocked.has(key(x, y))) {
          reference = { x, y };
          break;
        }
      }
    }
  }
  if (reference === null) return { placed: [], rejected: 0, ranOut: true };

  // Everything already blocked stays blocked while we measure.
  const taken = new Set(blocked);

  // Only tiles the player can actually walk to are candidates. Standable is not
  // enough: an interior's wall tops are standable and sit right beside the
  // floor, but nothing can step onto them, so an NPC put there is visible,
  // unreachable and impossible to explain.
  let reachable = flood(standable, taken, reference, canStep);
  const candidates: Slot[] = [];
  for (const cell of reachable) {
    const [x, y] = cell.split(',').map(Number);
    candidates.push({ x, y });
  }

  const placed: Slot[] = [];
  let rejected = 0;
  let free = reachable.size;

  for (const slot of shuffle(makeRng(options.seed), candidates)) {
    if (placed.length >= options.count) break;
    if (slot.x === reference.x && slot.y === reference.y) continue;

    taken.add(key(slot.x, slot.y));
    // Standing here costs exactly one walkable tile if nothing was cut off.
    reachable = flood(standable, taken, reference, canStep);
    if (reachable.size === free - 1) {
      placed.push(slot);
      free--;
    } else {
      taken.delete(key(slot.x, slot.y));
      rejected++;
    }
  }

  return { placed, rejected, ranOut: placed.length < options.count };
}
