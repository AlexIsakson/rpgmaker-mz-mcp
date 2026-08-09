import { makeRng, floodFill } from './mapgen.js';
import type { Event, EventCommand, EventPage } from '../schemas/event.js';

/**
 * Torches, treasure and clutter for a dungeon.
 *
 * Both event kinds are measured rather than invented:
 *
 *  - **A torch is a decorative event, and it stands on the wall.** Of the 635
 *    `!Flame` events across the shipped sample maps and demo projects, **623
 *    stand on a solid tile**, and 499 of them use exactly: Action Button
 *    trigger, priority "same as characters", `stepAnime` on so the flame
 *    flickers, `directionFix` on so it never turns, and **no commands at all**.
 *    Nothing happens when you talk to it; it is there to be looked at. That also
 *    explains a `check_map_walkability` finding that looks like a bug and is
 *    not: a torch is *supposed* to be standing in a wall.
 *
 *  - **A pickup is `250, 101, 401, 126, 123, 0`** — play a sound, say what you
 *    got, hand it over, flip self switch A — in 16 of the 20 one-shot pickup
 *    events found across every project that ships with the editor. The second
 *    page is conditioned on that self switch and does nothing, which is what
 *    leaves the chest open and empty behind you.
 *
 * The chest **opens by direction, not by pattern**: the `!Chest` sheet lays its
 * four rows out closed / ajar / half / open, exactly the way the `!Door1` sprite
 * does. That was read off the sheet, since nothing shipped uses it.
 *
 * This module is pure: it builds events and picks tiles, and never reads a file.
 */

// --- torches ----------------------------------------------------------------

const CODE_PLAY_SE = 250;
const CODE_SHOW_TEXT = 101;
const CODE_SHOW_TEXT_BODY = 401;
const CODE_CHANGE_ITEMS = 126;
const CODE_SELF_SWITCH = 123;
const CODE_END = 0;

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

export interface TorchOptions {
  characterName?: string;
  characterIndex?: number;
}

/**
 * A wall torch: animated in place, fixed facing, and silent when spoken to.
 */
export function torchEventPage(options: TorchOptions = {}): EventPage {
  const { characterName = '!Flame', characterIndex = 0 } = options;

  return {
    conditions: blankConditions(),
    directionFix: true,
    image: { characterIndex, characterName, direction: 2, pattern: 1, tileId: 0 },
    list: [{ code: CODE_END, indent: 0, parameters: [] }],
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
}

export function torchEvent(id: number, x: number, y: number, options: TorchOptions = {}): Event {
  return { id, name: `Torch${id}`, note: '', pages: [torchEventPage(options)], x, y };
}

// --- treasure ---------------------------------------------------------------

export interface TreasureOptions {
  characterName?: string;
  characterIndex?: number;
  /** Item handed over. `kind` picks the database: 0 item, 1 weapon, 2 armour. */
  itemId?: number;
  amount?: number;
  /** Message shown. `\\c[6]` colours the name, the way the shipped events do. */
  text?: string;
  openSe?: string;
  /** Self switch used to remember it has been opened. */
  selfSwitch?: string;
}

/** Direction 2 is the closed lid; direction 8 is the open one. */
export const CHEST_CLOSED_DIRECTION = 2;
export const CHEST_OPEN_DIRECTION = 8;

export function treasureEventPages(options: TreasureOptions = {}): EventPage[] {
  const {
    characterName = '!Chest',
    characterIndex = 0,
    itemId = 1,
    amount = 1,
    text = 'You found something.',
    openSe = 'Chest1',
    selfSwitch = 'A',
  } = options;

  const closed: EventPage = {
    conditions: blankConditions(),
    directionFix: true,
    image: {
      characterIndex,
      characterName,
      direction: CHEST_CLOSED_DIRECTION,
      pattern: 1,
      tileId: 0,
    },
    list: [
      {
        code: CODE_PLAY_SE,
        indent: 0,
        parameters: [{ name: openSe, volume: 90, pitch: 100, pan: 0 }],
      },
      { code: CODE_SHOW_TEXT, indent: 0, parameters: ['', 0, 0, 2, ''] },
      { code: CODE_SHOW_TEXT_BODY, indent: 0, parameters: [text] },
      // [itemId, operation (0 = gain), operand (0 = constant), amount]
      { code: CODE_CHANGE_ITEMS, indent: 0, parameters: [itemId, 0, 0, amount] },
      // [switch, value (0 = ON)]
      { code: CODE_SELF_SWITCH, indent: 0, parameters: [selfSwitch, 0] },
      { code: CODE_END, indent: 0, parameters: [] },
    ] as EventCommand[],
    moveFrequency: 3,
    moveRoute: idleRoute(),
    moveSpeed: 3,
    moveType: 0,
    priorityType: 1,
    stepAnime: false,
    through: false,
    trigger: 0,
    walkAnime: false,
  };

  // Once the self switch is on, the chest stands open and does nothing.
  const opened: EventPage = {
    ...closed,
    conditions: { ...blankConditions(), selfSwitchCh: selfSwitch, selfSwitchValid: true },
    image: {
      characterIndex,
      characterName,
      direction: CHEST_OPEN_DIRECTION,
      pattern: 1,
      tileId: 0,
    },
    list: [{ code: CODE_END, indent: 0, parameters: [] }],
  };

  return [closed, opened];
}

export function treasureEvent(
  id: number,
  x: number,
  y: number,
  options: TreasureOptions = {}
): Event {
  return { id, name: `Treasure${id}`, note: '', pages: treasureEventPages(options), x, y };
}

// --- placement --------------------------------------------------------------

export interface Slot {
  x: number;
  y: number;
}

export interface DressingOptions {
  seed: number;
  torchCount: number;
  treasureCount: number;
  /** Fraction of floor tiles that get a scatter prop. */
  floorPropDensity: number;
  /** Fraction of eligible wall tiles that get a wall prop. */
  wallPropDensity: number;
  /** Tiles nothing may use — existing events, the player's arrival tile. */
  blocked?: Slot[];
  /** Minimum gap between torches, so they read as a line rather than a smear. */
  torchSpacing?: number;
}

export interface DressingPlan {
  torches: Slot[];
  treasure: Slot[];
  floorProps: Slot[];
  wallProps: Slot[];
  /** Dead ends found, whether or not treasure went in them. */
  deadEnds: number;
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

/**
 * Decide where everything goes.
 *
 * `floor[y][x]` is true where the player can walk.
 *
 * **Treasure goes in dead ends**, which is both the obvious place to put a
 * reward and the only placement that is provably safe: a chest has priority
 * "same as characters" and blocks its tile, but a dead end has exactly one way
 * in and nothing beyond it, so blocking one can never cut anything off. When
 * there are not enough dead ends, fewer chests are placed rather than one being
 * dropped somewhere it could seal a corridor.
 *
 * **Torches go on wall tiles with floor below them** — the face of the wall,
 * which is the part the player can see.
 */
export function planDressing(floor: boolean[][], options: DressingOptions): DressingPlan {
  const height = floor.length;
  const width = floor[0]?.length ?? 0;
  const rng = makeRng(options.seed);
  const blocked = new Set((options.blocked ?? []).map((s) => key(s.x, s.y)));
  const spacing = options.torchSpacing ?? 3;

  const open = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && floor[y][x];
  const floorNeighbours = (x: number, y: number) =>
    [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => open(x + dx, y + dy)).length;

  const deadEnds: Slot[] = [];
  const plainFloor: Slot[] = [];
  const wallFaces: Slot[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (blocked.has(key(x, y))) continue;
      if (floor[y][x]) {
        if (floorNeighbours(x, y) === 1) deadEnds.push({ x, y });
        else plainFloor.push({ x, y });
      } else if (open(x, y + 1)) {
        // solid, with floor directly below: this is the visible face of a wall
        wallFaces.push({ x, y });
      }
    }
  }

  // --- torches, spaced along the wall faces ---
  const torches: Slot[] = [];
  for (const slot of shuffle(rng, wallFaces)) {
    if (torches.length >= options.torchCount) break;
    const tooClose = torches.some(
      (t) => Math.abs(t.x - slot.x) < spacing && Math.abs(t.y - slot.y) < spacing
    );
    if (!tooClose) torches.push(slot);
  }
  const torchKeys = new Set(torches.map((t) => key(t.x, t.y)));

  // --- treasure, in dead ends only ---
  const treasure = shuffle(rng, deadEnds).slice(0, options.treasureCount);
  const treasureKeys = new Set(treasure.map((t) => key(t.x, t.y)));

  // --- clutter ---
  const freeFloor = [...plainFloor, ...deadEnds].filter((s) => !treasureKeys.has(key(s.x, s.y)));
  const floorProps = shuffle(rng, freeFloor)
    .slice(0, Math.floor(freeFloor.length * options.floorPropDensity));

  const freeWall = wallFaces.filter((s) => !torchKeys.has(key(s.x, s.y)));
  const wallProps = shuffle(rng, freeWall)
    .slice(0, Math.floor(freeWall.length * options.wallPropDensity));

  return { torches, treasure, floorProps, wallProps, deadEnds: deadEnds.length };
}

// --- keeping the map connected ----------------------------------------------

function countOpen(mask: boolean[][]): number {
  return mask.reduce((total, row) => total + row.filter(Boolean).length, 0);
}

export interface SealingCheck {
  /** Indices of `slots` that may be used. */
  kept: number[];
  /** Indices dropped because placing them would cut part of the map off. */
  sealed: number[];
}

/**
 * Drop the placements that would wall part of the map off.
 *
 * **Not every scatter prop is something you can walk over.** `Rubble` on
 * `Dungeon_B` is tile 120, flags `0x60f` — impassable from all four directions —
 * and it is one of `decorate_dungeon`'s four default floor props. Dropped in a
 * one-tile corridor it cuts off everything beyond, which is how a generated
 * dungeon ended up with an entrance the player could not reach.
 *
 * The guarantee is the one `addPillars` and `place_npc` already make, for the
 * same reason: a placement is accepted only if everything still reachable before
 * it is still reachable after. Checking is incremental rather than one pass at
 * the end, because two props that are each harmless alone can jointly pinch a
 * corridor shut.
 *
 * The test is relative — *no tile becomes unreachable* — rather than "the map is
 * fully connected", so a map that already had an isolated pocket is measured
 * against what it actually was instead of having every placement rejected.
 *
 * `blocks[i]` says whether the prop going at `slots[i]` makes its tile
 * impassable. Anything false is kept without a flood fill, which is most props:
 * gravel and crystals are walked over.
 */
export function rejectSealingSlots(
  floor: boolean[][],
  slots: Slot[],
  blocks: boolean[]
): SealingCheck {
  const kept: number[] = [];
  const sealed: number[] = [];
  if (slots.every((_, i) => !blocks[i])) {
    return { kept: slots.map((_, i) => i), sealed };
  }

  const grid = floor.map((row) => [...row]);
  const blocking = new Set(slots.filter((_, i) => blocks[i]).map((s) => key(s.x, s.y)));

  // The reference has to be a tile that stays open, or "still reachable from
  // here" would stop meaning anything half way through.
  let reference: Slot | null = null;
  for (let y = 0; y < grid.length && reference === null; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      if (grid[y][x] && !blocking.has(key(x, y))) { reference = { x, y }; break; }
    }
  }

  if (reference === null) {
    // Every open tile would be built on. Nothing solid can go down safely.
    slots.forEach((_, i) => (blocks[i] ? sealed : kept).push(i));
    return { kept, sealed };
  }

  let reached = floodFill(grid, reference.x, reference.y);
  let reachedCount = countOpen(reached);

  for (let i = 0; i < slots.length; i++) {
    if (!blocks[i]) { kept.push(i); continue; }

    const { x, y } = slots[i];
    if (!grid[y]?.[x]) { sealed.push(i); continue; }

    const wasReached = reached[y][x];
    grid[y][x] = false;
    const after = floodFill(grid, reference.x, reference.y);
    const afterCount = countOpen(after);

    // Losing the tile itself is expected; losing anything else is the seal.
    if (afterCount === reachedCount - (wasReached ? 1 : 0)) {
      kept.push(i);
      reached = after;
      reachedCount = afterCount;
    } else {
      grid[y][x] = true;
      sealed.push(i);
    }
  }

  return { kept, sealed };
}
