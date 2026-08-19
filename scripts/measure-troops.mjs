// Counts what an encounter table would have to name: troops, their members,
// and whether anything in the data orders them by difficulty.
//
//   node scripts/measure-troops.mjs [projectRoot...]
//
// This is the evidence behind "An encounter table names troops that mostly do
// not exist" in ROADMAP.md, and behind why `set_map_encounters` refuses an
// empty troop instead of noting it.
//
// The engine path a row has to survive:
//
//   Game_Player.makeEncounterTroopId -> meetsEncounterConditions(row)   (regionSet)
//                                    -> weighted pick, guarded by weightSum > 0
//   Game_Player.executeEncounter     -> if ($dataTroops[troopId])       (row exists)
//   BattleManager.checkBattleEnd     -> $gameTroop.isAllDead()          (row has members)
//
// The last one is the quiet failure this script exists to size: a troop row with
// no members is truthy, so the battle starts and is won on the first frame.

import fs from 'node:fs';
import path from 'node:path';

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

/** Every `data/` (and the bare `samplemaps/`) under the search roots. */
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

const args = process.argv.slice(2);
const dirs =
  args.length > 0
    ? args.map((d) => (fs.existsSync(path.join(d, 'data')) ? path.join(d, 'data') : d))
    : SEARCH_ROOTS.flatMap((r) => findDataDirs(r, 0, []));

const total = {
  dirs: 0,
  withTroops: 0,
  rows: 0,
  withMembers: 0,
  named: 0,
  namedAndFilled: 0,
  members: new Map(),
  maps: 0,
  withEncounters: 0,
  steps: new Map(),
};

const perProject = [];

for (const dir of dirs) {
  total.dirs++;

  const maps = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^Map\d{3,}\.json$/.test(f))
    : [];
  let mapsWithEncounters = 0;
  for (const file of maps) {
    const map = readJson(path.join(dir, file));
    if (!map) continue;
    total.maps++;
    if (Array.isArray(map.encounterList) && map.encounterList.length > 0) {
      mapsWithEncounters++;
      total.withEncounters++;
    }
    if (map.encounterStep !== undefined) {
      total.steps.set(map.encounterStep, (total.steps.get(map.encounterStep) ?? 0) + 1);
    }
  }

  const troops = readJson(path.join(dir, 'Troops.json'));
  if (!Array.isArray(troops)) {
    if (maps.length > 0) perProject.push({ dir, rows: 0, filled: 0, named: 0, maps: maps.length, mapsWithEncounters });
    continue;
  }
  total.withTroops++;

  let rows = 0;
  let filled = 0;
  let named = 0;
  for (const troop of troops) {
    if (!troop) continue; // index 0 is null in every database file
    rows++;
    total.rows++;
    const count = Array.isArray(troop.members) ? troop.members.length : 0;
    total.members.set(count, (total.members.get(count) ?? 0) + 1);
    if (count > 0) {
      filled++;
      total.withMembers++;
    }
    const hasName = typeof troop.name === 'string' && troop.name.trim() !== '';
    if (hasName) {
      named++;
      total.named++;
      if (count > 0) total.namedAndFilled++;
    }
  }
  perProject.push({ dir, rows, filled, named, maps: maps.length, mapsWithEncounters });
}

const short = (d) => d.replace(/^M:[\/]/, '').replace(/[\/]data$/, '');
const pad = (s, n) => String(s).padEnd(n);

console.log('\n=== troop rows, per data directory ===');
console.log(pad('rows', 6), pad('filled', 7), pad('named', 6), pad('maps', 6), pad('w/ enc', 7), 'directory');
for (const p of perProject.sort((a, b) => b.rows - a.rows)) {
  console.log(
    pad(p.rows, 6), pad(p.filled, 7), pad(p.named, 6), pad(p.maps, 6),
    pad(p.mapsWithEncounters, 7), short(p.dir)
  );
}

console.log('\n=== totals ===');
console.log(`data directories scanned : ${total.dirs} (${total.withTroops} with a Troops.json)`);
console.log(`maps                     : ${total.maps}`);
console.log(`maps with an encounterList: ${total.withEncounters}`);
console.log(
  'encounterStep values     : ' +
    [...total.steps].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} on ${n} map(s)`).join(', ')
);
console.log(`troop rows               : ${total.rows}`);
console.log(
  `  with at least one member: ${total.withMembers} ` +
    `(${((total.withMembers / total.rows) * 100).toFixed(1)}%)`
);
console.log(`  carrying a name         : ${total.named}`);
console.log(`  named AND filled        : ${total.namedAndFilled}`);

console.log('\n=== members per troop row ===');
for (const [count, n] of [...total.members].sort((a, b) => a[0] - b[0])) {
  console.log(pad(`${count} member(s)`, 14), pad(n, 6), `${((n / total.rows) * 100).toFixed(1)}%`);
}
console.log();
