import type { MapData } from '../schemas/map.js';
import { reachableFromAny, reachableGrid } from './walkability.js';

/**
 * Where the player arrives on a map, and therefore which tiles they can ever
 * occupy on it.
 *
 * **Why this is not "the largest walkable area".** Everything in the repo that
 * needed to know where the player is has so far assumed the biggest connected
 * blob — `analyseWalkability` says in its own documentation that this is wrong
 * on an interior, because a room's wall tops are passable *along themselves* in
 * the RTP tilesets, so the ring around a room out-numbers the room. Until now
 * that was an argument; `scripts/measure-arrival.mjs` turns it into a count.
 *
 * Across every project on this machine, over the **677 maps whose tileset has
 * real passage flags**:
 *
 * - **619 of 677 (91.4%) have more than one walkable area**, so "largest" is an
 *   actual choice on almost every map rather than a formality.
 * - **159 maps are transferred into, carrying 394 arrival points** — 2.5 per
 *   map, which is why this takes a list and unions the result rather than
 *   picking one.
 * - **36 of those 394 arrivals (9.1%), on 20 maps, land outside the largest
 *   area.** When the guess is wrong it is not wrong by a little: map 25 of
 *   `Wicked Heart` has a largest area of 627 tiles and 65 reachable from where
 *   the player actually lands; map 59 is 516 against 11; map 19 is 142 against
 *   24.
 * - **24 of the 394 land on a tile the player cannot stand on at all** —
 *   `locate()` puts them there anyway and `canPass` is false in all four
 *   directions. That is P5-36's subject; here such a point simply contributes
 *   nothing rather than dragging its whole area in.
 * - Events are *not* a usable stand-in: of 2031 events, 1278 sit outside the
 *   largest area and **992 of those stand on an impassable tile**, because
 *   doors, signs and clutter are events too. 142 maps have no event in their
 *   largest area at all.
 *
 * **What the engine says.** `Game_Interpreter.command201` is the only route on
 * to a map besides the new game position:
 *
 * ```js
 * command201: if (params[0] === 0) { mapId = params[1]; x = params[2]; y = params[3]; }
 *             $gamePlayer.reserveTransfer(mapId, x, y, params[4], params[5]);
 * ```
 *
 * so a literal transfer names the exact tile. `DataManager.setupNewGame` uses
 * `System.json`'s `startMapId` / `startX` / `startY` for the first one.
 *
 * **Two limits, stated because nothing on disk settles them.** A transfer at
 * designation 1 reads its map and coordinates from variables and cannot be
 * resolved from a file — 0 of the 766 transfers measured in P5-35 use it, so
 * nothing is missed today, but a project that starts using it would leave gaps
 * here. And vehicles move the player without a transfer: `Game_Player.getOffVehicle`
 * can set them down on a shore no `command201` names. So a derived arrival set
 * is a strong default and **not** a proof, which is why every refusal built on
 * it names the tiles it used and every tool that consumes it takes an explicit
 * override.
 *
 * This module is pure: it reads command records, a map and passage flags, and
 * returns points, a grid and text.
 */

/** How an arrival tile was learned. */
export type ArrivalSource = 'given' | 'new-game' | 'transfer';

export interface ArrivalPoint {
  x: number;
  y: number;
  source: ArrivalSource;
  /** For a transfer, the map whose event carries it. */
  fromMapId?: number;
}

/** A stored command, as it sits in a map file. */
export interface RawCommand {
  code?: number;
  parameters?: unknown[];
}

/** One command list, tagged with where it came from. */
export interface CommandSource {
  /** The map holding it, or undefined for a common event or troop page. */
  mapId?: number;
  list?: readonly RawCommand[] | null;
}

/** Transfer Player. */
const TRANSFER_CODE = 201;

/**
 * Every literal Transfer Player aimed at `targetMapId`, from the command lists
 * given.
 *
 * `parameters[0]` is the designation: 0 means the next three are a map id and
 * coordinates, anything else means they are variable ids and the destination is
 * only knowable at runtime. Those are skipped rather than guessed at.
 */
export function collectTransferArrivals(
  sources: readonly CommandSource[],
  targetMapId: number
): ArrivalPoint[] {
  const points: ArrivalPoint[] = [];
  for (const source of sources) {
    if (!Array.isArray(source.list)) continue;
    for (const command of source.list) {
      if (!command || command.code !== TRANSFER_CODE) continue;
      const p = command.parameters;
      if (!Array.isArray(p) || p[0] !== 0) continue;
      if (p[1] !== targetMapId) continue;
      if (typeof p[2] !== 'number' || typeof p[3] !== 'number') continue;
      points.push({ x: p[2], y: p[3], source: 'transfer', fromMapId: source.mapId });
    }
  }
  return points;
}

/** `System.json`'s new game position, when it is on this map. */
export function newGameArrival(
  system: { startMapId?: unknown; startX?: unknown; startY?: unknown } | undefined,
  targetMapId: number
): ArrivalPoint | null {
  if (!system || system.startMapId !== targetMapId) return null;
  if (typeof system.startX !== 'number' || typeof system.startY !== 'number') return null;
  return { x: system.startX, y: system.startY, source: 'new-game' };
}

/** Distinct points, first mention winning — a busy map names the same door twice. */
export function dedupeArrivals(points: readonly ArrivalPoint[]): ArrivalPoint[] {
  const seen = new Set<string>();
  const out: ArrivalPoint[] = [];
  for (const point of points) {
    const key = `${point.x},${point.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(point);
  }
  return out;
}

export interface ArrivalSurvey {
  /** Points that landed somewhere the player can stand. */
  used: ArrivalPoint[];
  /** Points on a tile `canPass` blocks in all four directions. */
  stranded: ArrivalPoint[];
  /** Tiles reachable from any used point, as `grid[y][x]`. */
  reachable: boolean[][];
  reachableTiles: number;
  /** How many disconnected areas the used points reach between them. */
  areas: number;
  /**
   * True when nothing usable was known and the largest walkable area stood in.
   * Every message built on this survey has to say so.
   */
  assumedLargest: boolean;
  /**
   * The largest walkable area, for comparison. When the arrival reaches far
   * less than this, something is wrong with the map or the flags and the
   * caller has to be told rather than handed a small number.
   */
  largestArea: number;
}

/**
 * Below this share of the largest area, a derived arrival gets a warning
 * instead of being quietly believed.
 *
 * **Stated, not measured.** Nothing on disk settles where the line is; a half
 * is picked because the failure it catches is not marginal — `Wicked Heart`
 * map 59 reaches 11 tiles of a 516-tile largest area, and map 25 reaches 65 of
 * 627, both because a real transfer lands somewhere the player cannot walk out
 * of.
 */
const SUSPICIOUS_SHARE = 0.5;

/** Which tiles the player can occupy, given what is known about where they arrive. */
export function surveyArrival(
  map: MapData,
  flags: number[],
  points: readonly ArrivalPoint[]
): ArrivalSurvey {
  const distinct = dedupeArrivals(points);
  const reach = reachableFromAny(map, flags, distinct);

  const count = (grid: boolean[][]) => {
    let n = 0;
    for (const row of grid) for (const cell of row) if (cell) n++;
    return n;
  };

  const largestArea = count(reachableGrid(map, flags));

  if (reach.used.length > 0) {
    const usedPoints = reach.used.map(
      (u) => distinct.find((p) => p.x === u.x && p.y === u.y) as ArrivalPoint
    );
    const strandedPoints = reach.stranded.map(
      (s) => distinct.find((p) => p.x === s.x && p.y === s.y) as ArrivalPoint
    );
    return {
      used: usedPoints,
      stranded: strandedPoints,
      reachable: reach.grid,
      reachableTiles: count(reach.grid),
      areas: reach.areas,
      assumedLargest: false,
      largestArea,
    };
  }

  // Nothing usable. Fall back to the old assumption rather than declaring the
  // whole map unreachable — but flag it, because it is wrong on 20 of the 159
  // maps where the answer is actually knowable.
  return {
    used: [],
    stranded: distinct,
    reachable: reachableGrid(map, flags),
    reachableTiles: largestArea,
    areas: 1,
    assumedLargest: true,
    largestArea,
  };
}

const where = (point: ArrivalPoint) => {
  const at = `(${point.x}, ${point.y})`;
  if (point.source === 'given') return `${at} as given`;
  if (point.source === 'new-game') return `${at}, the new game start`;
  return point.fromMapId === undefined
    ? `${at}, transferred to from a common event`
    : `${at}, transferred to from map ${point.fromMapId}`;
};

/**
 * One line saying what the survey assumed, for a tool to put in its output.
 *
 * Always worth printing: a caller who does not know an arrival was derived
 * cannot tell a real refusal from a wrong assumption.
 */
export function describeArrival(survey: ArrivalSurvey): string {
  if (survey.assumedLargest) {
    const stood = `the largest walkable area (${survey.reachableTiles} tile(s)) stands in for ` +
      'where the player can be';

    // A start that was *given* and rejected is a different report from one that
    // could not be found: telling the caller to pass startX/startY when they
    // just did would send them round the same loop.
    if (survey.stranded.some((p) => p.source === 'given')) {
      const given = survey.stranded.filter((p) => p.source === 'given');
      return (
        `Arrival: the tile(s) given — ${given.map((p) => `(${p.x}, ${p.y})`).join(', ')} — ` +
        `cannot be stood on: canPass is false in all four directions there, so ${stood}. ` +
        'check_map_walkability names a tile that works.'
      );
    }
    const extra =
      survey.stranded.length > 0
        ? ` The ${survey.stranded.length} arrival tile(s) found — ` +
          `${survey.stranded.map(where).join('; ')} — cannot be stood on, so none of them says ` +
          'anything about where the player can walk.'
        : ' Nothing on disk transfers to this map and it is not the new game map.';
    return `Arrival: unknown, so ${stood}.${extra} Pass startX/startY to say for certain.`;
  }

  const listed = survey.used.slice(0, 4).map(where).join('; ');
  const more = survey.used.length > 4 ? `, and ${survey.used.length - 4} more` : '';
  const spread =
    survey.areas > 1
      ? ` They sit in ${survey.areas} unconnected areas, so the reachable set is the union.`
      : '';
  const lost =
    survey.stranded.length > 0
      ? ` ${survey.stranded.length} further arrival tile(s) land where the player cannot stand ` +
        'and were left out.'
      : '';

  // A *derived* arrival that reaches a fraction of the map is usually a real
  // defect — a door onto a wall strip, or flags nobody configured — and it
  // would otherwise show up only as a surprisingly small tile count further
  // down. `Wicked Heart` map 59 is exactly this: 11 tiles of 516, because
  // map 32 transfers to (0, 49), which canPass blocks to the right.
  //
  // A start the caller *gave* gets the comparison but not the diagnosis: they
  // chose the tile, so a small area is a decision rather than a symptom.
  const small = survey.reachableTiles < survey.largestArea * SUSPICIOUS_SHARE;
  const allGiven = survey.used.every((p) => p.source === 'given');
  const trapped = !small
    ? ''
    : allGiven
      ? ` That is under half the map's largest walkable area (${survey.largestArea} tile(s)), ` +
        'so every count below is scoped to that corner of it.'
      : ` Warning: that is far less than the map's largest walkable area (${survey.largestArea} ` +
        'tile(s)). Either a transfer lands somewhere the player cannot walk out of, or the ' +
        "tileset's passage flags are not what the map assumes — check_map_walkability shows " +
        'which. Every count below is scoped to what the arrival actually reaches.';

  return (
    `Arrival: ${survey.used.length} tile(s) — ${listed}${more} — reaching ` +
    `${survey.reachableTiles} tile(s).${spread}${lost}${trapped}`
  );
}
