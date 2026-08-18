// Counts how maps set up random encounters, and whether the region plane gates
// any of them.
//
//   node scripts/measure-encounters.mjs [projectRoot...]
//
// This is the evidence behind "Designation is a fork in the engine" in
// ROADMAP.md and behind why `battle_processing` designation 2 is refused on a
// map with no encounters. The engine path it measures:
//
//   Game_Player.makeEncounterTroopId -> $gameMap.encounterList()
//                                    -> meetsEncounterConditions(encounter)
//                                    -> returns 0 when weightSum === 0
//
// A returned 0 lands in `if ($dataTroops[troopId])`, which is null at index 0 —
// so an empty or unreachable encounter list makes a "same as random encounters"
// battle do nothing at all, silently, exactly like P5-33's bad troop id.
//
// Unlike build-passage-catalogue.mjs this generates nothing — it prints counts.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ROOTS = [
  ['samplemaps', 'M:/SteamLibrary/steamapps/common/RPG Maker MZ/samplemaps'],
  ['newdata', 'M:/SteamLibrary/steamapps/common/RPG Maker MZ/newdata'],
  ['Wicked Heart', 'M:/Projects/RPGMZ/Wicked Heart'],
  ['Red Harvest', 'M:/Projects/RPGMZ/Red Harvest'],
  ['Foo', 'M:/Projects/RPGMZ/Foo'],
  ['Learn', 'M:/Projects/RPGMZ/Learn'],
  ['VisuMZ sample', 'M:/Projects/VisuMZ_Sample_Game_Project'],
];

const args = process.argv.slice(2);
const roots = args.length > 0 ? args.map((d) => [path.basename(d) || d, d]) : DEFAULT_ROOTS;

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/** z=5 is the region plane: data[(5 * height + y) * width + x]. */
function regionsPainted(map) {
  const { width, height, data } = map;
  if (!Array.isArray(data) || !width || !height) return null;
  const base = 5 * height * width;
  if (data.length < base + width * height) return null; // fewer than six planes
  const ids = new Set();
  for (let i = base; i < base + width * height; i++) if (data[i] > 0) ids.add(data[i]);
  return ids;
}

function scanRoot(label, root) {
  const dataDir = fs.existsSync(path.join(root, 'data')) ? path.join(root, 'data') : root;
  if (!fs.existsSync(dataDir)) return null;

  const mapFiles = fs
    .readdirSync(dataDir)
    .filter((f) => /^Map\d{3,}\.json$/.test(f))
    .sort();

  const t = {
    maps: 0,
    withEncounters: 0,
    rows: 0,
    rowsWithRegionSet: 0,
    rowsZeroWeight: 0,
    troopIds: new Set(),
    steps: new Map(),
    // The two silent failures: a row gated on a region the map never paints,
    // and a map whose whole list is gated that way.
    rowsGatedOnUnpaintedRegion: 0,
    mapsWholeListUnreachable: 0,
    mapsPaintingRegions: 0,
  };

  for (const file of mapFiles) {
    const map = readJson(path.join(dataDir, file));
    if (!map) continue;
    t.maps++;

    const painted = regionsPainted(map);
    if (painted && painted.size > 0) t.mapsPaintingRegions++;

    const list = Array.isArray(map.encounterList) ? map.encounterList : [];
    if (list.length === 0) continue;
    t.withEncounters++;
    t.steps.set(map.encounterStep, (t.steps.get(map.encounterStep) ?? 0) + 1);

    let reachableWeight = 0;
    for (const row of list) {
      t.rows++;
      t.troopIds.add(row.troopId);
      const regionSet = Array.isArray(row.regionSet) ? row.regionSet : [];
      const weight = typeof row.weight === 'number' ? row.weight : 0;
      if (weight === 0) t.rowsZeroWeight++;
      if (regionSet.length > 0) {
        t.rowsWithRegionSet++;
        const reachable = painted === null || regionSet.some((r) => painted.has(r));
        if (!reachable) t.rowsGatedOnUnpaintedRegion++;
        else reachableWeight += weight;
      } else reachableWeight += weight;
    }
    if (reachableWeight === 0) t.mapsWholeListUnreachable++;
  }

  return { label, ...t };
}

const results = roots.map(([label, root]) => scanRoot(label, root)).filter(Boolean);
const pad = (s, n) => String(s).padEnd(n);

console.log('\n=== maps with an encounterList ===');
console.log(
  pad('project', 16), pad('maps', 6), pad('with enc', 9), pad('rows', 6),
  pad('distinct troops', 16), 'encounterStep'
);
for (const r of results) {
  const steps = [...r.steps].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}x${n}`).join(' ');
  console.log(
    pad(r.label, 16), pad(r.maps, 6), pad(r.withEncounters, 9), pad(r.rows, 6),
    pad(r.troopIds.size, 16), steps || '-'
  );
}

console.log('\n=== how the rows are gated ===');
console.log(
  pad('project', 16), pad('rows', 6), pad('regionSet', 10), pad('weight 0', 9),
  pad('maps painting regions', 22), 'rows gated on an unpainted region'
);
for (const r of results) {
  console.log(
    pad(r.label, 16), pad(r.rows, 6), pad(r.rowsWithRegionSet, 10), pad(r.rowsZeroWeight, 9),
    pad(`${r.mapsPaintingRegions}/${r.maps}`, 22), r.rowsGatedOnUnpaintedRegion
  );
}

console.log('\n=== maps where makeEncounterTroopId would always return 0 ===');
console.log(pad('project', 16), pad('with enc', 9), 'of those, no reachable weight');
for (const r of results) {
  console.log(pad(r.label, 16), pad(r.withEncounters, 9), r.mapsWholeListUnreachable);
}
console.log();
