import { refreshAutotileShapes, type Rect } from './autotile.js';
import { refreshWallShapes } from './wall-autotile.js';

/**
 * Writing many scattered tiles at once.
 *
 * `fillRect` covers "a rectangle of one material". The other half of map
 * building is the opposite shape of work: a few hundred individual tiles, each
 * a different object — a window here, a barrel there, half of every tree. Doing
 * that a rectangle at a time cost 440 of the 526 calls a hand-built 40x30 town
 * took, so this exists to collapse it into one.
 *
 * What batching buys is one file write and one shape refresh instead of N of
 * each, not a different answer: because every single-tile paint already fixes up
 * its neighbours, a sequence of them converges on the same grid. That
 * equivalence is the point — it is what makes replacing 440 calls with one safe,
 * so it is asserted in `tests/core/tile-batch.test.ts` rather than assumed.
 *
 * It does matter for the write count. Every call rewrites the whole map file,
 * and a run of 508 of them turned up three transient Windows rename failures; a
 * batch removes that exposure rather than retrying past it.
 *
 * This module is pure: it operates on one layer's `grid[y][x]` and returns a new
 * grid.
 */

export interface Placement {
  x: number;
  y: number;
  tileId: number;
}

export interface BatchOptions {
  /** Leave cells that already hold something. Off by default. */
  skipOccupied?: boolean;
  /**
   * Recompute autotile shapes over the affected area. On by default. Turn it
   * off when the batch carries raw autotile ids whose shapes were computed
   * elsewhere and must be written exactly as given.
   */
  computeShapes?: boolean;
}

export interface BatchResult {
  grid: number[][];
  /** Cells actually written. */
  painted: number;
  /** Cells left alone because they were occupied and `skipOccupied` was set. */
  skipped: number;
  /** Placements discarded for falling outside the grid. */
  outOfBounds: Placement[];
  /** Cells written more than once by this batch — later placements won. */
  duplicates: number;
  /** Cells that held something and were replaced. */
  overwritten: number;
  /** Bounding box of the written cells, or null when nothing was written. */
  bounds: Rect | null;
}

/**
 * Apply a batch of placements to one layer.
 *
 * Shapes are refreshed over the batch's bounding box plus a one-tile margin.
 * That is not an approximation: only a tile within one step of a change can
 * need a new shape, every change is inside the box, and the refresh is
 * idempotent for everything else — so the result is identical to refreshing the
 * whole layer.
 *
 * Both shape tables are run. A layer can hold ground and wall autotiles at once,
 * and each pass ignores what the other owns, so running both is what makes a
 * mixed batch come out right. A1 water belongs to a third table and is passed
 * through untouched by both.
 */
export function applyPlacements(
  grid: number[][],
  placements: Placement[],
  options: BatchOptions = {}
): BatchResult {
  const skipOccupied = options.skipOccupied ?? false;
  const computeShapes = options.computeShapes ?? true;

  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  const next = grid.map((row) => [...row]);
  const outOfBounds: Placement[] = [];
  const written = new Set<number>();

  let painted = 0;
  let skipped = 0;
  let duplicates = 0;
  let overwritten = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const placement of placements) {
    const { x, y, tileId } = placement;

    if (x < 0 || y < 0 || x >= width || y >= height) {
      outOfBounds.push(placement);
      continue;
    }

    const cell = y * width + x;
    const occupied = next[y][x] !== 0;

    // skipOccupied guards against a later object clobbering an earlier one, and
    // that applies within the batch as much as against what was already there —
    // so a cell this batch has already filled counts as occupied too.
    if (skipOccupied && occupied) {
      skipped++;
      continue;
    }

    if (written.has(cell)) duplicates++;
    else if (occupied) overwritten++;

    next[y][x] = tileId;
    written.add(cell);
    painted++;

    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  const bounds: Rect | null =
    written.size === 0
      ? null
      : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };

  if (!computeShapes || bounds === null) {
    return { grid: next, painted, skipped, outOfBounds, duplicates, overwritten, bounds };
  }

  const region: Rect = {
    x: bounds.x - 1,
    y: bounds.y - 1,
    width: bounds.width + 2,
    height: bounds.height + 2,
  };

  const shaped = refreshWallShapes(refreshAutotileShapes(next, { region }), { region });

  return { grid: shaped, painted, skipped, outOfBounds, duplicates, overwritten, bounds };
}
