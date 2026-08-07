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

export interface WalkabilityReport {
  width: number;
  height: number;
  standableTiles: number;
  reachableTiles: number;
  /** Where the flood started — the top-left standable tile of the largest area. */
  start: { x: number; y: number } | null;
  /** Standable tiles cut off from the largest area, grouped into areas. */
  isolatedAreas: { size: number; sample: { x: number; y: number } }[];
  issues: WalkabilityIssue[];
}

/** A tile the player could occupy: passable from at least one direction. */
function isStandable(map: MapData, flags: number[], x: number, y: number): boolean {
  const tile = readTile(map, flags, x, y);
  return tile.passable.up || tile.passable.down || tile.passable.left || tile.passable.right;
}

function canPass(
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

export function analyseWalkability(map: MapData, flags: number[]): WalkabilityReport {
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
  const areas: { size: number; sample: { x: number; y: number }; seen: boolean[][] }[] = [];
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
  const main = areas[0];
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

  const isolatedAreas = areas.slice(1).map((a) => ({ size: a.size, sample: a.sample }));
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
    start: main?.sample ?? null,
    isolatedAreas,
    issues,
  };
}

export function renderWalkabilityReport(report: WalkabilityReport): string {
  const lines = [
    `Walkability — ${report.width}x${report.height}`,
    `  Standable tiles: ${report.standableTiles} of ${report.width * report.height}`,
    `  Largest connected area: ${report.reachableTiles}` +
      (report.start ? ` (from ${report.start.x}, ${report.start.y})` : ''),
  ];

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
