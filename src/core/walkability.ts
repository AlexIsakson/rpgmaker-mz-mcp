import type { MapData } from '../schemas/map.js';
import { readTile, PASSAGE_BIT } from './map-grid.js';

/**
 * Reachability analysis over a map's static passability.
 *
 * `get_map_grid` answers "is this tile a wall"; this answers the question that
 * actually breaks a map — "can the player get there". A door nobody can walk up
 * to, an NPC sealed inside a building and a courtyard with no entrance all look
 * fine tile by tile and are only visible once you traverse the map.
 *
 * Movement follows Game_CharacterBase.canPass: leaving a tile in a direction and
 * entering the neighbour from the opposite direction must both be allowed. Like
 * the rest of the static analysis here, events standing on tiles are not treated
 * as obstacles — that is runtime state.
 */

export type Direction = 2 | 4 | 6 | 8;

const DIRECTIONS: Direction[] = [2, 4, 6, 8];
const STEP: Record<Direction, [number, number]> = {
  2: [0, 1],
  4: [-1, 0],
  6: [1, 0],
  8: [0, -1],
};
const BIT: Record<Direction, number> = {
  2: PASSAGE_BIT.down,
  4: PASSAGE_BIT.left,
  6: PASSAGE_BIT.right,
  8: PASSAGE_BIT.up,
};
const reverse = (d: Direction): Direction => (10 - d) as Direction;

export interface WalkabilityIssue {
  kind: 'event-on-wall' | 'event-unreachable' | 'door-unreachable' | 'isolated-area';
  message: string;
  x: number;
  y: number;
}

export interface WalkabilityOptions {
  /**
   * A tile the player is known to be able to stand on — usually where they
   * arrive on the map.
   *
   * Without it the largest walkable area is taken as the reachable one, and on
   * an interior that is wrong: a room's wall tops are passable *along
   * themselves* in the RTP tilesets, so the ring around the room is a bigger
   * connected area than the room, and the player can never set foot on it.
   * Analysing an interior shipped with the editor that way reports the room as
   * cut off and its own exit as unreachable.
   */
  start?: { x: number; y: number };
}

export interface WalkabilityReport {
  width: number;
  height: number;
  standableTiles: number;
  reachableTiles: number;
  /** Where the flood started: the given start, or the largest area's first tile. */
  start: { x: number; y: number } | null;
  /** Whether `start` was supplied rather than guessed. */
  startWasGiven: boolean;
  /** Set when a start was given but the player could not stand there. */
  startUnstandable: boolean;
  /** Standable tiles cut off from the reachable area, grouped into areas. */
  isolatedAreas: { size: number; sample: { x: number; y: number } }[];
  issues: WalkabilityIssue[];
}

/**
 * Which tiles the player could occupy, as `grid[y][x]`.
 *
 * Exposed because placement is a connectivity problem, not just a rendering
 * one: anything that blocks a tile — an NPC, a prop — has to be checked against
 * this before it goes down.
 */
export function standableGrid(map: MapData, flags: number[]): boolean[][] {
  const grid: boolean[][] = [];
  for (let y = 0; y < map.height; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < map.width; x++) row.push(isStandable(map, flags, x, y));
    grid.push(row);
  }
  return grid;
}

/** A tile the player could occupy: passable from at least one direction. */
function isStandable(map: MapData, flags: number[], x: number, y: number): boolean {
  const tile = readTile(map, flags, x, y);
  return tile.passable.up || tile.passable.down || tile.passable.left || tile.passable.right;
}

/**
 * Game_CharacterBase.canPass: leaving a tile in a direction and entering the
 * neighbour from the opposite direction must both be allowed.
 *
 * Exported because "are these two tiles connected" is not "are they both
 * walkable" — passage flags are directional, so two adjacent standable tiles
 * can be mutually unreachable. Anything reasoning about reachability has to use
 * this rather than adjacency, or it will believe in paths that do not exist.
 */
export function canPass(
  map: MapData,
  flags: number[],
  x: number,
  y: number,
  d: Direction
): boolean {
  const [dx, dy] = STEP[d];
  const nx = x + dx;
  const ny = y + dy;
  if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) return false;

  const here = readTile(map, flags, x, y).passable;
  const there = readTile(map, flags, nx, ny).passable;
  const out = d === 2 ? here.down : d === 4 ? here.left : d === 6 ? here.right : here.up;
  const rd = reverse(d);
  const into = rd === 2 ? there.down : rd === 4 ? there.left : rd === 6 ? there.right : there.up;
  return out && into;
}

function flood(
  map: MapData,
  flags: number[],
  start: { x: number; y: number },
  seen: boolean[][]
): number {
  const stack = [start];
  seen[start.y][start.x] = true;
  let count = 1;

  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    for (const d of DIRECTIONS) {
      const [dx, dy] = STEP[d];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      if (seen[ny][nx]) continue;
      if (!canPass(map, flags, x, y, d)) continue;
      seen[ny][nx] = true;
      count++;
      stack.push({ x: nx, y: ny });
    }
  }

  return count;
}

/** Doors are events carrying a `!Door...` sprite; the player uses them from below. */
function isDoorEvent(event: { pages?: { image?: { characterName?: string } }[] }): boolean {
  const name = event.pages?.[0]?.image?.characterName ?? '';
  return name.startsWith('!Door');
}

interface WalkableArea {
  size: number;
  sample: { x: number; y: number };
  seen: boolean[][];
}

interface AreaSurvey {
  standable: boolean[][];
  standableTiles: number;
  /** Every connected area, largest first. */
  areas: WalkableArea[];
  /** The one the player is taken to be in. */
  main: WalkableArea | undefined;
  startUnstandable: boolean;
}

/**
 * Every connected walkable area, and which one counts as the player's.
 *
 * Split out of `analyseWalkability` because reachability is not only a
 * map-integrity question: an encounter region over tiles the player cannot get
 * to never fires, so `encounters.ts` needs the same flood — and has to agree
 * with the walkability report about which area is the main one, or the two
 * tools would disagree about the same map.
 */
function surveyAreas(map: MapData, flags: number[], options: WalkabilityOptions): AreaSurvey {
  const { width, height } = map;

  const standable: boolean[][] = [];
  let standableTiles = 0;
  for (let y = 0; y < height; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < width; x++) {
      const ok = isStandable(map, flags, x, y);
      if (ok) standableTiles++;
      row.push(ok);
    }
    standable.push(row);
  }

  // Flood every area, largest first, so "reachable" means "in the main area"
  // rather than "in whichever corner the scan happened to start".
  const areas: WalkableArea[] = [];
  const claimed = standable.map((row) => row.map(() => false));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!standable[y][x] || claimed[y][x]) continue;
      const seen = standable.map((row) => row.map(() => false));
      const size = flood(map, flags, { x, y }, seen);
      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) if (seen[j][i]) claimed[j][i] = true;
      }
      areas.push({ size, sample: { x, y }, seen });
    }
  }

  areas.sort((a, b) => b.size - a.size);

  // A given start beats the largest area. "Biggest" is only a stand-in for
  // "where the player is", and on an interior the two are different areas.
  const given = options.start;
  const startUnstandable =
    given !== undefined &&
    (given.x < 0 || given.y < 0 || given.x >= width || given.y >= height ||
      !standable[given.y][given.x]);
  const main =
    given && !startUnstandable
      ? areas.find((a) => a.seen[given.y][given.x]) ?? areas[0]
      : areas[0];

  return { standable, standableTiles, areas, main, startUnstandable };
}

/**
 * Which tiles the player can actually get to, as `grid[y][x]`.
 *
 * `standableGrid` answers "could the player occupy this tile"; this answers
 * "can the player ever be here", which is the question an encounter region has
 * to pass. Same start rule as `analyseWalkability`: a given start wins, and
 * without one the largest area stands in for where the player is.
 */
export function reachableGrid(
  map: MapData,
  flags: number[],
  options: WalkabilityOptions = {}
): boolean[][] {
  const { main } = surveyAreas(map, flags, options);
  return (
    main?.seen ??
    Array.from({ length: map.height }, () => new Array<boolean>(map.width).fill(false))
  );
}

export interface MultiStartReach {
  /** Tiles reachable from at least one usable start, as `grid[y][x]`. */
  grid: boolean[][];
  /** Starts that landed on a tile the player can occupy. */
  used: { x: number; y: number }[];
  /** Starts on a tile the player cannot stand on — they contribute nothing. */
  stranded: { x: number; y: number }[];
  /** How many separate areas the usable starts landed in. */
  areas: number;
}

/**
 * Tiles reachable from **any** of several starts.
 *
 * A map is not entered from one place. `Game_Player.reserveTransfer` can aim at
 * a different tile from every other map in the project, and two of them can sit
 * in areas that are not connected to each other — so the set of tiles the
 * player can ever occupy is the union of the areas the arrivals land in, not
 * any single one of them. Measured across the projects on this machine: 159
 * maps are transferred into at all, and they carry 394 arrival points between
 * them, so more than two per map is the normal case.
 *
 * One area survey serves every start, so the cost does not grow with the number
 * of arrivals.
 */
export function reachableFromAny(
  map: MapData,
  flags: number[],
  starts: readonly { x: number; y: number }[]
): MultiStartReach {
  const { areas, standable } = surveyAreas(map, flags, {});
  const grid = Array.from({ length: map.height }, () => new Array<boolean>(map.width).fill(false));
  const used: { x: number; y: number }[] = [];
  const stranded: { x: number; y: number }[] = [];
  const claimed = new Set<(typeof areas)[number]>();

  for (const start of starts) {
    const inside =
      start.x >= 0 && start.y >= 0 && start.x < map.width && start.y < map.height;
    if (!inside || !standable[start.y][start.x]) {
      stranded.push(start);
      continue;
    }
    used.push(start);
    const area = areas.find((a) => a.seen[start.y][start.x]);
    if (area) claimed.add(area);
  }

  for (const area of claimed) {
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) if (area.seen[y][x]) grid[y][x] = true;
    }
  }

  return { grid, used, stranded, areas: claimed.size };
}

export function analyseWalkability(
  map: MapData,
  flags: number[],
  options: WalkabilityOptions = {}
): WalkabilityReport {
  const { width, height } = map;
  const { standable, standableTiles, areas, main, startUnstandable } = surveyAreas(
    map,
    flags,
    options
  );
  const given = options.start;

  const issues: WalkabilityIssue[] = [];

  for (const event of map.events ?? []) {
    if (!event) continue;
    const { x, y, name } = event;
    if (x < 0 || y < 0 || x >= width || y >= height) continue;

    if (isDoorEvent(event)) {
      const fy = y + 1;
      const approachable = fy < height && (main?.seen[fy][x] ?? false);
      if (!approachable) {
        issues.push({
          kind: 'door-unreachable',
          x, y,
          message: `Door "${name}" at (${x}, ${y}) has no reachable tile in front of it — the player cannot open it.`,
        });
      }
      continue;
    }

    if (!standable[y][x]) {
      issues.push({
        kind: 'event-on-wall',
        x, y,
        message: `Event "${name}" at (${x}, ${y}) stands on an impassable tile.`,
      });
    } else if (!(main?.seen[y][x] ?? false)) {
      issues.push({
        kind: 'event-unreachable',
        x, y,
        message: `Event "${name}" at (${x}, ${y}) is walled off from the main walkable area.`,
      });
    }
  }

  // Everything that is not the reachable area — which is not always the largest
  // one once a start has been given.
  const isolatedAreas = areas
    .filter((a) => a !== main)
    .map((a) => ({ size: a.size, sample: a.sample }));
  for (const area of isolatedAreas) {
    if (area.size < 3) continue; // a stray tile behind scenery is not worth reporting
    issues.push({
      kind: 'isolated-area',
      x: area.sample.x,
      y: area.sample.y,
      message: `${area.size} walkable tiles around (${area.sample.x}, ${area.sample.y}) are cut off from the main area.`,
    });
  }

  return {
    width,
    height,
    standableTiles,
    reachableTiles: main?.size ?? 0,
    start: given && !startUnstandable ? given : main?.sample ?? null,
    startWasGiven: given !== undefined && !startUnstandable,
    startUnstandable,
    isolatedAreas,
    issues,
  };
}

export function renderWalkabilityReport(report: WalkabilityReport): string {
  const lines = [
    `Walkability — ${report.width}x${report.height}`,
    `  Standable tiles: ${report.standableTiles} of ${report.width * report.height}`,
    `  ${report.startWasGiven ? 'Area reachable from the start' : 'Largest connected area'}: ` +
      `${report.reachableTiles}` +
      (report.start ? ` (from ${report.start.x}, ${report.start.y})` : ''),
  ];

  if (report.startUnstandable) {
    lines.push(
      '',
      'The start tile given is not standable, so the largest area was used instead. ' +
        'Check the coordinates — a start inside a wall makes every finding below suspect.'
    );
  }

  if (report.issues.length === 0) {
    lines.push('', 'No unreachable events, blocked doors or cut-off areas.');
  } else {
    lines.push('', `${report.issues.length} issue(s):`);
    for (const issue of report.issues) lines.push(`  [${issue.kind}] ${issue.message}`);
  }

  lines.push(
    '',
    'Passability is static: this does not account for events blocking tiles at ' +
      'runtime, and a tileset whose passage flags were never configured reports ' +
      'everything as open — check_project flags that case.'
  );

  return lines.join('\n');
}
