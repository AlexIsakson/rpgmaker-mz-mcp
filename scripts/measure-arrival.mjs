// Counts how often "the largest walkable area" is the wrong guess at where the
// player is, and what else on disk knows better.
//
//   node scripts/measure-arrival.mjs [projectRoot...]
//
// This is the evidence behind "The largest area is not where the player is" in
// ROADMAP.md, and behind why `checkEncounterSource` derives an arrival tile
// instead of falling back to the biggest blob.
//
// The engine path it measures:
//
//   Game_Player.meetsEncounterConditions -> this.regionId()   // under the PLAYER
//   Game_Interpreter.command201          -> $gamePlayer.reserveTransfer(mapId, x, y)
//   Scene_Boot / DataManager.setupNewGame-> $gamePlayer.setTransparent, System.json startX/startY
//
// So the tiles the player can occupy on a given map are the ones connected to
// wherever they arrive — a Transfer Player aimed at this map, or the new-game
// start position — and not, in general, the map's largest connected area.
//
// Runs against the built server: `npm run build` first.

import fs from 'node:fs';
import path from 'node:path';
import { analyseWalkability, reachableGrid } from '../dist/core/walkability.js';

const SEARCH_ROOTS = [
  'M:/SteamLibrary/steamapps/common/RPG Maker MZ',
  'M:/Projects/RPGMZ',
  'M:/Projects/VisuMZ_Sample_Game_Project',
];

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

function findDataDirs(dir, depth, out) {
  if (depth > 4) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === 'data' || entry.name === 'samplemaps') out.push(full);
    else findDataDirs(full, depth + 1, out);
  }
  return out;
}

/** Every Transfer Player in a command list that names a literal destination. */
function collectTransfers(list, into) {
  if (!Array.isArray(list)) return;
  for (const cmd of list) {
    if (!cmd || cmd.code !== 201) continue;
    const p = cmd.parameters;
    // params[0] is the designation: 0 is a literal map/x/y, 1 reads three
    // variables and cannot be resolved from the file.
    if (!Array.isArray(p) || p[0] !== 0) continue;
    into.push({ mapId: p[1], x: p[2], y: p[3] });
  }
}

function scan(dir) {
  const mapFiles = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^Map\d{3,}\.json$/.test(f)).sort()
    : [];
  if (mapFiles.length === 0) return null;

  const tilesets = readJson(path.join(dir, 'Tilesets.json'));
  if (!Array.isArray(tilesets)) return null;

  const maps = new Map();
  for (const file of mapFiles) {
    const map = readJson(path.join(dir, file));
    if (map && Array.isArray(map.data)) maps.set(parseInt(file.slice(3, -5), 10), map);
  }

  // Every literal transfer destination anywhere in the project, by target map.
  const transfers = [];
  for (const map of maps.values()) {
    for (const event of map.events ?? []) {
      for (const page of event?.pages ?? []) collectTransfers(page.list, transfers);
    }
  }
  for (const common of readJson(path.join(dir, 'CommonEvents.json')) ?? []) {
    if (common) collectTransfers(common.list, transfers);
  }
  for (const troop of readJson(path.join(dir, 'Troops.json')) ?? []) {
    for (const page of troop?.pages ?? []) collectTransfers(page.list, transfers);
  }

  const system = readJson(path.join(dir, 'System.json'));
  const arrivals = new Map();
  const add = (mapId, x, y) => {
    if (!arrivals.has(mapId)) arrivals.set(mapId, []);
    arrivals.get(mapId).push({ x, y });
  };
  for (const t of transfers) add(t.mapId, t.x, t.y);
  if (system && system.startMapId > 0) add(system.startMapId, system.startX, system.startY);

  const t = {
    maps: 0,
    mapsWithArrival: 0,
    arrivalPoints: 0,
    arrivalUnstandable: 0,
    arrivalOutsideLargest: 0,
    mapsArrivalOutsideLargest: 0,
    mapsMultipleAreas: 0,
    // The population the fallback actually matters for.
    mapsWhereGuessWrong: 0,
    reachableDelta: [],
    // The cheap local signal: the event carrying the command.
    events: 0,
    eventsOutsideLargest: 0,
    eventsUnstandable: 0,
    mapsNoEventInLargest: 0,
  };

  for (const [mapId, map] of maps) {
    const tileset = tilesets[map.tilesetId];
    if (!tileset || !Array.isArray(tileset.flags)) continue;
    const flags = tileset.flags;
    t.maps++;

    const report = analyseWalkability(map, flags);
    if (report.isolatedAreas.length > 0) t.mapsMultipleAreas++;

    const largest = reachableGrid(map, flags);
    const inLargest = (x, y) =>
      x >= 0 && y >= 0 && x < map.width && y < map.height && largest[y][x];

    let eventsInLargest = 0;
    let eventCount = 0;
    for (const event of map.events ?? []) {
      if (!event) continue;
      eventCount++;
      t.events++;
      if (inLargest(event.x, event.y)) eventsInLargest++;
      else {
        t.eventsOutsideLargest++;
        // Standable but in another area, versus flatly on a wall.
        const alone = reachableGrid(map, flags, { start: { x: event.x, y: event.y } });
        if (!alone[event.y]?.[event.x]) t.eventsUnstandable++;
      }
    }
    if (eventCount > 0 && eventsInLargest === 0) t.mapsNoEventInLargest++;

    const points = arrivals.get(mapId) ?? [];
    if (points.length === 0) continue;
    t.mapsWithArrival++;

    let anyOutside = false;
    for (const point of points) {
      t.arrivalPoints++;
      const grid = reachableGrid(map, flags, { start: point });
      const standable = grid[point.y]?.[point.x] ?? false;
      if (!standable) {
        t.arrivalUnstandable++;
        continue;
      }
      if (!inLargest(point.x, point.y)) {
        t.arrivalOutsideLargest++;
        anyOutside = true;
        let size = 0;
        for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (grid[y][x]) size++;
        t.reachableDelta.push({ mapId, largest: report.reachableTiles, actual: size });
      }
    }
    if (anyOutside) {
      t.mapsArrivalOutsideLargest++;
      t.mapsWhereGuessWrong++;
    }
  }

  return t;
}

const args = process.argv.slice(2);
const dirs =
  args.length > 0
    ? args.map((d) => (fs.existsSync(path.join(d, 'data')) ? path.join(d, 'data') : d))
    : SEARCH_ROOTS.flatMap((r) => findDataDirs(r, 0, []));

const short = (d) => d.replace(/^M:[\\/]/, '').replace(/[\\/]data$/, '');
const pad = (s, n) => String(s).padEnd(n);
const totals = {};
const rows = [];

for (const dir of dirs) {
  const t = scan(dir);
  if (!t) continue;
  rows.push({ dir, ...t });
  for (const [key, value] of Object.entries(t)) {
    if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
    else if (Array.isArray(value)) (totals[key] ??= []).push(...value);
  }
}

console.log('\n=== where the player arrives, per data directory ===');
console.log(
  pad('maps', 6), pad('w/ arrival', 11), pad('points', 7), pad('outside largest', 16),
  pad('unstandable', 12), 'directory'
);
for (const r of rows.sort((a, b) => b.maps - a.maps)) {
  console.log(
    pad(r.maps, 6), pad(r.mapsWithArrival, 11), pad(r.arrivalPoints, 7),
    pad(r.arrivalOutsideLargest, 16), pad(r.arrivalUnstandable, 12), short(r.dir)
  );
}

console.log('\n=== totals ===');
console.log(`maps analysed                      : ${totals.maps}`);
console.log(`  with more than one walkable area : ${totals.mapsMultipleAreas}`);
console.log(`maps something transfers into      : ${totals.mapsWithArrival}`);
console.log(`arrival points                     : ${totals.arrivalPoints}`);
console.log(`  landing on an unstandable tile   : ${totals.arrivalUnstandable}`);
console.log(
  `  OUTSIDE the largest area         : ${totals.arrivalOutsideLargest} ` +
    `(on ${totals.mapsArrivalOutsideLargest} map(s))`
);
console.log(`events on maps                     : ${totals.events}`);
console.log(`  outside the largest area         : ${totals.eventsOutsideLargest}`);
console.log(`  of those, standing on a wall     : ${totals.eventsUnstandable}`);
console.log(`maps where NO event is in the largest area: ${totals.mapsNoEventInLargest}`);

if (totals.reachableDelta?.length) {
  console.log('\n=== what the wrong guess costs, tile by tile ===');
  console.log(pad('map', 6), pad('largest area', 14), 'actually reachable from the arrival tile');
  for (const d of totals.reachableDelta.slice(0, 25)) {
    console.log(pad(d.mapId, 6), pad(d.largest, 14), d.actual);
  }
  if (totals.reachableDelta.length > 25) {
    console.log(`... and ${totals.reachableDelta.length - 25} more`);
  }
}
console.log();
