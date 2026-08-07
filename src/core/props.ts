import { PROP_SHEETS, type PropEntry } from './prop-catalogue.js';
import { SHEET_HALF_WIDTH, TILES_PER_SHEET } from './blueprint.js';

/**
 * Named objects — barrels, signs, trees, windows — addressed by name instead of
 * by raw tile id.
 *
 * The names are not invented here. RPG Maker MZ ships a `.txt` beside every
 * tileset PNG holding the editor's own label for each of its 256 tiles, and a
 * prop is a connected run of tiles sharing a label. `prop-catalogue.ts` is
 * generated from those files by `scripts/build-prop-catalogue.mjs`; the labels
 * were spot-checked by rendering the props they name, and they match.
 *
 * **A name often covers an object together with its filler variants.** `Tree` on
 * `Outside_B` is a 2x2 box holding a 1x2 tree in its left column and a canopy
 * filler above right — the fourth cell is a separate prop called `Bush`, which
 * is why the box has a hole in it. `Large Tree` is 4x2: a 2x2 tree plus the 2x2
 * mass used to fill the middle of a grove. So placing a whole prop is right for
 * the 1x1 objects that make up most of a sheet, and for the rest the caller
 * usually wants a sub-rectangle of it.
 *
 * Tile ids in the catalogue are sheet-local (0-255). Which tile id a prop
 * actually has depends on the slot its sheet occupies in the tileset, so
 * nothing here is meaningful until it has been resolved against a real
 * `tilesetNames`.
 */

/** Slots 5-8 of a tileset's names are the B, C, D and E object sheets. */
export const OBJECT_SLOTS = [5, 6, 7, 8] as const;

export function slotBase(slot: number): number {
  return (slot - OBJECT_SLOTS[0]) * TILES_PER_SHEET;
}

export interface Prop {
  name: string;
  /** Sheet file name, e.g. `Outside_B`. */
  sheet: string;
  /** Index into the tileset's `tilesetNames`. */
  slot: number;
  /** Tile id of the top-left cell, offset for the sheet's slot. */
  topLeft: number;
  width: number;
  height: number;
  /** Which cells the prop occupies, row-major. Ragged props have gaps. */
  cells: boolean[];
}

function decode(entry: PropEntry, sheet: string, slot: number): Prop {
  const [name, topLeft, width, height, mask] = entry;
  return {
    name,
    sheet,
    slot,
    topLeft: topLeft + slotBase(slot),
    width,
    height,
    cells: mask
      ? [...mask].map((c) => c === '1')
      : new Array(width * height).fill(true),
  };
}

/**
 * Every prop the tileset's object sheets offer.
 *
 * A sheet the catalogue has never seen — a custom or DLC one — contributes
 * nothing rather than failing, so a project using its own art still works
 * through raw tile ids.
 */
export function collectProps(tilesetNames: string[]): Prop[] {
  const props: Prop[] = [];
  for (const slot of OBJECT_SLOTS) {
    const sheet = tilesetNames[slot];
    const entries = sheet ? PROP_SHEETS[sheet] : undefined;
    if (!entries) continue;
    for (const entry of entries) props.push(decode(entry, sheet, slot));
  }
  return props;
}

/** Object sheets of this tileset the catalogue has no names for. */
export function unknownSheets(tilesetNames: string[]): string[] {
  return OBJECT_SLOTS.map((slot) => tilesetNames[slot])
    .filter((sheet): sheet is string => Boolean(sheet) && !PROP_SHEETS[sheet]);
}

/**
 * Find props by name: an exact case-insensitive match if there is one,
 * otherwise everything containing the query.
 *
 * Exact-first matters because the sheets are full of names that are prefixes of
 * others — `Tree` against `Dead Tree`, `Large Tree`, `Palm Tree` — and a caller
 * asking for `Tree` means the tree.
 */
export function findProps(props: Prop[], query: string): Prop[] {
  const needle = query.trim().toLowerCase();
  const exact = props.filter((p) => p.name.toLowerCase() === needle);
  if (exact.length > 0) return exact;
  return props.filter((p) => p.name.toLowerCase().includes(needle));
}

export interface PropCell {
  /** Offset from the prop's top-left, in tiles. */
  dx: number;
  dy: number;
  tileId: number;
}

/**
 * The tiles a prop is made of.
 *
 * Cell (row, col) is `topLeft + row * 8 + col` because the object sheets are 16
 * tiles wide but addressed as two 8-wide halves — the same arithmetic the
 * nine-slice roofs use. No prop in the catalogue straddles that boundary; the
 * generator asserts it.
 */
export function propCells(prop: Prop): PropCell[] {
  const cells: PropCell[] = [];
  for (let dy = 0; dy < prop.height; dy++) {
    for (let dx = 0; dx < prop.width; dx++) {
      if (!prop.cells[dy * prop.width + dx]) continue;
      cells.push({ dx, dy, tileId: prop.topLeft + dy * SHEET_HALF_WIDTH + dx });
    }
  }
  return cells;
}

export interface PropPart {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class PropError extends Error {}

/**
 * Narrow a prop to a sub-rectangle of itself — how you take just the tree out of
 * `Tree` without its canopy filler.
 */
export function propPart(prop: Prop, part: PropPart): Prop {
  if (
    part.width < 1 ||
    part.height < 1 ||
    part.x < 0 ||
    part.y < 0 ||
    part.x + part.width > prop.width ||
    part.y + part.height > prop.height
  ) {
    throw new PropError(
      `Part ${part.width}x${part.height} at (${part.x}, ${part.y}) is outside "${prop.name}", ` +
        `which is ${prop.width}x${prop.height}.`
    );
  }

  const cells: boolean[] = [];
  for (let dy = 0; dy < part.height; dy++) {
    for (let dx = 0; dx < part.width; dx++) {
      cells.push(prop.cells[(part.y + dy) * prop.width + (part.x + dx)]);
    }
  }

  if (!cells.some(Boolean)) {
    throw new PropError(`That part of "${prop.name}" holds no tiles.`);
  }

  return {
    ...prop,
    topLeft: prop.topLeft + part.y * SHEET_HALF_WIDTH + part.x,
    width: part.width,
    height: part.height,
    cells,
  };
}

/**
 * Which prop owns a given tile id, if any.
 *
 * This is what turns a gap in a ragged prop from a mystery into an instruction:
 * the hole in `Tree`'s 2x2 box is a `Bush`, and the one in `Tent A` is
 * `Tent A (Entrance)`, so the caller can be told what goes there.
 */
export function propAtTile(props: Prop[], tileId: number): Prop | undefined {
  return props.find((p) => propCells(p).some((c) => c.tileId === tileId));
}

/** The cells a prop leaves empty inside its own bounding box, and what fills them. */
export function propGaps(
  props: Prop[],
  prop: Prop
): { dx: number; dy: number; filledBy: string | null }[] {
  const gaps: { dx: number; dy: number; filledBy: string | null }[] = [];
  for (let dy = 0; dy < prop.height; dy++) {
    for (let dx = 0; dx < prop.width; dx++) {
      if (prop.cells[dy * prop.width + dx]) continue;
      const tileId = prop.topLeft + dy * SHEET_HALF_WIDTH + dx;
      gaps.push({ dx, dy, filledBy: propAtTile(props, tileId)?.name ?? null });
    }
  }
  return gaps;
}

/** Render a prop's cell layout as text — `#` occupied, `.` empty. */
export function propShape(prop: Prop): string[] {
  const rows: string[] = [];
  for (let dy = 0; dy < prop.height; dy++) {
    let row = '';
    for (let dx = 0; dx < prop.width; dx++) row += prop.cells[dy * prop.width + dx] ? '#' : '.';
    rows.push(row);
  }
  return rows;
}
