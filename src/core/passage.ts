import { PASSAGE_SHEETS, type SheetPassage } from './passage-catalogue.js';
import {
  PASSAGE_BIT,
  FLAG_STAR,
  FLAG_LADDER,
  FLAG_BUSH,
  FLAG_COUNTER,
  FLAG_DAMAGE_FLOOR,
} from './map-grid.js';

/**
 * Writing a tileset's passage flags.
 *
 * This is the gap everything else in the generator stack sat on top of. A
 * generated wall only blocks if its material is configured impassable, and that
 * lives in `Tilesets.json` rather than in map data — so a project whose tileset
 * was never set up in the editor produces maps where geometry has no effect at
 * all. `check_project` has flagged that as `tileset-passage-unconfigured` since
 * phase 4; nothing could fix it.
 *
 * **Which materials are solid cannot be derived.** It is authored art direction,
 * not something measurable from the image — a cliff face and a cobbled floor are
 * both opaque rectangles of pixels. So the flags are taken from the tilesets the
 * editor itself ships, via `passage-catalogue.ts`.
 *
 * **What makes that possible is that flags are a property of the sheet, not of
 * the tileset**, which was measured rather than assumed: across 68 configured
 * tilesets from 9 databases, 56 of 62 sheets carry identical flags everywhere
 * they appear. The six that vary are recorded in the catalogue's header along
 * with which source was believed.
 *
 * This module is pure: it computes flag arrays and never touches a file.
 */

/** A tileset's nine sheet slots, in `tilesetNames` order. */
export interface SlotRange {
  name: string;
  /** Index into `tilesetNames`. */
  index: number;
  /** First tile id the slot owns. */
  start: number;
  /** How many tile ids. */
  count: number;
}

export const SLOTS: SlotRange[] = [
  { name: 'A1', index: 0, start: 2048, count: 768 },
  { name: 'A2', index: 1, start: 2816, count: 1536 },
  { name: 'A3', index: 2, start: 4352, count: 1536 },
  { name: 'A4', index: 3, start: 5888, count: 2304 },
  { name: 'A5', index: 4, start: 1536, count: 512 },
  { name: 'B', index: 5, start: 0, count: 256 },
  { name: 'C', index: 6, start: 256, count: 256 },
  { name: 'D', index: 7, start: 512, count: 256 },
  { name: 'E', index: 8, start: 768, count: 256 },
];

/** Tile ids run 0..8191; a tileset's `flags` array is that long when configured. */
export const FLAGS_LENGTH = 8192;

export class PassageError extends Error {}

/** [flag, repeatCount] pairs back into one value per tile. */
export function expandRuns(runs: [number, number][]): number[] {
  const values: number[] = [];
  for (const [flag, count] of runs) {
    for (let i = 0; i < count; i++) values.push(flag);
  }
  return values;
}

export function sheetPassage(sheetName: string): SheetPassage | undefined {
  return PASSAGE_SHEETS[sheetName];
}

export function catalogueSheetNames(): string[] {
  return Object.keys(PASSAGE_SHEETS).sort();
}

/**
 * An unconfigured tileset's `flags` can be shorter than the full tile range —
 * one seen in the wild carried 1536 of 8192 entries. Anything missing reads as
 * `undefined`, so it is padded rather than left to become `NaN` on the first
 * bitwise operation.
 */
export function normaliseFlags(flags: number[]): number[] {
  const out = new Array<number>(FLAGS_LENGTH).fill(0);
  for (let i = 0; i < Math.min(flags.length, FLAGS_LENGTH); i++) {
    out[i] = Number.isFinite(flags[i]) ? flags[i] : 0;
  }
  return out;
}

export interface SlotPlan {
  slot: SlotRange;
  sheetName: string;
  /** Catalogued flags for the slot's tile range. */
  values: number[];
  /** How many of them differ from what the tileset currently has. */
  changed: number;
  /** Set when the catalogue holds this sheet under a different slot. */
  borrowedFromSlot?: string;
}

export interface TilesetPassagePlan {
  slots: SlotPlan[];
  /** Slots naming a sheet the catalogue has never seen. */
  unknown: { slot: SlotRange; sheetName: string }[];
  /** Slots with no sheet set. */
  empty: SlotRange[];
  /** Total tiles whose flags would change. */
  changed: number;
}

/**
 * Work out what a tileset's flags should be, without writing anything.
 *
 * A sheet is matched by name. **The slot it is used in may differ from the slot
 * it was catalogued in** — the B/C/D/E object slots are interchangeable, so a
 * project is free to put `Outside_C` in slot D. The catalogued values are
 * relative to the slot's start, so they transfer as long as the two slots hold
 * the same number of tiles; an A-slot mismatch cannot transfer and is reported
 * as unknown rather than written wrong.
 */
export function planTilesetPassage(
  tilesetNames: string[],
  currentFlags: number[]
): TilesetPassagePlan {
  const flags = normaliseFlags(currentFlags);
  const slots: SlotPlan[] = [];
  const unknown: { slot: SlotRange; sheetName: string }[] = [];
  const empty: SlotRange[] = [];
  let changed = 0;

  for (const slot of SLOTS) {
    const sheetName = tilesetNames[slot.index] ?? '';
    if (sheetName === '') { empty.push(slot); continue; }

    const entry = sheetPassage(sheetName);
    if (!entry) { unknown.push({ slot, sheetName }); continue; }

    const values = expandRuns(entry.runs);
    if (values.length !== slot.count) {
      // Catalogued under a slot of a different size — an A-sheet in an object
      // slot or the reverse. Nothing sensible to write.
      unknown.push({ slot, sheetName });
      continue;
    }

    let slotChanged = 0;
    for (let i = 0; i < values.length; i++) {
      if (flags[slot.start + i] !== values[i]) slotChanged++;
    }
    changed += slotChanged;

    slots.push({
      slot,
      sheetName,
      values,
      changed: slotChanged,
      borrowedFromSlot: entry.slot === slot.name ? undefined : entry.slot,
    });
  }

  return { slots, unknown, empty, changed };
}

/** Apply a plan, returning a fresh flags array. */
export function applyTilesetPassage(
  currentFlags: number[],
  plan: TilesetPassagePlan
): number[] {
  const flags = normaliseFlags(currentFlags);
  for (const slotPlan of plan.slots) {
    for (let i = 0; i < slotPlan.values.length; i++) {
      flags[slotPlan.slot.start + i] = slotPlan.values[i];
    }
  }
  return flags;
}

// --- targeted edits ----------------------------------------------------------

/**
 * A change to make, expressed the way a person thinks about it.
 *
 * **Passability is stated positively here and stored inverted.** In the file a
 * *set* bit means blocked, which reads backwards every single time; `passable:
 * false` sets all four bits, and `up: true` clears the one for up.
 */
export interface PassageSpec {
  /** All four directions at once. */
  passable?: boolean;
  down?: boolean;
  left?: boolean;
  right?: boolean;
  up?: boolean;
  /** `[*]` — no effect on passage, fall through to the layer below. */
  star?: boolean;
  ladder?: boolean;
  bush?: boolean;
  counter?: boolean;
  damageFloor?: boolean;
  /** 0-7. */
  terrainTag?: number;
}

const TERRAIN_SHIFT = 12;
const TERRAIN_MASK = 0xf << TERRAIN_SHIFT;

function applySpec(flag: number, spec: PassageSpec): number {
  let next = flag;

  const setBlocked = (bit: number, passable: boolean) => {
    next = passable ? next & ~bit : next | bit;
  };

  if (spec.passable !== undefined) {
    const all = PASSAGE_BIT.down | PASSAGE_BIT.left | PASSAGE_BIT.right | PASSAGE_BIT.up;
    setBlocked(all, spec.passable);
  }
  if (spec.down !== undefined) setBlocked(PASSAGE_BIT.down, spec.down);
  if (spec.left !== undefined) setBlocked(PASSAGE_BIT.left, spec.left);
  if (spec.right !== undefined) setBlocked(PASSAGE_BIT.right, spec.right);
  if (spec.up !== undefined) setBlocked(PASSAGE_BIT.up, spec.up);

  // These read the normal way round: set means the property is on.
  const toggle = (bit: number, on: boolean | undefined) => {
    if (on === undefined) return;
    next = on ? next | bit : next & ~bit;
  };
  toggle(FLAG_STAR, spec.star);
  toggle(FLAG_LADDER, spec.ladder);
  toggle(FLAG_BUSH, spec.bush);
  toggle(FLAG_COUNTER, spec.counter);
  toggle(FLAG_DAMAGE_FLOOR, spec.damageFloor);

  if (spec.terrainTag !== undefined) {
    next = (next & ~TERRAIN_MASK) | ((spec.terrainTag & 0xf) << TERRAIN_SHIFT);
  }

  return next >>> 0;
}

export interface EditResult {
  flags: number[];
  /** Tiles whose flag value actually changed. */
  changed: number;
  /** Tile ids outside 0..8191, discarded. */
  outOfRange: number[];
}

export function setPassageFlags(
  currentFlags: number[],
  tileIds: number[],
  spec: PassageSpec
): EditResult {
  if (spec.terrainTag !== undefined && (spec.terrainTag < 0 || spec.terrainTag > 7)) {
    throw new PassageError(`terrainTag must be 0-7; got ${spec.terrainTag}.`);
  }

  const flags = normaliseFlags(currentFlags);
  const outOfRange: number[] = [];
  let changed = 0;

  for (const tileId of tileIds) {
    if (!Number.isInteger(tileId) || tileId < 0 || tileId >= FLAGS_LENGTH) {
      outOfRange.push(tileId);
      continue;
    }
    const next = applySpec(flags[tileId], spec);
    if (next !== flags[tileId]) changed++;
    flags[tileId] = next;
  }

  return { flags, changed, outOfRange };
}

/** Human-readable rendering of one flag value, for reports. */
export function describeFlag(flag: number): string {
  const blocked: string[] = [];
  if (flag & PASSAGE_BIT.down) blocked.push('down');
  if (flag & PASSAGE_BIT.left) blocked.push('left');
  if (flag & PASSAGE_BIT.right) blocked.push('right');
  if (flag & PASSAGE_BIT.up) blocked.push('up');

  const parts: string[] = [];
  if (blocked.length === 4) parts.push('impassable');
  else if (blocked.length === 0) parts.push('passable');
  else parts.push(`blocked ${blocked.join('/')}`);

  if (flag & FLAG_STAR) parts.push('star');
  if (flag & FLAG_LADDER) parts.push('ladder');
  if (flag & FLAG_BUSH) parts.push('bush');
  if (flag & FLAG_COUNTER) parts.push('counter');
  if (flag & FLAG_DAMAGE_FLOOR) parts.push('damage');
  const terrain = (flag & TERRAIN_MASK) >>> TERRAIN_SHIFT;
  if (terrain !== 0) parts.push(`terrain ${terrain}`);

  return parts.join(', ');
}
