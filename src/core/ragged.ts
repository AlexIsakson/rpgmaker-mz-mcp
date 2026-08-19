import type { Rect } from './autotile.js';

/**
 * Ragged silhouettes for ground materials.
 *
 * Visual review finding 7 — *everything the generators emit is a rectangle* —
 * finally has a number opposite it, and this is the module that answers it.
 * P5-07 measured every material boundary on layer 0 of the 293 hand-made sample
 * maps and of a generated town, using `scripts/measure-map-shape.mjs`:
 *
 * | | hand-made (293 maps) | `generate_town` |
 * |---|---|---|
 * | median boundary run | **1** | 4 |
 * | mean | 1.73 | 6.31 |
 * | p90 | 3 | 15 |
 * | **p99** | **9** | 19 |
 * | share of boundary length in runs of 4+ | 30.9% | 87.6% |
 *
 * A *boundary run* is how far the same ordered pair of materials stays on the
 * same two sides of a line before either side changes — how far an edge goes
 * without turning. **70.5% of all hand-made runs are a single tile.** A
 * rectangle painted by `fill_map_region` emits four runs as long as its sides.
 *
 * Two numbers out of that table are what this module is built to:
 *
 *  - **{@link RAGGED_DEFAULTS}`.maxRun` is 9, the corpus p99.** A run longer
 *    than 9 is something under 1% of hand-made runs do, so it is the one
 *    threshold the corpus states outright. It is enforced by construction: the
 *    edge is *made* to turn once it has gone that far, rather than being
 *    checked afterwards.
 *  - **`turnChance` is 0.7, from the 70.5% of runs that are one tile long.**
 *    That is a weaker claim than the cap and is marked as such: a geometric
 *    series with p = 0.705 has the right median and the right share of
 *    single-tile runs, but the corpus tail is much fatter than geometric (its
 *    longest run is 45), because hand-made maps mix organic edges with
 *    deliberate straight ones. This reproduces the *typical* edge, not the
 *    whole distribution.
 *
 * **The edge is a bounded walk, and the render is why.** The first version
 * picked each new offset independently from the whole range at amplitude 1, so
 * the edge alternated between two levels and came out a regular comb — a
 * battlement, not a path. It satisfied every number above and looked worse than
 * the straight line it replaced. Stepping by one from where the edge already is,
 * over a range of {@link RAGGED_DEFAULTS}`.amplitude` = 2, gives the same run
 * lengths with somewhere to go: the edge drifts, and a two-tile street painted
 * this way varies between two and six tiles wide instead of jittering about a
 * fixed one. That is the difference between "the boundary turns" and "the road
 * bends and changes width", and only the second one survives being looked at.
 *
 * This module is pure: it is handed a rectangle and an RNG and returns a mask.
 */

export interface RaggedEdges {
  top?: boolean;
  bottom?: boolean;
  left?: boolean;
  right?: boolean;
}

export interface RaggedOptions {
  /** How far the edge may stray from where the rectangle put it. */
  amplitude?: number;
  /** Chance the edge takes a step at each cell along it. */
  turnChance?: number;
  /** How far an edge may run straight before it is forced to turn. */
  maxRun?: number;
  /**
   * The patch never pinches below this across the axis being ragged. A 2-tile
   * road with `minThickness` 2 can only ever bulge outward, which is what keeps
   * a street a street.
   */
  minThickness?: number;
  /** Which sides may move. Default: all four. */
  edges?: RaggedEdges;
  /**
   * Where this patch may **grow**. An edge will not move onto a cell this
   * rejects — so a street can widen into open ground and not into the house
   * beside it, or the tree line.
   *
   * It says nothing about the rectangle that was asked for: those cells are the
   * caller's and are never given up, or a street that runs through something
   * would come out severed. Clipping the rectangle itself is the caller's job,
   * before the call. Defaults to "anywhere".
   */
  available?: (x: number, y: number) => boolean;
}

export const RAGGED_DEFAULTS = {
  /** How far the walk may stray from the rectangle. See the note above. */
  amplitude: 2,
  /** From 70.5% of hand-made runs being one tile long. A stated fit, not a law. */
  turnChance: 0.7,
  /** The corpus p99. Under 1% of hand-made runs are longer than this. */
  maxRun: 9,
  minThickness: 1,
};

export interface RaggedPatch {
  /** Bounding box of the mask, which can be larger than the rectangle asked for. */
  rect: Rect;
  /** Occupancy over {@link rect}. */
  mask: boolean[][];
  /** The cells, absolute, for a caller that paints cell by cell. */
  cells: { x: number; y: number }[];
  /**
   * The longest straight boundary run the result actually has, measured the way
   * the corpus was measured. Reported rather than promised: where `available`
   * refuses every alternative — a street running past a long wall — the edge has
   * nowhere to turn to, and saying so beats claiming a cap that did not hold.
   */
  longestRun: number;
}

/**
 * One edge's displacement, cell by cell along it.
 *
 * `legal(i, offset)` is asked before any offset is used, so an edge that cannot
 * move stays put instead of being pushed through a wall.
 *
 * **The forced turn has to look ahead, and finding that out cost a measurement.**
 * Turning only once the run has already reached `maxRun` is not enough when the
 * edge can be *pinned*: a street's near side cannot bulge where a house stands
 * against it, so a run that hits the cap in the gap between two houses carries
 * on through the next house and comes out at `maxRun` plus the house's width.
 * The first version of this did exactly that, and a 44x46 town came out with a
 * longest run of **16 — the 9 cap plus a 7-wide building** — on the seeds where
 * it went wrong, 11 of 25. So the decision to turn is made against the *runway*:
 * how many cells ahead the edge has no alternative at all. Turn while there is
 * still somewhere to turn to.
 *
 * What survives is a conditional guarantee, and it is the honest one: the cap
 * holds unless the edge is pinned for more than `maxRun - 1` cells in a row, in
 * which case no rule could have helped and {@link RaggedPatch.longestRun} says so.
 */
function offsetSeries(
  count: number,
  rng: () => number,
  legal: (index: number, offset: number) => boolean,
  options: { amplitude: number; turnChance: number; maxRun: number }
): number[] {
  const { turnChance, maxRun } = options;
  const amplitude = options.amplitude;
  const choices: number[] = [];
  for (let o = -amplitude; o <= amplitude; o++) choices.push(o);

  // Where the edge has two or more legal offsets it can move; where it has one
  // it is pinned. runway[i] counts the pinned cells from i onward. This is a
  // slight over-estimate of freedom — the walk can only reach a neighbour of
  // where it is — which is the safe direction to be wrong in: it makes the
  // forced turn fire earlier, never later.
  const pinned: boolean[] = [];
  for (let i = 0; i < count; i++) {
    pinned.push(choices.filter((o) => legal(i, o)).length < 2);
  }
  const runway: number[] = new Array<number>(count + 1).fill(0);
  for (let i = count - 1; i >= 0; i--) runway[i] = pinned[i] ? runway[i + 1] + 1 : 0;

  const series: number[] = [];
  let current = 0;
  let run = 0;

  for (let i = 0; i < count; i++) {
    // Staying put here means running on through everything pinned after it.
    const mustTurn = run + 1 + runway[i + 1] > maxRun;
    const wantTurn = mustTurn || rng() < turnChance;

    let next = legal(i, current) ? current : null;
    if (wantTurn || next === null) {
      // One step from where the edge is, not a jump to anywhere in range: that
      // is what makes it drift rather than alternate. See the note on the walk
      // at the top of the file.
      const steps = [current - 1, current + 1].filter((o) => legal(i, o));
      if (steps.length > 0) next = steps[Math.floor(rng() * steps.length)];
    }
    if (next === null) next = 0; // nowhere legal at all: fall back to the rectangle

    run = next === current && i > 0 ? run + 1 : 1;
    current = next;
    series.push(current);
  }

  return series;
}

/**
 * The longest straight run of this mask's own boundary, using the corpus
 * definition: a boundary cell pair counts as continuing a run while the same
 * side stays inside and the same side stays outside.
 *
 * Measured on the mask rather than on the map, so it answers "how straight is
 * this patch's edge" and not "how straight is every boundary on layer 0". The
 * two agree when the patch is painted onto a uniform base, which is the case
 * the generators produce.
 */
export function longestBoundaryRun(mask: boolean[][]): number {
  const height = mask.length;
  const width = mask[0]?.length ?? 0;
  const at = (x: number, y: number): boolean =>
    y >= 0 && y < height && x >= 0 && x < width && mask[y][x];

  let longest = 0;
  const walk = (steps: number, along: number, pair: (s: number, a: number) => string | null) => {
    for (let s = 0; s <= steps; s++) {
      let run = 0;
      let previous: string | null = null;
      for (let a = 0; a < along; a++) {
        const p = pair(s, a);
        if (p !== null && p === previous) run++;
        else {
          if (run > longest) longest = run;
          run = p === null ? 0 : 1;
          previous = p;
        }
      }
      if (run > longest) longest = run;
    }
  };

  // The boundary rows include the two just outside the mask, so a patch that
  // touches the bounding box still has its outer edge counted.
  walk(height, width, (y, x) => {
    const a = at(x, y - 1);
    const b = at(x, y);
    return a === b ? null : `${a}|${b}`;
  });
  walk(width, height, (x, y) => {
    const a = at(x - 1, y);
    const b = at(x, y);
    return a === b ? null : `${a}|${b}`;
  });

  return longest;
}

/** Keep only the largest 4-connected group of the mask. */
function largestComponent(mask: boolean[][]): boolean[][] {
  const height = mask.length;
  const width = mask[0]?.length ?? 0;
  const seen: number[][] = Array.from({ length: height }, () => new Array<number>(width).fill(0));
  let best: [number, number][] = [];
  let label = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y][x] || seen[y][x] !== 0) continue;
      label++;
      const group: [number, number][] = [];
      const queue: [number, number][] = [[x, y]];
      seen[y][x] = label;
      while (queue.length > 0) {
        const [cx, cy] = queue.pop()!;
        group.push([cx, cy]);
        for (const [nx, ny] of [
          [cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1],
        ] as [number, number][]) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (!mask[ny][nx] || seen[ny][nx] !== 0) continue;
          seen[ny][nx] = label;
          queue.push([nx, ny]);
        }
      }
      if (group.length > best.length) best = group;
    }
  }

  const kept = Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
  for (const [x, y] of best) kept[y][x] = true;
  return kept;
}

/**
 * Give a rectangle an edge that turns.
 *
 * Each ragged side gets its own displacement series along it — one per column
 * for the top and bottom, one per row for the left and right — and the mask is
 * where all four agree. Both axes together can leave a cell stranded at a
 * corner, so the result is reduced to its largest connected group; that only
 * ever removes cells, and removing a cell can shorten a boundary run but never
 * lengthen one, so the cap survives it.
 *
 * The rectangle asked for is never *entirely* lost: `minThickness` bounds how
 * far opposite edges may close on each other, and a patch already thinner than
 * that simply cannot move inward at all.
 */
export function raggedRect(
  rect: Rect,
  rng: () => number,
  options: RaggedOptions = {}
): RaggedPatch {
  const amplitude = options.amplitude ?? RAGGED_DEFAULTS.amplitude;
  const turnChance = options.turnChance ?? RAGGED_DEFAULTS.turnChance;
  const maxRun = options.maxRun ?? RAGGED_DEFAULTS.maxRun;
  const minThickness = options.minThickness ?? RAGGED_DEFAULTS.minThickness;
  const edges = options.edges ?? { top: true, bottom: true, left: true, right: true };
  const available = options.available ?? (() => true);

  const left = rect.x;
  const right = rect.x + rect.width - 1;
  const top = rect.y;
  const bottom = rect.y + rect.height - 1;

  // How far each side may move *in*, so the two never close past minThickness.
  // Split evenly, and never negative — a rectangle already at the minimum just
  // does not get an inward option.
  const inwardV = Math.max(0, Math.min(amplitude, Math.floor((rect.height - minThickness) / 2)));
  const inwardH = Math.max(0, Math.min(amplitude, Math.floor((rect.width - minThickness) / 2)));

  // A side's offset is signed outward-negative for top/left and
  // outward-positive for bottom/right, so "the edge moved out" is one sign
  // everywhere and the inward clamp is the other.
  const topOff = edges.top
    ? offsetSeries(
        rect.width,
        rng,
        (i, o) =>
          o >= -amplitude && o <= inwardV &&
          (o >= 0 || columnFree(left + i, top + o, top - 1, available)),
        { amplitude, turnChance, maxRun }
      )
    : new Array<number>(rect.width).fill(0);

  const bottomOff = edges.bottom
    ? offsetSeries(
        rect.width,
        rng,
        (i, o) =>
          o <= amplitude && o >= -inwardV &&
          (o <= 0 || columnFree(left + i, bottom + 1, bottom + o, available)),
        { amplitude, turnChance, maxRun }
      )
    : new Array<number>(rect.width).fill(0);

  const leftOff = edges.left
    ? offsetSeries(
        rect.height,
        rng,
        (i, o) =>
          o >= -amplitude && o <= inwardH &&
          (o >= 0 || rowFree(top + i, left + o, left - 1, available)),
        { amplitude, turnChance, maxRun }
      )
    : new Array<number>(rect.height).fill(0);

  const rightOff = edges.right
    ? offsetSeries(
        rect.height,
        rng,
        (i, o) =>
          o <= amplitude && o >= -inwardH &&
          (o <= 0 || rowFree(top + i, right + 1, right + o, available)),
        { amplitude, turnChance, maxRun }
      )
    : new Array<number>(rect.height).fill(0);

  const boxLeft = left - amplitude;
  const boxTop = top - amplitude;
  const boxWidth = rect.width + amplitude * 2;
  const boxHeight = rect.height + amplitude * 2;

  // A cell belongs when its column's vertical span reaches it *and* its row's
  // horizontal span does. A cell outside the rectangle on one axis — a bulge —
  // has no series entry of its own, so it inherits the nearest one: the bulge
  // to the left of the patch is as tall as the patch's first column.
  const clamp = (i: number, n: number) => Math.min(n - 1, Math.max(0, i));

  let mask = Array.from({ length: boxHeight }, () => new Array<boolean>(boxWidth).fill(false));
  for (let y = boxTop; y < boxTop + boxHeight; y++) {
    for (let x = boxLeft; x < boxLeft + boxWidth; x++) {
      const ci = clamp(x - left, rect.width);
      const ri = clamp(y - top, rect.height);
      const inColumn = y >= top + topOff[ci] && y <= bottom + bottomOff[ci];
      const inRow = x >= left + leftOff[ri] && x <= right + rightOff[ri];
      if (!inColumn || !inRow) continue;
      // Growth is subject to `available`; the rectangle itself is not.
      const inside =
        x >= left && x <= right && y >= top && y <= bottom;
      if (!inside && !available(x, y)) continue;
      mask[y - boxTop][x - boxLeft] = true;
    }
  }

  mask = largestComponent(mask);

  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < boxHeight; y++) {
    for (let x = 0; x < boxWidth; x++) {
      if (mask[y][x]) cells.push({ x: boxLeft + x, y: boxTop + y });
    }
  }

  return {
    rect: { x: boxLeft, y: boxTop, width: boxWidth, height: boxHeight },
    mask,
    cells,
    longestRun: longestBoundaryRun(mask),
  };
}

/** Every cell of column `x` from `y0` to `y1` inclusive is available. */
function columnFree(
  x: number,
  y0: number,
  y1: number,
  available: (x: number, y: number) => boolean
): boolean {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    if (!available(x, y)) return false;
  }
  return true;
}

/** Every cell of row `y` from `x0` to `x1` inclusive is available. */
function rowFree(
  y: number,
  x0: number,
  x1: number,
  available: (x: number, y: number) => boolean
): boolean {
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
    if (!available(x, y)) return false;
  }
  return true;
}
