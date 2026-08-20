/**
 * Autotile shape computation for floor-type autotiles.
 *
 * In RPG Maker you paint a *material*, not a picture: the editor picks which of
 * 48 variants to draw based on which neighbours are the same material. A tile
 * id packs both facts together:
 *
 *   kind  = (tileId - TILE_ID_A1) / 48    which material
 *   shape = (tileId - TILE_ID_A1) % 48    which of the 48 variants
 *
 * Writing shape 0 everywhere produces a field of centre pieces with no edges,
 * which renders as hard seams. So any code that writes tiles has to recompute
 * shapes for the tile *and its neighbours*.
 *
 * The shape numbering here was derived from Tilemap.FLOOR_AUTOTILE_TABLE in the
 * MZ corescript (rmmz_core.js) — that table maps shape -> which quadrant of the
 * source image to draw, and the geometry of those quadrants is what defines
 * what each shape means. tests/core/autotile.test.ts re-derives the mapping from
 * a copy of that table and checks all 256 neighbour configurations against it.
 *
 * Scope: floor-type autotiles — A2 ground, A4 wall tops and A1 water. Walls
 * (A3/A4 faces) use WALL_AUTOTILE_TABLE with different rules and vertical
 * pairing, and waterfalls use a third table; see wall-autotile.ts and
 * water-autotile.ts.
 */

export const TILE_ID_A5 = 1536;
export const TILE_ID_A1 = 2048;
export const TILE_ID_A2 = 2816;
export const TILE_ID_A3 = 4352;
export const TILE_ID_A4 = 5888;
export const TILE_ID_MAX = 8192;

export const SHAPES_PER_KIND = 48;

/** Shape used for a tile with no same-kind neighbours on any side. */
export const SHAPE_ISOLATED = 46;

/** Shape used for a tile fully surrounded by its own kind. */
export const SHAPE_FULL = 0;

export function isAutotile(tileId: number): boolean {
  return tileId >= TILE_ID_A1;
}

export function getAutotileKind(tileId: number): number {
  return Math.floor((tileId - TILE_ID_A1) / SHAPES_PER_KIND);
}

export function getAutotileShape(tileId: number): number {
  return (tileId - TILE_ID_A1) % SHAPES_PER_KIND;
}

export function makeAutotileId(kind: number, shape: number): number {
  return TILE_ID_A1 + kind * SHAPES_PER_KIND + shape;
}

/** True for the A2 ground family — the scope this module supports. */
export function isTileA2(tileId: number): boolean {
  return tileId >= TILE_ID_A2 && tileId < TILE_ID_A3;
}

/** First kind of the A4 sheet, which is 8 kinds wide and 6 block rows tall. */
const A4_KIND_MIN = Math.floor((TILE_ID_A4 - TILE_ID_A1) / SHAPES_PER_KIND);

/**
 * A4 kinds on an **even** block row are wall *tops* — the flat top of a wall
 * seen from above — and `Tilemap._addAutotile` draws them with the floor table,
 * not the wall one. Only the odd rows are wall faces.
 */
export function isTileA4WallTop(tileId: number): boolean {
  if (tileId < TILE_ID_A4 || tileId >= TILE_ID_MAX) return false;
  return Math.floor((getAutotileKind(tileId) - A4_KIND_MIN) / 8) % 2 === 0;
}

/** The A1 water family. Kinds 0-15. */
export function isTileA1(tileId: number): boolean {
  return tileId >= TILE_ID_A1 && tileId < TILE_ID_A2;
}

/**
 * The A1 kinds the engine draws with WATERFALL_AUTOTILE_TABLE: kind 4 and up,
 * odd. Restated here rather than imported so this module keeps no dependency on
 * water-autotile.ts, which depends on it; the two are asserted equal in the
 * tests.
 */
function isA1Waterfall(tileId: number): boolean {
  if (!isTileA1(tileId)) return false;
  const kind = getAutotileKind(tileId);
  return kind >= 4 && kind % 2 === 1;
}

/**
 * Whether this tile's shape comes from FLOOR_AUTOTILE_TABLE.
 *
 * A2 ground, A4 wall tops and **A1 water other than the waterfall slots** all
 * do. That list is `Tilemap.isFloorTypeAutotile` in the corescript, verbatim.
 * Missing the wall tops left them at shape 0 — a field of centre pieces with no
 * edges anywhere — which is what an interior looked like before that was fixed,
 * and A1 was in exactly the same state until P5-11: 92,550 non-waterfall A1
 * tiles in the sample maps use 47 distinct shapes up to 46, so leaving them at
 * shape 0 is not a subtle difference.
 *
 * Waterfalls are excluded because they have four shapes rather than 48 and
 * belong to `refreshWaterfallShapes` in water-autotile.ts.
 */
export function usesFloorAutotileTable(tileId: number): boolean {
  return isTileA2(tileId) || isTileA4WallTop(tileId) || (isTileA1(tileId) && !isA1Waterfall(tileId));
}

/** Mirrors Tilemap.isSameKindTile: autotiles match on kind, everything else exactly. */
export function isSameKindTile(a: number, b: number): boolean {
  if (isAutotile(a) && isAutotile(b)) {
    return getAutotileKind(a) === getAutotileKind(b);
  }
  return a === b;
}

/** Which of the 8 neighbours are the same material. */
export interface Connections {
  n: boolean;
  e: boolean;
  s: boolean;
  w: boolean;
  nw: boolean;
  ne: boolean;
  se: boolean;
  sw: boolean;
}

/**
 * Pick the shape (0-46) for a floor autotile from its neighbours.
 *
 * An *edge* appears on any side whose neighbour is a different material. A
 * diagonal only matters when both of its adjacent sides connect — then a
 * missing diagonal produces an inner corner.
 */
export function computeFloorShape(c: Connections): number {
  const edgeW = !c.w;
  const edgeN = !c.n;
  const edgeE = !c.e;
  const edgeS = !c.s;

  // A corner is only meaningful when both adjacent sides connect, so these are
  // automatically false on any side that has an edge.
  const cornerTL = c.n && c.w && !c.nw;
  const cornerTR = c.n && c.e && !c.ne;
  const cornerBR = c.s && c.e && !c.se;
  const cornerBL = c.s && c.w && !c.sw;

  const edgeCount = Number(edgeW) + Number(edgeN) + Number(edgeE) + Number(edgeS);

  if (edgeCount === 0) {
    return (
      (cornerTL ? 1 : 0) + (cornerTR ? 2 : 0) + (cornerBR ? 4 : 0) + (cornerBL ? 8 : 0)
    );
  }

  if (edgeCount === 1) {
    if (edgeW) return 16 + (cornerTR ? 1 : 0) + (cornerBR ? 2 : 0);
    if (edgeN) return 20 + (cornerBR ? 1 : 0) + (cornerBL ? 2 : 0);
    if (edgeE) return 24 + (cornerBL ? 1 : 0) + (cornerTL ? 2 : 0);
    return 28 + (cornerTL ? 1 : 0) + (cornerTR ? 2 : 0); // edgeS
  }

  if (edgeCount === 2) {
    if (edgeW && edgeE) return 32;
    if (edgeN && edgeS) return 33;
    if (edgeW && edgeN) return 34 + (cornerBR ? 1 : 0);
    if (edgeN && edgeE) return 36 + (cornerBL ? 1 : 0);
    if (edgeE && edgeS) return 38 + (cornerTL ? 1 : 0);
    return 40 + (cornerTR ? 1 : 0); // edgeS && edgeW
  }

  if (edgeCount === 3) {
    if (!edgeS) return 42; // W N E
    if (!edgeE) return 43; // W N S
    if (!edgeN) return 44; // W E S
    return 45; // N E S
  }

  return SHAPE_ISOLATED;
}

/**
 * How to treat neighbours outside the map.
 *
 * 'same' makes a material run to the map border without drawing an edge there.
 * Confirmed against the editor: painting a block into a map corner by hand
 * produces the same result, so this is the default. 'different' draws a border
 * edge instead.
 */
export type OutOfBounds = 'same' | 'different';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RefreshOptions {
  outOfBounds?: OutOfBounds;
  /**
   * Limit recomputation to this rectangle. Neighbours are still read from the
   * whole grid, so results match a full refresh — this only avoids rewriting
   * tiles whose neighbourhood cannot have changed.
   */
  region?: Rect;
}

function connectionsAt(
  grid: number[][],
  x: number,
  y: number,
  tileId: number,
  outOfBounds: OutOfBounds
): Connections {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  const connected = (nx: number, ny: number): boolean => {
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
      return outOfBounds === 'same';
    }
    return isSameKindTile(grid[ny][nx], tileId);
  };

  return {
    n: connected(x, y - 1),
    e: connected(x + 1, y),
    s: connected(x, y + 1),
    w: connected(x - 1, y),
    nw: connected(x - 1, y - 1),
    ne: connected(x + 1, y - 1),
    se: connected(x + 1, y + 1),
    sw: connected(x - 1, y + 1),
  };
}

/**
 * Recompute the shape of every floor-table autotile in a layer — A2 ground and
 * A4 wall tops — leaving its material unchanged. Everything else is passed
 * through untouched: A3/A4 wall faces follow WALL_AUTOTILE_TABLE and belong to
 * wall-autotile.ts, and waterfalls follow a third table in water-autotile.ts.
 *
 * `grid[y][x]` holds tile ids. Returns a new grid; the input is not modified.
 */
export function refreshAutotileShapes(
  grid: number[][],
  options: RefreshOptions = {}
): number[][] {
  const outOfBounds = options.outOfBounds ?? 'same';
  const region = options.region;

  const inRegion = (x: number, y: number): boolean =>
    !region ||
    (x >= region.x &&
      x < region.x + region.width &&
      y >= region.y &&
      y < region.y + region.height);

  return grid.map((row, y) =>
    row.map((tileId, x) => {
      if (!inRegion(x, y)) return tileId;
      if (!usesFloorAutotileTable(tileId)) return tileId;
      const connections = connectionsAt(grid, x, y, tileId, outOfBounds);
      return makeAutotileId(getAutotileKind(tileId), computeFloorShape(connections));
    })
  );
}

/**
 * Paint a rectangle with one material, then refresh shapes across the whole
 * layer so the new area and everything it touches stay consistent.
 *
 * `tileId` may be any tile id; only A2 autotiles get shape correction.
 */
/**
 * Paint an arbitrary set of cells with one material and recompute shapes over
 * their bounding box and the ring around it.
 *
 * {@link fillRect} without the rectangle. The shape computation already handles
 * any silhouette — it reads the grid, not the cell list — so a ragged patch
 * needs nothing from it beyond being painted a cell at a time.
 */
export function fillCells(
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

  return refreshAutotileShapes(painted, {
    ...options,
    region: options.region ?? {
      x: minX - 1,
      y: minY - 1,
      width: maxX - minX + 3,
      height: maxY - minY + 3,
    },
  });
}

export function fillRect(
  grid: number[][],
  rect: Rect,
  tileId: number,
  options: RefreshOptions = {}
): number[][] {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  const painted = grid.map((row) => [...row]);
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    if (y < 0 || y >= height) continue;
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      if (x < 0 || x >= width) continue;
      painted[y][x] = tileId;
    }
  }

  // Only tiles within one step of the change can need a new shape, so refresh
  // the painted rect plus a one-tile margin rather than the whole layer.
  return refreshAutotileShapes(painted, {
    ...options,
    region: options.region ?? {
      x: rect.x - 1,
      y: rect.y - 1,
      width: rect.width + 2,
      height: rect.height + 2,
    },
  });
}
