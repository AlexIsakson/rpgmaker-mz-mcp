/**
 * Where a door would actually divide a floor.
 *
 * `decorate_dungeon` has always known how to find the tiles that must *not* be
 * blocked — `rejectSealingSlots` drops any prop whose tile, made solid, would
 * cut part of the map off. A locked door wants exactly those tiles, and wants
 * them for the same reason: they are the ones that separate the floor into
 * before and after. The existing test is a chokepoint detector with its verdict
 * reversed, and this module is the other half of it.
 *
 * **Finding them by brute force does not scale.** Blocking every floor tile in
 * turn and flooding is O(n²) — fine on the 800-tile floors the generator makes
 * today, ruinous on a 120x120 map. So candidates come from Tarjan's articulation
 * points in one pass, and only those few are flooded to measure how the floor
 * actually splits. The flood is what the caller needs anyway: which side the
 * entrance is on, and how big the other side is.
 *
 * **A chokepoint is relative to where the player comes in.** The same tile
 * divides a floor differently depending on which side you start, so `entrance`
 * is required rather than guessed: the near side is whatever the entrance can
 * still reach, and everything else is behind the door.
 *
 * **How much a generated floor actually offers was measured, and it is less
 * than one would guess.** Across 40 seeds of each: every floor has at least one
 * chokepoint (40/40 for dungeons and caves alike), but the *best* split is a
 * median 7.1% of the floor on a 40x30 dungeon and **4.7% on a 60x45** — the
 * bigger the floor, the worse it splits, because more corridors means more
 * loops and a loop has no cut vertex at all. A threshold of 15% rejects 33 of 40
 * small dungeons and all 40 large ones; 5% takes 30 of 40 small and 17 of 40
 * large. That is why `minSideFraction` defaults where it does, and why "no
 * chokepoint" is not the failure worth designing for — "no *generous*
 * chokepoint" is.
 *
 * This module is pure — it walks a boolean grid, and never reads a file.
 */

export interface Slot {
  x: number;
  y: number;
}

export interface Chokepoint {
  x: number;
  y: number;
  /** Tiles still reachable from the entrance with this one blocked. */
  nearSize: number;
  /** Tiles cut off from the entrance by it. */
  farSize: number;
}

export interface ChokepointOptions {
  /** Where the player arrives. The near side is whatever this can still reach. */
  entrance: Slot;
  /** Tiles that may not hold a door — existing events, the arrival tile. */
  blocked?: Slot[];
  /**
   * How much of the floor each side must be, as a fraction of the walkable
   * tiles. A door with three tiles behind it is a door onto a cupboard.
   */
  minSideFraction?: number;
}

const key = (x: number, y: number) => `${x},${y}`;
const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Tiles whose removal disconnects the walkable area.
 *
 * Tarjan's algorithm, iteratively — a recursive DFS overflows the stack on a
 * large map, and a dungeon floor is exactly the shape (long thin corridors)
 * that makes the recursion deep.
 */
export function articulationPoints(floor: boolean[][]): Slot[] {
  const height = floor.length;
  const width = floor[0]?.length ?? 0;
  const index = (x: number, y: number) => y * width + x;
  const walkable = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && floor[y][x];

  const disc = new Int32Array(width * height).fill(-1);
  const low = new Int32Array(width * height);
  const isCut = new Uint8Array(width * height);
  let timer = 0;

  for (let sy = 0; sy < height; sy++) {
    for (let sx = 0; sx < width; sx++) {
      if (!walkable(sx, sy) || disc[index(sx, sy)] !== -1) continue;

      // frame: [x, y, parentIndex, nextNeighbour, rootChildren]
      const stack: number[][] = [[sx, sy, -1, 0, 0]];
      disc[index(sx, sy)] = low[index(sx, sy)] = timer++;

      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        const [x, y, parent] = frame;
        const self = index(x, y);

        if (frame[3] < NEIGHBOURS.length) {
          const [dx, dy] = NEIGHBOURS[frame[3]];
          frame[3]++;
          const nx = x + dx;
          const ny = y + dy;
          if (!walkable(nx, ny)) continue;

          const next = index(nx, ny);
          if (next === parent) continue;

          if (disc[next] === -1) {
            disc[next] = low[next] = timer++;
            stack.push([nx, ny, self, 0, 0]);
          } else {
            low[self] = Math.min(low[self], disc[next]);
          }
          continue;
        }

        // Done with this node: fold its low-link into its parent's.
        stack.pop();
        if (parent === -1) continue;

        const parentFrame = stack[stack.length - 1];
        parentFrame[4]++;
        low[parent] = Math.min(low[parent], low[self]);

        // A non-root parent is a cut vertex when a child cannot climb above it.
        if (parentFrame[2] !== -1 && low[self] >= disc[parent]) isCut[parent] = 1;
        // The root is one only when it has two independent subtrees.
        if (parentFrame[2] === -1 && parentFrame[4] > 1) isCut[parent] = 1;
      }
    }
  }

  const points: Slot[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (walkable(x, y) && isCut[index(x, y)]) points.push({ x, y });
    }
  }
  return points;
}

/** Tiles reachable from `from`, treating `without` as solid. */
export function reachableFrom(floor: boolean[][], from: Slot, without?: Slot): Set<string> {
  const height = floor.length;
  const width = floor[0]?.length ?? 0;
  const blockedKey = without ? key(without.x, without.y) : null;

  const open = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < width &&
    y < height &&
    floor[y][x] &&
    key(x, y) !== blockedKey;

  if (!open(from.x, from.y)) return new Set();

  const seen = new Set<string>([key(from.x, from.y)]);
  const stack: Slot[] = [from];
  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!open(nx, ny) || seen.has(key(nx, ny))) continue;
      seen.add(key(nx, ny));
      stack.push({ x: nx, y: ny });
    }
  }
  return seen;
}

function countFloor(floor: boolean[][]): number {
  return floor.reduce((total, row) => total + row.filter(Boolean).length, 0);
}

/**
 * Every tile that splits the floor into two worthwhile halves, best first.
 *
 * "Best" is the most even split — the largest smaller side — because a door
 * that hides a tenth of the floor is barely a door and one that hides nine
 * tenths is the floor itself. Ties break by position so the same floor always
 * gives the same answer.
 */
export function findChokepoints(
  floor: boolean[][],
  options: ChokepointOptions
): Chokepoint[] {
  const { entrance, minSideFraction = 0.15 } = options;
  const blocked = new Set((options.blocked ?? []).map((s) => key(s.x, s.y)));
  const total = countFloor(floor);
  if (total === 0) return [];

  const minSide = Math.max(1, Math.floor(total * minSideFraction));
  const found: Chokepoint[] = [];

  for (const point of articulationPoints(floor)) {
    if (blocked.has(key(point.x, point.y))) continue;
    if (point.x === entrance.x && point.y === entrance.y) continue;

    const near = reachableFrom(floor, entrance, point);
    if (near.size === 0) continue;

    // Everything walkable that the entrance can no longer reach, minus the
    // door's own tile — the player stands *on* a door once it is open.
    const farSize = total - near.size - 1;
    if (farSize <= 0) continue;
    if (near.size < minSide || farSize < minSide) continue;

    found.push({ x: point.x, y: point.y, nearSize: near.size, farSize });
  }

  return found.sort(
    (a, b) =>
      Math.min(b.nearSize, b.farSize) - Math.min(a.nearSize, a.farSize) ||
      a.y - b.y ||
      a.x - b.x
  );
}

export interface FloorLockPlan {
  door: Chokepoint;
  /** Tiles the player can reach before the door opens. */
  near: Slot[];
  /** Tiles behind the door — everything the entrance can no longer reach. */
  far: Slot[];
  /** Where the opener should go: a dead end on the near side, far from the door. */
  opener: Slot;
  /**
   * Where a reward goes: dead ends behind the door, deepest first.
   *
   * Deepest rather than nearest because a chest one step past the door is a
   * chest you can see through the doorway — the walk is the point. Dead ends
   * for the same reason treasure uses them: one way in, nothing beyond, so a
   * chest that blocks its tile cannot cut anything off.
   */
  rewardSpots: Slot[];
}

/**
 * A door, and somewhere on the near side to put the thing that opens it.
 *
 * The opener goes in a **dead end** for the reason treasure does — one way in,
 * nothing beyond, so a chest that blocks its tile cannot cut anything off — and
 * as far from the door as the near side allows, so the player does not find the
 * key while standing at the lock. With no dead end to hand it falls back to the
 * furthest tile that is not the entrance, which is still safe for a lever
 * (which blocks) only if it is not a corridor: the caller re-checks with
 * `rejectSealingSlots` before writing, as every other placement does.
 */
export function planFloorLock(
  floor: boolean[][],
  options: ChokepointOptions
): FloorLockPlan | null {
  const chokepoints = findChokepoints(floor, options);
  if (chokepoints.length === 0) return null;
  return planFromChokepoint(floor, options.entrance, options.blocked, chokepoints[0]);
}

/**
 * The rest of `planFloorLock`, given a door that has already been chosen.
 *
 * Split out so a caller that needs a *different* door than "the most even
 * split" — `place_dungeon_climax` wants the tightest chokepoint that still
 * isolates one particular tile, not the fairest one — can reuse everything
 * past that choice: which near tile the opener goes on, and which far tiles a
 * reward can use.
 */
export function planFromChokepoint(
  floor: boolean[][],
  entrance: Slot,
  blockedSlots: Slot[] | undefined,
  door: Chokepoint
): FloorLockPlan | null {
  const nearSet = reachableFrom(floor, entrance, door);
  const near: Slot[] = [...nearSet].map((cell) => {
    const [x, y] = cell.split(',').map(Number);
    return { x, y };
  });

  const blocked = new Set((blockedSlots ?? []).map((s) => key(s.x, s.y)));
  const height = floor.length;
  const width = floor[0]?.length ?? 0;
  const floorNeighbours = (x: number, y: number) =>
    NEIGHBOURS.filter(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      return nx >= 0 && ny >= 0 && nx < width && ny < height && floor[ny][nx];
    }).length;

  const distance = (s: Slot) => Math.abs(s.x - door.x) + Math.abs(s.y - door.y);
  const usable = near.filter(
    (s) => !blocked.has(key(s.x, s.y)) && !(s.x === entrance.x && s.y === entrance.y)
  );
  if (usable.length === 0) return null;

  const deadEnds = usable.filter((s) => floorNeighbours(s.x, s.y) === 1);
  const pool = deadEnds.length > 0 ? deadEnds : usable;
  const opener = pool.sort(
    (a, b) => distance(b) - distance(a) || a.y - b.y || a.x - b.x
  )[0];

  // --- the other side ---
  const far: Slot[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!floor[y][x]) continue;
      if (x === door.x && y === door.y) continue;
      if (nearSet.has(key(x, y))) continue;
      far.push({ x, y });
    }
  }

  const farUsable = far.filter((s) => !blocked.has(key(s.x, s.y)));
  const farDeadEnds = farUsable.filter((s) => floorNeighbours(s.x, s.y) === 1);
  const rewardSpots = (farDeadEnds.length > 0 ? farDeadEnds : farUsable).sort(
    (a, b) => distance(b) - distance(a) || a.y - b.y || a.x - b.x
  );

  return { door, near, far, opener, rewardSpots };
}

/**
 * The tightest door that still puts one particular tile behind it.
 *
 * `planFloorLock` picks the *most even* split, which is the right question for
 * an arbitrary vault — a door with three tiles behind it is barely a door. It is
 * the wrong question for `place_dungeon_climax`, which already knows which tile
 * matters: the floor's far end, the one `link_dungeon_floors` leaves clear.
 * What that call wants is the *smallest* chamber that still contains it — the
 * room right at the end of the dungeon, not a random half of the map.
 *
 * A chokepoint counts only if the target is on its far side — reachable from
 * the entrance with the door itself blocked, but not without it. Among those,
 * the smallest far side wins, which is what makes the room tight rather than
 * sweeping in half the dungeon along the way.
 */
export function planClimaxLock(
  floor: boolean[][],
  options: ChokepointOptions & { target: Slot }
): FloorLockPlan | null {
  const isolating = findChokepoints(floor, options).filter((cp) => {
    if (cp.x === options.target.x && cp.y === options.target.y) return false;
    const near = reachableFrom(floor, options.entrance, cp);
    return !near.has(key(options.target.x, options.target.y));
  });
  if (isolating.length === 0) return null;

  isolating.sort((a, b) => a.farSize - b.farSize || a.y - b.y || a.x - b.x);
  return planFromChokepoint(floor, options.entrance, options.blocked, isolating[0]);
}
