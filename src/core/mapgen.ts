import { refreshAutotileShapes, makeAutotileId, type Rect } from './autotile.js';

/**
 * Layout generation. These produce a plain floor/solid mask; turning that into
 * tile ids and computing autotile shapes is layoutToGrid's job.
 *
 * Everything is driven by a seeded RNG so a given seed always produces the same
 * map — which makes the output reproducible for the caller and testable here.
 */

export interface GeneratedLayout {
  width: number;
  height: number;
  /** true = open floor, false = solid. */
  floor: boolean[][];
  rooms: Rect[];
  /**
   * A spawn point guaranteed to be on open floor: the centre of the first room
   * for a dungeon, or the first cell found in the largest area for a cave — so
   * for caves it sits somewhere on the edge of that area, not in its middle.
   */
  start: { x: number; y: number };
}

/** mulberry32 — small, fast, and deterministic for a given seed. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blankFloor(width: number, height: number): boolean[][] {
  return Array.from({ length: height }, () => Array<boolean>(width).fill(false));
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function rectsOverlap(a: Rect, b: Rect, padding: number): boolean {
  return (
    a.x - padding < b.x + b.width &&
    a.x + a.width + padding > b.x &&
    a.y - padding < b.y + b.height &&
    a.y + a.height + padding > b.y
  );
}

/** Flood fill of open cells from a starting point, 4-connected. */
export function floodFill(floor: boolean[][], startX: number, startY: number): boolean[][] {
  const height = floor.length;
  const width = floor[0]?.length ?? 0;
  const seen = blankFloor(width, height);

  if (!floor[startY]?.[startX]) return seen;

  const queue: [number, number][] = [[startX, startY]];
  seen[startY][startX] = true;

  while (queue.length > 0) {
    const [x, y] = queue.pop()!;
    const neighbours: [number, number][] = [
      [x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1],
    ];
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (seen[ny][nx] || !floor[ny][nx]) continue;
      seen[ny][nx] = true;
      queue.push([nx, ny]);
    }
  }

  return seen;
}

function countOpen(mask: boolean[][]): number {
  return mask.reduce((total, row) => total + row.filter(Boolean).length, 0);
}

export interface DungeonOptions {
  width: number;
  height: number;
  seed?: number;
  /** How many times to try placing a room. More attempts, denser map. */
  roomAttempts?: number;
  minRoomSize?: number;
  maxRoomSize?: number;
}

/**
 * Rooms joined by L-shaped corridors. Each new room is connected to the
 * previous one, so the whole layout is reachable by construction.
 */
export function generateDungeon(options: DungeonOptions): GeneratedLayout {
  const {
    width,
    height,
    seed = 1,
    roomAttempts = 40,
    minRoomSize = 3,
    maxRoomSize = 8,
  } = options;

  const rng = makeRng(seed);
  const floor = blankFloor(width, height);
  const rooms: Rect[] = [];

  const carveRect = (rect: Rect): void => {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        if (x >= 0 && y >= 0 && x < width && y < height) floor[y][x] = true;
      }
    }
  };

  const carveH = (x1: number, x2: number, y: number): void => {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
      if (x >= 0 && y >= 0 && x < width && y < height) floor[y][x] = true;
    }
  };

  const carveV = (y1: number, y2: number, x: number): void => {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      if (x >= 0 && y >= 0 && x < width && y < height) floor[y][x] = true;
    }
  };

  // Keep a one-tile solid margin so nothing runs off the map edge.
  const maxW = Math.min(maxRoomSize, width - 2);
  const maxH = Math.min(maxRoomSize, height - 2);
  const minW = Math.min(minRoomSize, maxW);
  const minH = Math.min(minRoomSize, maxH);

  for (let attempt = 0; attempt < roomAttempts; attempt++) {
    if (maxW < 1 || maxH < 1) break;

    const w = randInt(rng, minW, maxW);
    const h = randInt(rng, minH, maxH);
    if (width - w - 1 < 1 || height - h - 1 < 1) continue;

    const candidate: Rect = {
      x: randInt(rng, 1, width - w - 1),
      y: randInt(rng, 1, height - h - 1),
      width: w,
      height: h,
    };

    if (rooms.some((room) => rectsOverlap(candidate, room, 1))) continue;

    carveRect(candidate);

    if (rooms.length > 0) {
      const previous = rooms[rooms.length - 1];
      const cx1 = Math.floor(previous.x + previous.width / 2);
      const cy1 = Math.floor(previous.y + previous.height / 2);
      const cx2 = Math.floor(candidate.x + candidate.width / 2);
      const cy2 = Math.floor(candidate.y + candidate.height / 2);

      // L-shaped: horizontal leg then vertical, or the other way round.
      if (rng() < 0.5) {
        carveH(cx1, cx2, cy1);
        carveV(cy1, cy2, cx2);
      } else {
        carveV(cy1, cy2, cx1);
        carveH(cx1, cx2, cy2);
      }
    }

    rooms.push(candidate);
  }

  const first = rooms[0];
  const start = first
    ? { x: Math.floor(first.x + first.width / 2), y: Math.floor(first.y + first.height / 2) }
    : { x: Math.floor(width / 2), y: Math.floor(height / 2) };

  return { width, height, floor, rooms, start };
}

export interface CaveOptions {
  width: number;
  height: number;
  seed?: number;
  /** Chance a cell starts solid. Around 0.45 gives typical caves. */
  fillProbability?: number;
  /** Cellular-automata passes. More passes, smoother walls. */
  smoothingSteps?: number;
}

/**
 * Cellular-automata cave, reduced to its largest connected area so there are no
 * sealed-off pockets the player could never reach.
 */
export function generateCave(options: CaveOptions): GeneratedLayout {
  const {
    width,
    height,
    seed = 1,
    fillProbability = 0.45,
    smoothingSteps = 4,
  } = options;

  const rng = makeRng(seed);
  let floor = blankFloor(width, height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const isBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      floor[y][x] = isBorder ? false : rng() >= fillProbability;
    }
  }

  for (let step = 0; step < smoothingSteps; step++) {
    const next = blankFloor(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
          next[y][x] = false;
          continue;
        }
        let solid = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (!floor[y + dy][x + dx]) solid++;
          }
        }
        next[y][x] = solid < 5;
      }
    }
    floor = next;
  }

  // Keep only the largest connected area.
  let best: boolean[][] | null = null;
  let bestSize = 0;
  let bestStart = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  const visited = blankFloor(width, height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!floor[y][x] || visited[y][x]) continue;
      const region = floodFill(floor, x, y);
      const size = countOpen(region);
      for (let ry = 0; ry < height; ry++) {
        for (let rx = 0; rx < width; rx++) if (region[ry][rx]) visited[ry][rx] = true;
      }
      if (size > bestSize) {
        bestSize = size;
        best = region;
        bestStart = { x, y };
      }
    }
  }

  return {
    width,
    height,
    floor: best ?? blankFloor(width, height),
    rooms: [],
    start: bestStart,
  };
}

/**
 * Turn a layout into tile ids and compute autotile shapes.
 *
 * Pass autotile kinds (A2). The whole layer is being rewritten here, so shapes
 * are refreshed across all of it rather than a scoped region.
 */
export function layoutToGrid(
  layout: GeneratedLayout,
  floorKind: number,
  wallKind: number
): number[][] {
  const floorTile = makeAutotileId(floorKind, 0);
  const wallTile = makeAutotileId(wallKind, 0);

  const grid = layout.floor.map((row) => row.map((open) => (open ? floorTile : wallTile)));
  return refreshAutotileShapes(grid);
}

/** Text preview of a layout — '.' open, '#' solid, '@' start. */
export function renderLayoutAscii(layout: GeneratedLayout): string {
  const lines: string[] = [];
  for (let y = 0; y < layout.height; y++) {
    let line = '';
    for (let x = 0; x < layout.width; x++) {
      if (x === layout.start.x && y === layout.start.y) line += '@';
      else line += layout.floor[y][x] ? '.' : '#';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** How much of the layout is open, and whether it is all reachable. */
export function layoutStats(layout: GeneratedLayout): {
  openTiles: number;
  reachableTiles: number;
  fullyConnected: boolean;
} {
  const openTiles = countOpen(layout.floor);
  const reachable = floodFill(layout.floor, layout.start.x, layout.start.y);
  const reachableTiles = countOpen(reachable);
  return { openTiles, reachableTiles, fullyConnected: openTiles === reachableTiles };
}
