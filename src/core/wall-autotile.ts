import {
  TILE_ID_A3,
  TILE_ID_A4,
  TILE_ID_MAX,
  getAutotileKind,
  makeAutotileId,
  isSameKindTile,
  isAutotile,
  type Rect,
  type OutOfBounds,
} from './autotile.js';

/**
 * Shape computation for wall-type autotiles — the A3 building family and the
 * wall half of A4.
 *
 * These use Tilemap.WALL_AUTOTILE_TABLE rather than the floor table, and the
 * rule is simpler: only the four orthogonal neighbours matter, and each bit
 * means "draw an edge on this side because the neighbour is a different
 * material". Decoding the table's quadrant geometry gives the bit order:
 *
 *   table[1]  draws x=0 on the left quadrants   -> bit 1 = left edge
 *   table[2]  draws y=0 on the top quadrants    -> bit 2 = top edge
 *   table[4]  draws x=3 on the right quadrants  -> bit 4 = right edge
 *   table[8]  draws y=3 on the bottom quadrants -> bit 8 = bottom edge
 *
 * So a solid rectangle of one material gets 3 / 2 / 6 across its top row and
 * 9 / 8 / 12 across its bottom — which is what makes a painted block read as a
 * building rather than a slab of texture.
 *
 * Corners play no part: unlike floor autotiles there are 16 shapes, not 48.
 *
 * **Not every A4 kind is a wall.** Tilemap._addAutotile switches to the wall
 * table only when the A4 block row is odd; even rows are wall *tops* and use the
 * floor table. A3 is entirely wall-type.
 */

export const WALL_SHAPE_LEFT = 1;
export const WALL_SHAPE_TOP = 2;
export const WALL_SHAPE_RIGHT = 4;
export const WALL_SHAPE_BOTTOM = 8;

/** A3 building walls and roofs. */
export function isTileA3(tileId: number): boolean {
  return tileId >= TILE_ID_A3 && tileId < TILE_ID_A4;
}

/** A4 walls and wall tops. */
export function isTileA4(tileId: number): boolean {
  return tileId >= TILE_ID_A4 && tileId < TILE_ID_MAX;
}

/**
 * Whether this tile's shape comes from WALL_AUTOTILE_TABLE.
 * A3 always does; A4 does only on odd block rows — the even ones are wall tops,
 * which are drawn with the floor table.
 */
export function usesWallAutotileTable(tileId: number): boolean {
  if (isTileA3(tileId)) return true;
  if (!isTileA4(tileId)) return false;
  return Math.floor(getAutotileKind(tileId) / 8) % 2 === 1;
}

/** The four orthogonal neighbours, true when they are the same material. */
export interface WallConnections {
  n: boolean;
  e: boolean;
  s: boolean;
  w: boolean;
}

/** An edge is drawn on every side whose neighbour is a different material. */
export function computeWallShape(c: WallConnections): number {
  return (
    (c.w ? 0 : WALL_SHAPE_LEFT) |
    (c.n ? 0 : WALL_SHAPE_TOP) |
    (c.e ? 0 : WALL_SHAPE_RIGHT) |
    (c.s ? 0 : WALL_SHAPE_BOTTOM)
  );
}

export interface WallRefreshOptions {
  outOfBounds?: OutOfBounds;
  region?: Rect;
}

function wallConnectionsAt(
  grid: number[][],
  x: number,
  y: number,
  tileId: number,
  outOfBounds: OutOfBounds
): WallConnections {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  const connected = (nx: number, ny: number): boolean => {
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return outOfBounds === 'same';
    return isSameKindTile(grid[ny][nx], tileId);
  };

  return {
    n: connected(x, y - 1),
    e: connected(x + 1, y),
    s: connected(x, y + 1),
    w: connected(x - 1, y),
  };
}

/**
 * Recompute the shape of every wall-type autotile in a layer, leaving its
 * material unchanged. Floor tiles and plain tiles pass through untouched, so
 * this can be run over a mixed layer safely.
 *
 * Returns a new grid; the input is not modified.
 */
export function refreshWallShapes(
  grid: number[][],
  options: WallRefreshOptions = {}
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
      if (!isAutotile(tileId) || !usesWallAutotileTable(tileId)) return tileId;
      const connections = wallConnectionsAt(grid, x, y, tileId, outOfBounds);
      return makeAutotileId(getAutotileKind(tileId), computeWallShape(connections));
    })
  );
}

/**
 * Paint a rectangle with a wall material, then refresh shapes across the
 * painted area and the ring around it — the same scoping the floor version
 * uses, for the same reason: only tiles within one step of the change can need
 * a new shape.
 */
export function fillWallRect(
  grid: number[][],
  rect: Rect,
  tileId: number,
  options: WallRefreshOptions = {}
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

  return refreshWallShapes(painted, {
    ...options,
    region: options.region ?? {
      x: rect.x - 1,
      y: rect.y - 1,
      width: rect.width + 2,
      height: rect.height + 2,
    },
  });
}
