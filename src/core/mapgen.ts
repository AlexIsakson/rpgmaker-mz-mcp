import {
  refreshAutotileShapes,
  makeAutotileId,
  isTileA4WallTop,
  type Rect,
} from './autotile.js';
import { refreshWallShapes } from './wall-autotile.js';
import { refreshWaterfallShapes } from './water-autotile.js';
import { cutRoomCorners, CORPUS_CORNER_WEIGHTS } from './room-shape.js';

/**
 * Layout generation. These produce a plain floor/solid mask; turning that into
 * tile ids and computing autotile shapes is layoutToGrid's job.
 *
 * Everything is driven by a seeded RNG so a given seed always produces the same
 * map — which makes the output reproducible for the caller and testable here.
 *
 * **What "a good layout" means here is measured, not judged.** Connectivity was
 * always asserted, but a fully connected map can still be a featureless blob,
 * which is what a visual review found. Three shape metrics were taken over the
 * 55 dungeon-tileset maps the editor ships, and the generators are tuned to land
 * inside the range those occupy:
 *
 * | | hand-made (median [p10..p90]) | before | after |
 * |---|---|---|---|
 * | floor fraction   | 0.219 [0.130..0.797] | cave 0.781, dungeon 0.343 | cave 0.360, dungeon 0.367 |
 * | edge density     | 0.676 [0.452..0.800] | cave 0.154, dungeon 0.629 | cave 0.465, dungeon 0.678 |
 * | dead ends /100   | 5.178 [0.000..9.040] | dungeon 0.000 | dungeon 4.329 |
 * | interior islands | 5 [0..21] | cave 2 | cave 10 |
 *
 * *Edge density* is the share of floor tiles that touch a wall — the number that
 * turns "one large open blob" from an opinion into a measurement. The cave was
 * at 0.154 against a hand-made floor of 0.452.
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
  /**
   * Chance a room comes out as something other than a box — one to four corners
   * taken out of it by {@link cutRoomCorners}, which is where the shape and its
   * measurements live.
   *
   * **The default is 0.445, and it is borrowed rather than measured here.**
   * That figure is the share of *interior* room cores with a corner missing
   * (85 of 191). The dungeon corpus cannot answer the same question: its
   * layer-0 floor regions are whole floor plans rather than single chambers —
   * 77 regions across the 55 dungeon-tileset maps, 1.4 per map, of which only
   * 3 of 66 cores (4.5%) are rectangles and the median fills 57% of its
   * bounding box. That says a dungeon's *layout* should be nothing like a
   * rectangle, which the room-and-corridor construction and the three metrics
   * in the table above already answer; it says nothing about one chamber.
   * So this is a stated value, not a measured one, and it is stated as the
   * nearest thing the corpus does settle.
   */
  irregularRoomChance?: number;
  /**
   * Passages carved off a room that lead nowhere. The hand-made dungeon maps
   * average 5 dead-end tiles per 100 floor tiles; with none, every passage goes
   * somewhere and there is nothing to explore.
   */
  deadEndAttempts?: number;
  maxDeadEndLength?: number;
}

/**
 * Rooms joined by L-shaped corridors. Each new room is connected to the
 * previous one, so the whole layout is reachable by construction.
 *
 * Rooms are not all rectangles and not all passages arrive somewhere: a share
 * of rooms are carved as two overlapping rectangles, and short stubs are cut
 * into the rock afterwards. Both come from measuring the 55 hand-made dungeon
 * maps the editor ships — they carry a median of 5.2 dead-end tiles per 100
 * floor tiles, and this generator produced exactly zero.
 *
 * A stub can never break connectivity: carving only ever turns rock into floor.
 * What it *can* do is accidentally join two passages, which would stop it being
 * a dead end — so each tile is checked to be walled on every side but the one
 * it came from before anything is cut.
 */
export function generateDungeon(options: DungeonOptions): GeneratedLayout {
  const {
    width,
    height,
    seed = 1,
    roomAttempts = 40,
    minRoomSize = 3,
    maxRoomSize = 8,
    irregularRoomChance = 0.445,
    // Scaled to the map: a fixed count leaves a big map bare and hammers a
    // small one. 0.4 per tile lands near the 5.2 dead ends per 100 floor tiles
    // the hand-made maps carry.
    deadEndAttempts = Math.round(width * height * 0.4),
    maxDeadEndLength = 6,
  } = options;

  const rng = makeRng(seed);
  const floor = blankFloor(width, height);
  const rooms: Rect[] = [];
  /**
   * A tile inside each room that is definitely floor. Corridors run between
   * these rather than between room centres: the centre of an L-shaped room can
   * land in the notch, and a corridor ending on solid rock joins nothing.
   */
  const anchors: { x: number; y: number }[] = [];

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

    // A shaped room is corners taken out of the same envelope, so the spacing
    // check above still holds and only the silhouette changes.
    //
    // The anchor is read back out of the mask rather than computed as the
    // rectangle's centre: a corner cut can put that centre on rock, and a
    // corridor ending on rock joins nothing. It was already this way for the
    // old two-rectangle form, for the same reason.
    const shaped = rng() < irregularRoomChance;
    const shape = cutRoomCorners(w, h, rng, {
      cornerWeights: shaped
        ? [0, ...CORPUS_CORNER_WEIGHTS.slice(1)]
        : [1, 0, 0, 0, 0],
    });
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (!shape.mask[dy][dx]) continue;
        const x = candidate.x + dx;
        const y = candidate.y + dy;
        if (x >= 0 && y >= 0 && x < width && y < height) floor[y][x] = true;
      }
    }
    const anchor = nearestFloorInRoom(shape, candidate);

    if (rooms.length > 0) {
      const previous = anchors[anchors.length - 1];

      // L-shaped: horizontal leg then vertical, or the other way round.
      if (rng() < 0.5) {
        carveH(previous.x, anchor.x, previous.y);
        carveV(previous.y, anchor.y, anchor.x);
      } else {
        carveV(previous.y, anchor.y, previous.x);
        carveH(previous.x, anchor.x, anchor.y);
      }
    }

    rooms.push(candidate);
    anchors.push(anchor);
  }

  carveDeadEnds(floor, rng, deadEndAttempts, maxDeadEndLength);

  const start = anchors[0] ?? { x: Math.floor(width / 2), y: Math.floor(height / 2) };

  return { width, height, floor, rooms, start };
}

/**
 * A cell that is definitely floor inside a shaped room, as close to its middle
 * as the shape allows.
 *
 * Corridors run between these rather than between room centres, because the
 * centre of a room with a corner taken out of it can land on rock and a
 * corridor that ends on rock joins nothing. Searching outward from the centre
 * keeps corridors short and keeps them arriving somewhere sensible.
 */
function nearestFloorInRoom(
  shape: { width: number; height: number; mask: boolean[][] },
  rect: Rect
): { x: number; y: number } {
  const cx = Math.floor(shape.width / 2);
  const cy = Math.floor(shape.height / 2);
  let best: { x: number; y: number } | null = null;
  let bestDistance = Infinity;
  for (let dy = 0; dy < shape.height; dy++) {
    for (let dx = 0; dx < shape.width; dx++) {
      if (!shape.mask[dy][dx]) continue;
      const distance = Math.abs(dx - cx) + Math.abs(dy - cy);
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = { x: rect.x + dx, y: rect.y + dy };
    }
  }
  // cutRoomCorners never empties the mask, so this fallback is unreachable; it
  // is here so the type is honest rather than asserted away.
  return best ?? { x: rect.x, y: rect.y };
}

const STEPS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Cut short passages into the rock that arrive nowhere.
 *
 * Carving only turns rock into floor, so this can never disconnect anything.
 * The check that matters is the opposite one: a stub that brushes another
 * passage stops being a dead end and becomes a loop, so every tile has to be
 * walled on all sides except the one the stub came from.
 */
function carveDeadEnds(
  floor: boolean[][],
  rng: () => number,
  attempts: number,
  maxLength: number
): void {
  const height = floor.length;
  const width = floor[0]?.length ?? 0;
  const solid = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && !floor[y][x];

  for (let attempt = 0; attempt < attempts; attempt++) {
    const sx = randInt(rng, 1, width - 2);
    const sy = randInt(rng, 1, height - 2);
    if (!floor[sy][sx]) continue;

    const [dx, dy] = STEPS[randInt(rng, 0, STEPS.length - 1)];
    const length = randInt(rng, 2, maxLength);
    const path: [number, number][] = [];

    let x = sx;
    let y = sy;
    for (let i = 0; i < length; i++) {
      x += dx;
      y += dy;
      // Stay a tile clear of the border so the stub never opens the map edge.
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) break;
      if (!solid(x, y)) break;

      // Everything around the new tile must be rock, apart from where we came
      // from and where we are going.
      const clear = STEPS.every(([ax, ay]) => {
        if (ax === dx && ay === dy) return true;      // ahead, checked next round
        if (ax === -dx && ay === -dy) return true;    // behind, that is the stub
        return solid(x + ax, y + ay);
      });
      if (!clear) break;
      if (!solid(x + dx, y + dy) && i < length - 1) break;

      path.push([x, y]);
    }

    for (const [px, py] of path) floor[py][px] = true;
  }
}

export interface CaveOptions {
  width: number;
  height: number;
  seed?: number;
  /** Chance a cell starts solid. Around 0.45 gives typical caves. */
  fillProbability?: number;
  /**
   * Passes that grow structure — pillars, ragged walls, side chambers.
   * Dropping this to 0 leaves only smoothing, which is what produced a blob.
   */
  structureSteps?: number;
  /** Passes that only smooth. More passes, rounder walls and fewer pillars. */
  smoothingSteps?: number;
  /** How far from a wall a tile must be before a pillar may go there. */
  pillarClearance?: number;
  /** Pillars as a fraction of open tiles. 0 leaves the cave hollow. */
  pillarDensity?: number;
  /**
   * Chance a pillar grows into a 2-4 tile clump instead of staying one tile.
   *
   * Measured against `scripts/measure-cave-islands.mjs` over the same 55
   * dungeon-tileset sample maps the shape table above cites: of the 271
   * hand-made interior islands sized 1-4 (the range a clump can reach here),
   * 210 are a single tile and 61 are 2-4 — 22.5%. Not tuned to reproduce that
   * split exactly, since a mapper hand-placing a rock formation is a different
   * process from a seeded pass over candidate tiles, but it is where the
   * default below came from rather than a guess.
   */
  pillarClumpChance?: number;
}

/**
 * Solid neighbours within a Chebyshev radius. Cells off the map count as solid,
 * which keeps the cave away from the border.
 */
function solidWithin(floor: boolean[][], x: number, y: number, radius: number): number {
  const height = floor.length;
  const width = floor[0]?.length ?? 0;
  let solid = 0;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) solid++;
      else if (!floor[ny][nx]) solid++;
    }
  }

  return solid;
}

/**
 * Cellular-automata cave, reduced to its largest connected area so there are no
 * sealed-off pockets the player could never reach.
 *
 * **Two rules, not one.** Smoothing alone (`solid >= 5`) rounds a cave off until
 * it is a single convex blob: measured across 40 seeds, only 15% of its floor
 * tiles touched a wall, against 68% in the 55 hand-made dungeon maps that ship
 * with the editor. A cave with nothing to walk around is not a cave.
 *
 * So the early passes add a second clause — `solid within 2 <= 2` also turns a
 * cell solid — which seeds pillars in the middle of wide-open space and keeps
 * the walls ragged. The later passes drop it and only smooth, so the result is
 * not noise. This is the standard two-phase roguelike rule; what is measured
 * here is that it lands in the range the hand-made maps occupy.
 */
export function generateCave(options: CaveOptions): GeneratedLayout {
  const {
    width,
    height,
    seed = 1,
    // Chosen by sweeping against the 55 hand-made dungeon maps rather than by
    // eye: these land inside the range they occupy on all three shape metrics
    // (see the module note above).
    fillProbability = 0.57,
    structureSteps = 2,
    smoothingSteps = 2,
    pillarClearance = 3,
    pillarDensity = 0.035,
    pillarClumpChance = 0.225,
  } = options;

  const rng = makeRng(seed);
  let floor = blankFloor(width, height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const isBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      floor[y][x] = isBorder ? false : rng() >= fillProbability;
    }
  }

  const totalSteps = structureSteps + smoothingSteps;
  for (let step = 0; step < totalSteps; step++) {
    const growStructure = step < structureSteps;
    const next = blankFloor(width, height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
          next[y][x] = false;
          continue;
        }
        const near = solidWithin(floor, x, y, 1);
        // A cell far from any wall becomes one, which is what puts pillars and
        // spurs inside an open space instead of leaving it empty.
        const far = growStructure ? solidWithin(floor, x, y, 2) : Infinity;
        next[y][x] = !(near >= 5 || far <= 2);
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

  const cave = best ?? blankFloor(width, height);
  addPillars(cave, rng, bestStart, pillarClearance, pillarDensity, pillarClumpChance);

  return { width, height, floor: cave, rooms: [], start: bestStart };
}

/** Chebyshev distance from every open tile to the nearest solid one. */
function distanceToWall(floor: boolean[][]): number[][] {
  const height = floor.length;
  const width = floor[0]?.length ?? 0;
  const dist = floor.map((row) => row.map((open) => (open ? Infinity : 0)));
  const queue: [number, number][] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (!floor[y][x]) queue.push([x, y]);
  }

  for (let head = 0; head < queue.length; head++) {
    const [x, y] = queue[head];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (dist[ny][nx] <= dist[y][x] + 1) continue;
        dist[ny][nx] = dist[y][x] + 1;
        queue.push([nx, ny]);
      }
    }
  }

  return dist;
}

const PILLAR_STEPS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Grow a connected clump of up to `size` tiles from a seed, by random
 * 4-connected expansion — an Eden-growth walk rather than a fixed shape, so a
 * clump reads as an irregular rock formation instead of a stamped square.
 *
 * `isEligible` is the caller's placement policy (in range, still open, far
 * enough from a wall, not the start tile); this function only knows how to
 * grow a connected shape out of whatever passes it. Separated from
 * {@link addPillars} so the growth itself — respects eligibility, never
 * revisits a cell, stops at `size` or when the frontier runs dry — can be
 * tested without a real cave grid behind it.
 *
 * Returns an empty array if the seed itself is not eligible; otherwise always
 * includes the seed, and may come back shorter than `size` if it runs out of
 * eligible neighbours first.
 */
export function growClump(
  seed: { x: number; y: number },
  size: number,
  isEligible: (x: number, y: number) => boolean,
  rng: () => number
): { x: number; y: number }[] {
  if (!isEligible(seed.x, seed.y)) return [];

  const key = (x: number, y: number) => `${x},${y}`;
  const chosen: { x: number; y: number }[] = [seed];
  const chosenSet = new Set([key(seed.x, seed.y)]);
  const frontier: { x: number; y: number }[] = [];

  const addFrontier = (x: number, y: number) => {
    for (const [dx, dy] of PILLAR_STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (isEligible(nx, ny) && !chosenSet.has(key(nx, ny))) frontier.push({ x: nx, y: ny });
    }
  };
  addFrontier(seed.x, seed.y);

  while (chosen.length < size && frontier.length > 0) {
    const i = Math.floor(rng() * frontier.length);
    const next = frontier.splice(i, 1)[0];
    if (chosenSet.has(key(next.x, next.y))) continue; // reached via two neighbours
    chosen.push(next);
    chosenSet.add(key(next.x, next.y));
    addFrontier(next.x, next.y);
  }

  return chosen;
}

/**
 * Drop solid clumps into the middle of open space.
 *
 * The cellular automata decide the cave's *outline*; nothing in them puts
 * anything **inside** it. That is the measurable half of "one large open blob
 * with nothing to navigate around": across 40 seeds the old defaults produced a
 * median of 2 interior solid regions, where the hand-made maps carry 5.
 *
 * **A pillar is only kept if the cave stays exactly as connected with it as
 * without, and a multi-tile clump is tested as one placement rather than
 * tile-by-tile.** The old sweep carved a single cell, flood-filled, and moved
 * on — safe for one tile at a time, but not for a clump: two cells that are
 * each individually safe to remove can still seal a neck once both are gone,
 * the same way two harmless-alone scatter props can jointly pinch a corridor
 * shut in `rejectSealingSlots`. So every cell of a clump is carved first, the
 * flood fill runs once over the whole thing, and the whole clump is put back
 * if the count comes up short — never partially placed.
 *
 * **Most pillars are still one tile**, which single-tile placement always was
 * and the corpus does not argue with — see `pillarClumpChance` on
 * {@link CaveOptions} for the measurement behind how often the rest grow into
 * a small clump instead.
 *
 * Mutates `floor`.
 */
function addPillars(
  floor: boolean[][],
  rng: () => number,
  start: { x: number; y: number },
  clearance: number,
  density: number,
  clumpChance: number
): void {
  const height = floor.length;
  const width = floor[0]?.length ?? 0;
  if (density <= 0 || clearance < 1) return;

  const dist = distanceToWall(floor);
  const isEligible = (x: number, y: number): boolean =>
    x > 0 && y > 0 && x < width - 1 && y < height - 1 &&
    floor[y][x] && dist[y][x] >= clearance && !(x === start.x && y === start.y);

  const candidates: [number, number][] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (isEligible(x, y)) candidates.push([x, y]);
    }
  }

  // Fisher-Yates on the same seeded stream, so a seed still reproduces the map.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const open = countOpen(floor);
  let placed = 0;
  const wanted = Math.max(1, Math.round(open * density));

  for (const [x, y] of candidates) {
    if (placed >= wanted) break;
    if (!floor[y][x]) continue; // already taken by an earlier clump

    // 2-4 tiles on the roll, capped by whatever is left of the budget — never
    // more than one tile over, since a clump is placed as a whole or not at all.
    const size = rng() < clumpChance
      ? Math.min(wanted - placed, 2 + Math.floor(rng() * 3))
      : 1;
    // growClump refuses an ineligible seed on its own terms; the check just
    // above already guarantees this one is not, so this is belt and braces
    // for growClump's general contract rather than something reachable here.
    const clump = growClump({ x, y }, size, isEligible, rng);
    if (clump.length === 0) continue;

    for (const c of clump) floor[c.y][c.x] = false;
    const reachable = countOpen(floodFill(floor, start.x, start.y));
    if (reachable === countOpen(floor)) {
      placed += clump.length;
    } else {
      for (const c of clump) floor[c.y][c.x] = true;
    }
  }
}

/**
 * Turn a layout into tile ids and compute autotile shapes.
 *
 * Both shape tables are run, so the surround can be an A3/A4 wall material and
 * not only more A2 ground. Running one table was what limited a generated map
 * to "floor versus a different floor" — a dungeon needs walls with a face, and
 * an A4 wall top is drawn with the floor table while its face uses the wall one,
 * so neither pass alone is enough.
 *
 * The whole layer is being rewritten, so shapes are refreshed across all of it
 * rather than a scoped region.
 */
export function layoutToGrid(
  layout: GeneratedLayout,
  floorKind: number,
  wallKind: number,
  options: { wallFaceKind?: number } = {}
): number[][] {
  const floorTile = makeAutotileId(floorKind, 0);
  const wallTile = makeAutotileId(wallKind, 0);

  // An A4 wall is two materials: the flat top seen from above, and the face you
  // see where the wall meets the floor south of it. Drawing only the top gives a
  // map with no height at all — floor against a differently-coloured floor,
  // which is what a generated dungeon used to look like.
  const faceKind =
    options.wallFaceKind ?? (isTileA4WallTop(wallTile) ? wallKind + 8 : null);
  const faceTile = faceKind === null ? null : makeAutotileId(faceKind, 0);

  const { width, height, floor } = layout;
  const grid = floor.map((row) => row.map((open) => (open ? floorTile : wallTile)));

  if (faceTile !== null) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (floor[y][x]) continue;
        // the bottom edge of a wall mass: solid here, open directly below
        if (y + 1 < height && floor[y + 1][x]) grid[y][x] = faceTile;
      }
    }
  }

  // The waterfall pass matters here even though a layout is floor and surround:
  // a caller can name an A1 kind for either, and a lava fall as the surround of
  // a cave is a reasonable thing to ask for.
  return refreshWaterfallShapes(refreshWallShapes(refreshAutotileShapes(grid)));
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
