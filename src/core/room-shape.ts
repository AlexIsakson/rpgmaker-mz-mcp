import type { Rect } from './autotile.js';

/**
 * A room that is not a box.
 *
 * P5-07 put a number on visual review finding 7 for *material boundaries* and
 * P5-09 spent it on streets. This is the same finding for the thing a boundary
 * encloses: interior rooms, town blocks and dungeon rooms are all rectangles,
 * and hand-made ones are not.
 *
 * **The shape is measured, and it is a corner cut.** Over the 139 interior maps
 * the editor ships, every layer-0 floor region of 8+ tiles was reduced to its
 * *core* — opened with a 2x2 element, which erodes away doorway channels and
 * one-tile corridors and leaves the body of the room. That matters, because a
 * room's doorway alone already makes its raw footprint non-rectangular, so the
 * raw number (15.6% rectangular) flatters any generator that cuts a door. The
 * core is the honest question, and its answer is:
 *
 * | | of 191 room cores |
 * |---|---|
 * | exactly a rectangle | 81 (42.4%) |
 * | missing at least one bounding-box corner | **85 (44.5%)** |
 * | non-rectangular some other way | 25 (13.1%) |
 *
 * So the dominant non-rectangular room is *a rectangle with corners taken out
 * of it* — the same shape family P5-08 found for roofs, which is why this uses
 * P5-08's word for it. How many corners, over the same 191 cores:
 *
 * | corners cut | 0 | 1 | 2 | 3 | 4 |
 * |---|---|---|---|---|---|
 * | cores | 106 | 26 | 27 | 5 | 27 |
 *
 * {@link CORPUS_CORNER_WEIGHTS} is that row, used as-is. The 27 cores with all
 * four corners cut are the bevelled hall — a real and common hand-made room,
 * not a tail case.
 *
 * **How big a cut is** was measured over all 203 individual corner cuts, as a
 * fraction of the room's own size rather than in tiles, so it scales:
 *
 * | | p10 | median | p90 |
 * |---|---|---|---|
 * | cut width / room width | 0.08 | **0.24** | 0.54 |
 * | cut height / room height | 0.10 | **0.25** | 0.57 |
 *
 * {@link SHAPE_DEFAULTS} takes the p10..p90 band as its range — about a tenth
 * to about a half of each side, a quarter typically.
 *
 * **Connectivity is a property of the construction, not something checked
 * afterwards.** A rectangle with blocks removed at its corners has, in every
 * row, a contiguous interval of cells: the cuts can only take a prefix and a
 * suffix. `minSpan` keeps every row and every column non-empty, which means
 * some row survives at full width and some column at full height, and every
 * row's interval meets that full row. So the mask is 4-connected by argument.
 * The tests assert it across seeds anyway, because an argument is not a test.
 *
 * This module is pure: sizes and an RNG in, a mask out. It never sees a map.
 */

export type Corner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export const CORNERS: Corner[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];

/**
 * How many corners a hand-made room core has cut out of it, indexed by count:
 * 106 rooms with none, 26 with one, and so on, over 191 measured cores.
 */
export const CORPUS_CORNER_WEIGHTS = [106, 26, 27, 5, 27];

export const SHAPE_DEFAULTS = {
  /** The corpus row above. */
  cornerWeights: CORPUS_CORNER_WEIGHTS,
  /** p10 of the measured cut fractions. */
  minFraction: 0.09,
  /** p90 of the measured cut fractions. */
  maxFraction: 0.55,
  /**
   * Cells that must survive in every row and every column. Two is the smallest
   * that keeps a room a room; a one-tile span is a corridor, and the corpus
   * measured cores with the corridors already eroded off.
   */
  minSpan: 2,
};

export interface CornerCut {
  corner: Corner;
  /** Columns taken, measured in from that corner. */
  width: number;
  /** Rows taken, measured in from that corner. */
  height: number;
}

export interface RoomShapeOptions {
  /**
   * Relative chance of cutting 0, 1, 2, 3, 4 corners. Defaults to the corpus
   * row. Give `[1, 0, 0, 0, 0]` to force a plain rectangle.
   */
  cornerWeights?: number[];
  /** Smallest cut, as a fraction of the room's width and height. */
  minFraction?: number;
  /** Largest cut, as a fraction of the room's width and height. */
  maxFraction?: number;
  /** Cells that must survive in every row and every column. */
  minSpan?: number;
}

export interface RoomShape {
  width: number;
  height: number;
  /** `mask[y][x]` over a `width` x `height` box, origin at the box's top-left. */
  mask: boolean[][];
  /** The cuts that were actually made, in the order they were applied. */
  cuts: CornerCut[];
  /**
   * Set when the room was too small for the shape to be anything but a
   * rectangle, naming which dimension ran out. A caller that wants to know it
   * asked for something impossible can read this; nothing here throws, because
   * "this room is 4x3 so it stays a box" is a fact about the room, not a
   * mistake by the caller.
   */
  tooSmall: string | null;
}

function pickWeighted(rng: () => number, weights: number[]): number {
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (total <= 0) return 0;
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= Math.max(0, weights[i]);
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

function shuffle<T>(rng: () => number, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const isLeft = (c: Corner): boolean => c === 'topLeft' || c === 'bottomLeft';
const isTop = (c: Corner): boolean => c === 'topLeft' || c === 'topRight';

/**
 * Cut corners out of a `width` x `height` box.
 *
 * Each cut is a rectangle taken from one corner, sized as a fraction of the
 * room. A cut is only made if it leaves `minSpan` cells in every row and every
 * column it touches — which is what keeps the result connected, and what makes
 * a small room come back as the rectangle it has to be rather than as a
 * severed pair of stubs.
 *
 * The budget is tracked per side rather than per corner: two cuts on the same
 * edge of the room are the case that can sever it, and the second one is sized
 * against what the first one left.
 */
export function cutRoomCorners(
  width: number,
  height: number,
  rng: () => number,
  options: RoomShapeOptions = {}
): RoomShape {
  const cornerWeights = options.cornerWeights ?? SHAPE_DEFAULTS.cornerWeights;
  const minFraction = options.minFraction ?? SHAPE_DEFAULTS.minFraction;
  const maxFraction = options.maxFraction ?? SHAPE_DEFAULTS.maxFraction;
  const minSpan = options.minSpan ?? SHAPE_DEFAULTS.minSpan;

  const mask: boolean[][] = Array.from({ length: height }, () =>
    new Array<boolean>(width).fill(true)
  );
  const cuts: CornerCut[] = [];

  // The smallest cut worth making is one tile each way, so the room has to hold
  // minSpan plus that in both directions before any shape is possible at all.
  if (width < minSpan + 1 || height < minSpan + 1) {
    const which =
      width < minSpan + 1 && height < minSpan + 1
        ? 'both sides'
        : width < minSpan + 1
          ? 'width'
          : 'height';
    return {
      width,
      height,
      mask,
      cuts,
      tooSmall:
        `A ${width}x${height} room has no room to cut a corner from: its ${which} leaves fewer ` +
        `than ${minSpan} cells once a one-tile cut is taken. It stays a rectangle.`,
    };
  }

  const wanted = pickWeighted(rng, cornerWeights);
  // The shuffle runs whatever `wanted` is, so which corners get picked does not
  // depend on how many — the same seed cuts the same corners in the same order,
  // and only the count changes with the weights.
  const order = shuffle(rng, CORNERS).slice(0, wanted);

  // How many columns each vertical edge has already given up, and how many rows
  // each horizontal edge has. A cut on the left side of the top edge and one on
  // the left side of the bottom edge both eat into the left columns, but on
  // different rows — so the constraint that matters is per *row band*: the two
  // cuts that share a horizontal edge are the pair that can meet.
  const takenAlongTop = { left: 0, right: 0 };
  const takenAlongBottom = { left: 0, right: 0 };
  const takenDownLeft = { top: 0, bottom: 0 };
  const takenDownRight = { top: 0, bottom: 0 };

  for (const corner of order) {
    const alongEdge = isTop(corner) ? takenAlongTop : takenAlongBottom;
    const downEdge = isLeft(corner) ? takenDownLeft : takenDownRight;
    const otherSide = isLeft(corner) ? alongEdge.right : alongEdge.left;
    const otherEnd = isTop(corner) ? downEdge.bottom : downEdge.top;

    // Widest cut that still leaves minSpan in the rows this cut touches, and
    // tallest that leaves minSpan in the columns it touches.
    const maxCutW = width - otherSide - minSpan;
    const maxCutH = height - otherEnd - minSpan;
    if (maxCutW < 1 || maxCutH < 1) continue;

    const cutW = Math.min(maxCutW, Math.max(1, Math.round(width * fraction(rng, minFraction, maxFraction))));
    const cutH = Math.min(maxCutH, Math.max(1, Math.round(height * fraction(rng, minFraction, maxFraction))));

    const x0 = isLeft(corner) ? 0 : width - cutW;
    const y0 = isTop(corner) ? 0 : height - cutH;
    for (let y = y0; y < y0 + cutH; y++) {
      for (let x = x0; x < x0 + cutW; x++) mask[y][x] = false;
    }

    if (isLeft(corner)) alongEdge.left = Math.max(alongEdge.left, cutW);
    else alongEdge.right = Math.max(alongEdge.right, cutW);
    if (isTop(corner)) downEdge.top = Math.max(downEdge.top, cutH);
    else downEdge.bottom = Math.max(downEdge.bottom, cutH);

    cuts.push({ corner, width: cutW, height: cutH });
  }

  return { width, height, mask, cuts, tooSmall: null };
}

function fraction(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** The shape's cells, offset to sit at `rect`'s top-left. */
export function shapeCells(shape: RoomShape, rect: Rect): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < shape.height; y++) {
    for (let x = 0; x < shape.width; x++) {
      if (shape.mask[y][x]) cells.push({ x: rect.x + x, y: rect.y + y });
    }
  }
  return cells;
}

/**
 * The rows a column of the mask occupies, as one interval, or null if the
 * column is empty.
 *
 * Every column of a corner-cut room is a single interval — the cuts take a
 * prefix and a suffix and nothing in between — which is what lets the interior
 * wall builder work a column at a time rather than flood-filling.
 */
export function columnSpan(mask: boolean[][], x: number): { top: number; bottom: number } | null {
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < mask.length; y++) {
    if (!mask[y]?.[x]) continue;
    if (top < 0) top = y;
    bottom = y;
  }
  return top < 0 ? null : { top, bottom };
}

/** Whether every filled cell of the mask is reachable from every other, 4-connected. */
export function isConnected(mask: boolean[][]): boolean {
  const height = mask.length;
  const width = mask[0]?.length ?? 0;
  let start: [number, number] | null = null;
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y][x]) continue;
      total++;
      start ??= [x, y];
    }
  }
  if (start === null) return true;

  const seen = Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
  const queue: [number, number][] = [start];
  seen[start[1]][start[0]] = true;
  let reached = 0;
  while (queue.length > 0) {
    const [x, y] = queue.pop()!;
    reached++;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as [number, number][]) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (seen[ny][nx] || !mask[ny][nx]) continue;
      seen[ny][nx] = true;
      queue.push([nx, ny]);
    }
  }
  return reached === total;
}
