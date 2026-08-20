import {
  TILE_ID_A1,
  TILE_ID_A2,
  SHAPES_PER_KIND,
  getAutotileKind,
  makeAutotileId,
  isSameKindTile,
  refreshAutotileShapes,
  type Rect,
  type OutOfBounds,
  type RefreshOptions,
} from './autotile.js';

/**
 * The A1 sheet — water, and the third autotile table.
 *
 * A1 was the one autotile family nothing here could paint. `fill_map_region`
 * refused a kind below 16, `refreshAutotileShapes` passed A1 through untouched,
 * and a generated map could therefore have no water in it at all. It is not a
 * rare sheet: **94,187 A1 tiles across the 293 hand-made sample maps**, 66,009
 * of them on layer 0 and 28,080 on layer 1 — more than any other single
 * autotile family in the corpus.
 *
 * **A1 is two families in one sheet, and the engine decides which by position.**
 * `Tilemap.isWaterfallTile` (rmmz_core.js v1.9.0) is:
 *
 *     tileId >= TILE_ID_A1 + 192 && tileId < TILE_ID_A2 &&
 *     getAutotileKind(tileId) % 2 === 1
 *
 * — kind 4 and up, odd. So kinds 5, 7, 9, 11, 13 and 15 take
 * `WATERFALL_AUTOTILE_TABLE`, and every other A1 kind is a *floor-type*
 * autotile: `Tilemap.isFloorTypeAutotile` names A1-non-waterfall alongside A2
 * and the wall tops. That last fact is why {@link usesFloorAutotileTable} now
 * includes A1 — it was the engine's claim all along and this module was simply
 * missing.
 *
 * The corpus agrees. Of the 92,550 non-waterfall A1 tiles in the sample maps,
 * **47 distinct shapes are used and the largest is 46** — the full floor
 * vocabulary, not the four a waterfall has. Of the 1,637 waterfall tiles,
 * **the only shapes that appear are 0, 1, 2 and 3**, which is exactly the
 * length of the waterfall table.
 *
 * **The slot decides, not the name**, and that will mislead a caller who does
 * not know it. The editor ships a label per kind, and across the four RTP A1
 * sheets **24 kinds sit in a waterfall slot while only 14 of them are called a
 * waterfall**: `World_A1` kind 15 is "Cloud", `Outside_A1` kind 15 is "Dead
 * Tree", `Inside_A1` kind 13 is "Water H (Big Hole)". Each of those is drawn
 * with the waterfall table and animates on three vertical frames whatever its
 * art depicts, because the engine's test is arithmetic on the tile id.
 * {@link describeA1Kind} reports both so the tool can say so out loud.
 */

/** A1 covers kinds 0-15: water, and the waterfall slots among them. */
export function isTileA1(tileId: number): boolean {
  return tileId >= TILE_ID_A1 && tileId < TILE_ID_A2;
}

/** The first A1 kind that can be a waterfall — `TILE_ID_A1 + 192` is kind 4. */
export const WATERFALL_KIND_MIN = 4;

/** The last A1 kind. */
export const A1_KIND_MAX = Math.floor((TILE_ID_A2 - TILE_ID_A1) / SHAPES_PER_KIND) - 1;

/**
 * Port of `Tilemap.isWaterfallTile`. Kind 4 and up, odd.
 *
 * Note this is a test on the *slot*, not on what the art shows — see the note
 * at the top of the file.
 */
export function isWaterfallTile(tileId: number): boolean {
  if (!isTileA1(tileId)) return false;
  const kind = getAutotileKind(tileId);
  return kind >= WATERFALL_KIND_MIN && kind % 2 === 1;
}

/** {@link isWaterfallTile} on a kind rather than a tile id. */
export function isWaterfallKind(kind: number): boolean {
  return kind >= WATERFALL_KIND_MIN && kind <= A1_KIND_MAX && kind % 2 === 1;
}

/**
 * Port of `Tilemap.isWaterTile`: A1, but not kinds 2 and 3.
 *
 * Those two are the sheet's static slots — `_addAutotile` gives them a fixed
 * `bx` of 6 with no `waterSurfaceIndex`, so unlike every other non-waterfall A1
 * kind they do not animate. In the RTP sheets they hold things floating *on*
 * water rather than water itself: "Swamp Grass", "Lotus Pads", "Rock Shoal",
 * "Icebergs". They still use the floor table; only the animation differs.
 */
export function isWaterTile(tileId: number): boolean {
  if (!isTileA1(tileId)) return false;
  const kind = getAutotileKind(tileId);
  return kind !== 2 && kind !== 3;
}

/** Whether this tile's shape comes from `WATERFALL_AUTOTILE_TABLE`. */
export function usesWaterfallAutotileTable(tileId: number): boolean {
  return isWaterfallTile(tileId);
}

/**
 * Draw the left edge of the fall — the piece with the rock lip on its left.
 *
 * Decoded from `Tilemap.WATERFALL_AUTOTILE_TABLE`, whose four entries differ
 * only in which half-tile column each side draws:
 *
 *     shape 0  left quadrants qsx 2, right qsx 1   -> the seamless middle
 *     shape 1  left quadrants qsx 0                -> left edge
 *     shape 2  right quadrants qsx 3               -> right edge
 *     shape 3  both                                -> a fall one tile wide
 */
export const WATERFALL_SHAPE_LEFT = 1;
export const WATERFALL_SHAPE_RIGHT = 2;

/** The only shapes a waterfall has. Confirmed by the corpus: nothing else appears. */
export const WATERFALL_SHAPE_MAX = 3;

/**
 * Pick a waterfall's shape from its horizontal neighbours.
 *
 * **Vertical neighbours play no part**, and that is the table's own doing: it
 * has four entries and they vary only across the tile, so there is no shape for
 * "top of the fall" or "bottom of it". A fall repeats down its column and the
 * three animation frames supply the motion. The corpus bears the consequence
 * out — waterfall columns run a median 2 tiles and a p90 of 8, up to 37, with
 * the same shape all the way down.
 *
 * **How well this matches the corpus, stated rather than rounded up.** Over the
 * 330 horizontal same-kind runs of two or more tiles in the sample maps, the
 * rule gives the mapper's own tile for **713 of 827 (86.2%)**, and for a
 * one-tile fall it gives shape 3, which is what **645 of 810 (79.6%)** of them
 * use. Every single miss is in the same direction — the mapper chose the
 * seamless middle where the rule wants an edge — and the examples say why:
 * a fall that lands between two cliff tiles, or one tile of fall in the middle
 * of open water, already has its edge supplied by the scenery beside it. So the
 * rule is right about what the shapes *mean* and a mapper sometimes overrides
 * it for a reason this cannot see. A caller who wants that override can write
 * the tile id directly.
 */
export function computeWaterfallShape(sameLeft: boolean, sameRight: boolean): number {
  return (sameLeft ? 0 : WATERFALL_SHAPE_LEFT) + (sameRight ? 0 : WATERFALL_SHAPE_RIGHT);
}

/**
 * Recompute the shape of every waterfall tile in a layer, leaving its material
 * alone. Everything else passes through untouched — A1 water and A2 ground go
 * through `refreshAutotileShapes`, A3/A4 wall faces through `refreshWallShapes`.
 *
 * `grid[y][x]` holds tile ids. Returns a new grid; the input is not modified.
 */
export function refreshWaterfallShapes(
  grid: number[][],
  options: RefreshOptions = {}
): number[][] {
  const outOfBounds: OutOfBounds = options.outOfBounds ?? 'same';
  const region = options.region;
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  const inRegion = (x: number, y: number): boolean =>
    !region ||
    (x >= region.x &&
      x < region.x + region.width &&
      y >= region.y &&
      y < region.y + region.height);

  const same = (x: number, y: number, tileId: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return outOfBounds === 'same';
    return isSameKindTile(grid[y][x], tileId);
  };

  return grid.map((row, y) =>
    row.map((tileId, x) => {
      if (!inRegion(x, y)) return tileId;
      if (!usesWaterfallAutotileTable(tileId)) return tileId;
      const shape = computeWaterfallShape(
        same(x - 1, y, tileId),
        same(x + 1, y, tileId)
      );
      return makeAutotileId(getAutotileKind(tileId), shape);
    })
  );
}

/**
 * Paint a set of cells with one A1 material and reshape what it touches.
 *
 * Both passes run, and both are needed even for a single material: a waterfall
 * kind needs the waterfall table, and painting water beside existing water
 * changes *that* water's shape through the floor table. Running the floor pass
 * on a waterfall is harmless — `usesFloorAutotileTable` excludes it — and the
 * same the other way round.
 */
export function fillWaterCells(
  grid: number[][],
  cells: { x: number; y: number }[],
  tileId: number,
  options: RefreshOptions = {}
): number[][] {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  const painted = grid.map((row) => [...row]);
  if (cells.length === 0) return painted;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of cells) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    painted[y][x] = tileId;
  }

  const region: Rect = options.region ?? {
    x: minX - 1,
    y: minY - 1,
    width: maxX - minX + 3,
    height: maxY - minY + 3,
  };

  return refreshWaterfallShapes(refreshAutotileShapes(painted, { ...options, region }), {
    ...options,
    region,
  });
}

export interface A1KindFacts {
  kind: number;
  /** Which shape table the engine draws it with. */
  table: 'floor' | 'waterfall';
  /**
   * Whether the engine cycles it through `waterSurfaceIndex`. Waterfalls
   * animate too, on `animationFrame % 3` down the sheet rather than across it.
   */
  animated: boolean;
  /** The engine's own `isWaterTile`. False only for kinds 2 and 3. */
  water: boolean;
}

/**
 * What the engine will do with an A1 kind, from its slot alone.
 *
 * Everything here is arithmetic out of `Tilemap._addAutotile`, so it holds for
 * any A1 sheet including one the RTP never shipped. The editor's label for the
 * kind is a separate matter and lives with the tileset reader — pairing the two
 * is what lets a tool warn that "Cloud" is going to behave like a waterfall.
 */
export function describeA1Kind(kind: number): A1KindFacts {
  const waterfall = isWaterfallKind(kind);
  return {
    kind,
    table: waterfall ? 'waterfall' : 'floor',
    // Kinds 2 and 3 get a fixed bx of 6 with no waterSurfaceIndex term.
    animated: waterfall || (kind !== 2 && kind !== 3),
    water: kind !== 2 && kind !== 3,
  };
}
