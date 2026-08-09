import type { EventCommand, EventPage, Event } from '../schemas/event.js';

/**
 * Stairs, ladders and cave mouths — the events that join one map to another.
 *
 * **The event shape is measured, not designed.** Across the 720 maps that ship
 * with the editor (samplemaps, the demo projects and the map resource packs),
 * 157 transfer pages stand on a tile the editor labels a stair, ladder or hole,
 * and **all 157 are the same page**:
 *
 * | | |
 * |---|---|
 * | trigger | 1 — player touch, 157/157 |
 * | priorityType | 0 — below characters, 157/157 |
 * | sprite | none, 157/157 |
 * | pages | 1, 157/157 |
 * | commands | `250, 201, 0` — play `Move1`, transfer, 157/157 |
 * | transfer designation | 0 — direct, 157/157 |
 * | transfer fade | 0 — black, 157/157 |
 *
 * That is byte-identical to the page an interior's exit uses, which is why
 * `interiorgen` builds its exit from this module rather than keeping a second
 * copy: a stair and a way out of a house are the same object.
 *
 * The contrast is worth recording, because it is what tells the two apart. The
 * 167 transfer pages standing on an *entrance* tile — a doorway in a wall —
 * split the other way: 122 carry a `!Door1` sprite at priority 1 with the full
 * opening animation, which is what `place_building` already emits. A stair has
 * no sprite and no animation; the tile is the art.
 *
 * **Facing on arrival has no convention.** Of the 157, only 2 retain the
 * player's direction; the rest set one, spread across all four with no majority
 * (down: 20/20/22/14, up: 26/14/22/16). It is a per-placement judgement, so it
 * is a parameter, and the default retains — never wrong, where a guess can be.
 *
 * This module is pure: it builds events and picks tiles, and never reads a file.
 */

const CODE_PLAY_SE = 250;
const CODE_TRANSFER_PLAYER = 201;
const CODE_END = 0;

/** The SE all 157 shipped stair pages play. */
export const STAIR_SE = 'Move1';

export interface TransferTarget {
  mapId: number;
  x: number;
  y: number;
  /** Facing on arrival: 0 retains the player's, or 2 down, 4 left, 6 right, 8 up. */
  direction?: number;
}

export interface TransferPageOptions {
  se?: string;
}

/**
 * The page a stair, ladder or interior exit uses: invisible, walked onto, and
 * drawn below characters so it never blocks the tile it sits on.
 *
 * **Priority 0 is what makes this placement always safe.** A chest has to go in
 * a dead end because it blocks its tile and could seal a corridor; a stair
 * cannot block anything, so it can go on any floor tile without a connectivity
 * argument.
 *
 * **Landing the player on one of these does not re-fire it.** `Game_Player`
 * only checks player-touch events in `updateNonmoving` when `wasMoving` is true,
 * and `performTransfer` sets the position with `locate()` rather than by moving.
 * So a down-stair can put the player straight onto the up-stair that leads back,
 * which is what makes a pair of stairs read as one staircase instead of
 * bouncing them between floors forever.
 */
export function transferEventPage(
  target: TransferTarget,
  options: TransferPageOptions = {}
): EventPage {
  const { se = STAIR_SE } = options;

  const list: EventCommand[] = [
    {
      code: CODE_PLAY_SE,
      indent: 0,
      parameters: [{ name: se, volume: 90, pitch: 100, pan: 0 }],
    },
    // [designation (0 = direct), mapId, x, y, direction (0 = retain), fade (0 = black)]
    {
      code: CODE_TRANSFER_PLAYER,
      indent: 0,
      parameters: [0, target.mapId, target.x, target.y, target.direction ?? 0, 0],
    },
    { code: CODE_END, indent: 0, parameters: [] },
  ];

  return {
    conditions: {
      actorId: 1, actorValid: false,
      itemId: 1, itemValid: false,
      selfSwitchCh: 'A', selfSwitchValid: false,
      switch1Id: 1, switch1Valid: false,
      switch2Id: 1, switch2Valid: false,
      variableId: 1, variableValid: false, variableValue: 0,
    },
    directionFix: false,
    image: { characterIndex: 0, characterName: '', direction: 2, pattern: 0, tileId: 0 },
    list,
    moveFrequency: 3,
    moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
    moveSpeed: 3,
    moveType: 0,
    priorityType: 0,
    stepAnime: false,
    through: false,
    trigger: 1,
    walkAnime: false,
  };
}

export function stairEvent(
  id: number,
  x: number,
  y: number,
  target: TransferTarget,
  name = `Stairs${id}`
): Event {
  return { id, name, note: '', pages: [transferEventPage(target)], x, y };
}

/** Read a transfer page's destination back, for reporting what a map links to. */
export function transferTargetOf(page: EventPage): TransferTarget | null {
  const transfer = page.list.find((c) => c.code === CODE_TRANSFER_PLAYER);
  if (!transfer) return null;
  const [designation, mapId, x, y, direction] = transfer.parameters as number[];
  // A variable-driven transfer names no map statically; there is nothing to report.
  if (designation !== 0) return null;
  return { mapId, x, y, direction };
}

// --- placement --------------------------------------------------------------

export interface Slot {
  x: number;
  y: number;
}

export interface StairEndsOptions {
  /** Tiles nothing may use — chests, torches, anything already standing there. */
  blocked?: Slot[];
}

export interface StairEnds {
  /** The end nearer the map border: where the player comes in. */
  entrance: Slot;
  /** The far end: where the way onward goes. */
  exit: Slot;
  /** Steps between the two along the floor. */
  distance: number;
  /** Floor tiles reachable from the entrance. */
  reachable: number;
}

export class StairError extends Error {}

const key = (x: number, y: number) => `${x},${y}`;
const STEPS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Steps from `start` to every reachable floor tile; -1 where unreachable. */
function bfs(floor: boolean[][], start: Slot): number[][] {
  const height = floor.length;
  const width = floor[0]?.length ?? 0;
  const dist = Array.from({ length: height }, () => new Array<number>(width).fill(-1));
  if (!floor[start.y]?.[start.x]) return dist;

  dist[start.y][start.x] = 0;
  const queue: Slot[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const { x, y } = queue[head];
    for (const [dx, dy] of STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!floor[ny][nx] || dist[ny][nx] !== -1) continue;
      dist[ny][nx] = dist[y][x] + 1;
      queue.push({ x: nx, y: ny });
    }
  }
  return dist;
}

/**
 * The tile furthest from a BFS source, skipping anything blocked.
 *
 * Ties break on (y, x) so the result is deterministic — this is the one place
 * placement could drift between runs, and a generated dungeon is supposed to
 * reproduce from its seed.
 */
function furthest(dist: number[][], blocked: Set<string>): { slot: Slot; distance: number } | null {
  let best: Slot | null = null;
  let bestDistance = -1;
  for (let y = 0; y < dist.length; y++) {
    for (let x = 0; x < dist[y].length; x++) {
      const d = dist[y][x];
      if (d <= bestDistance || blocked.has(key(x, y))) continue;
      best = { x, y };
      bestDistance = d;
    }
  }
  return best ? { slot: best, distance: bestDistance } : null;
}

/**
 * How many BFS sources to try at most. Never reached by a map from
 * `generate_map_layout` — a 40x35 dungeon offers about 200 — so it exists only
 * to bound the cost on a hand-made maze far larger than anything generated here.
 */
const MAX_SOURCES = 400;

/**
 * Choose where a dungeon's way in and way out go.
 *
 * **The two ends should be as far apart as the map allows**, or the dungeon is
 * a room you walk across rather than one you traverse. That is the graph
 * diameter, measured in steps along the floor rather than as the crow flies —
 * two tiles either side of a wall are neighbours on screen and a long walk apart
 * in the dungeon, and it is the walk that matters.
 *
 * **The textbook double sweep is not good enough here, which was measured
 * rather than assumed.** BFS from any tile to find one end, then from that end
 * to find the other, is exact on a tree and an approximation once a layout has
 * loops. Generated dungeons have plenty: against the true diameter over 16
 * layouts it came back 79, 66 for one seed and 65, 54 for another — putting the
 * stairs a sixth of the map closer together than they needed to be. Iterating
 * the sweep to a fixed point fixed some of those seeds and none of the others.
 *
 * So the sweep runs from **every fringe tile** instead — every floor tile with
 * two or fewer open neighbours, which is the dead ends, the corners and the
 * corridor tiles. That found the exact diameter on all 16 layouts, dungeons and
 * caves alike.
 *
 * This is a heuristic and not a proof: a diameter endpoint is extremal, and an
 * extremal tile in a grid is one with few neighbours, but nothing here rules out
 * a shape where the endpoints sit in open space. What makes it the right trade
 * is the cost. The fringe is the map's *perimeter*, not its area, so the source
 * count stays low exactly where checking every pair would be dear — an open cave
 * offers 40-120 sources against 570 floor tiles, and a solid open rectangle
 * offers its four corners. `tests/core/stairs.test.ts` checks the result against
 * a brute-force all-pairs diameter, so a layout change that breaks the
 * assumption is caught rather than silently placing worse stairs.
 *
 * **Which end is the entrance is decided by the map border.** A dungeon is
 * entered from outside, so of the two ends the one nearer the edge is the way
 * in. Nothing in the geometry forces this — it is a convention, and it is here
 * rather than left to the caller because the alternative reads backwards.
 *
 * Both ends land on plain floor with no constraint beyond being unblocked: a
 * stair event is priority 0 and blocks nothing, so unlike a chest it cannot cut
 * the map in half wherever it goes.
 */
export function planStairEnds(floor: boolean[][], options: StairEndsOptions = {}): StairEnds {
  const height = floor.length;
  const width = floor[0]?.length ?? 0;
  const blocked = new Set((options.blocked ?? []).map((s) => key(s.x, s.y)));

  const open = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && floor[y][x];

  const free: Slot[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (floor[y][x] && !blocked.has(key(x, y))) free.push({ x, y });
    }
  }

  if (free.length === 0) {
    throw new StairError(
      'No free floor tile: every walkable tile is either solid or already has an event on it.'
    );
  }
  if (free.length < 2) {
    throw new StairError(
      'Only one free floor tile, so a way in and a way out cannot both be placed.'
    );
  }

  // Fringe tiles, fewest neighbours first: a dead end is the likeliest end of a
  // longest path, so if the cap ever bites it bites the least useful sources.
  // Ties keep scan order, which is what makes the choice reproducible.
  const degree = (s: Slot) => STEPS.filter(([dx, dy]) => open(s.x + dx, s.y + dy)).length;
  const sources = free
    .map((s) => ({ slot: s, degree: degree(s) }))
    .filter((s) => s.degree <= 2)
    .sort((a, b) => a.degree - b.degree)
    .slice(0, MAX_SOURCES)
    .map((s) => s.slot);

  // The topmost-leftmost floor tile always has neither an up nor a left
  // neighbour, so the fringe is never empty. Belt and braces for a caller
  // passing a mask this module did not build.
  if (sources.length === 0) sources.push(free[0]);

  let bestA: Slot | null = null;
  let bestB: Slot | null = null;
  let bestDistance = -1;
  let bestDist: number[][] | null = null;

  for (const source of sources) {
    const dist = bfs(floor, source);
    const target = furthest(dist, new Set([...blocked, key(source.x, source.y)]));
    if (!target || target.distance <= bestDistance) continue;
    bestA = source;
    bestB = target.slot;
    bestDistance = target.distance;
    bestDist = dist;
  }

  if (!bestA || !bestB || !bestDist) {
    throw new StairError(
      'No two free floor tiles are connected, so a way in and a way out cannot both be placed.'
    );
  }

  const reachable = bestDist.reduce((total, row) => total + row.filter((d) => d >= 0).length, 0);

  const edgeDistance = (s: Slot) => Math.min(s.x, s.y, width - 1 - s.x, height - 1 - s.y);
  const [entrance, exit] =
    edgeDistance(bestA) <= edgeDistance(bestB) ? [bestA, bestB] : [bestB, bestA];

  return { entrance, exit, distance: bestDistance, reachable };
}
