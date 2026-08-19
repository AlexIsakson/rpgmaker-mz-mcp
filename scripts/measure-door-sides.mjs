// Which side of a building is its door entered from?
//
//   node scripts/measure-door-sides.mjs
//
// This is the evidence behind "Doors on the other three sides" in ROADMAP.md,
// and behind why `planBuilding` grew a `doorSide` rather than a `topDoor` flag.
//
// `blueprint.ts` has always put the door on the footprint's bottom row and the
// approach on the tile below it, citing "98 of 107 sample door events stand on a
// wall tile". That count says where the door *tile* is; it does not say which
// side the player walks in from, and those are different questions. This script
// asks the second one, by reading the tileset's passage flags the same way
// `Game_CharacterBase.canPass` does and asking which neighbours of the door the
// player could actually be standing on.
//
// A door is a `!Door*` sprite on an event page (`isDoorPage` in blueprint.ts).
// Doors that lead somewhere are counted separately from decorative ones: only a
// page carrying a Transfer Player (code 201) is a door you can go through.
//
// Runs against the built server: `npm run build` first.

import fs from 'node:fs';
import path from 'node:path';
import { canPass, standableGrid } from '../dist/core/walkability.js';
import { isDoorEvent } from '../dist/core/blueprint.js';

const MZ_ROOT = 'M:/SteamLibrary/steamapps/common/RPG Maker MZ';
const SAMPLE_DIR = path.join(MZ_ROOT, 'samplemaps');
const TILESETS = path.join(MZ_ROOT, 'newdata/data/Tilesets.json');

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

const tilesets = readJson(TILESETS);
if (!tilesets) {
  console.error(`No Tilesets.json at ${TILESETS}`);
  process.exit(1);
}

const CODE_TRANSFER_PLAYER = 201;

/** The four neighbours, as [dx, dy, direction-code, name]. */
const SIDES = [
  [0, 1, 2, 'bottom'],
  [-1, 0, 4, 'left'],
  [1, 0, 6, 'right'],
  [0, -1, 8, 'top'],
];

/** The direction you face walking from `side` into the door. */
const FACING = { bottom: 8, top: 2, left: 6, right: 4 };

const counts = {
  maps: 0,
  mapsWithDoors: 0,
  doors: 0,
  transferDoors: 0,
  noStandableNeighbour: 0,
};
const sideCounts = { bottom: 0, top: 0, left: 0, right: 0 };
const soleSideCounts = { bottom: 0, top: 0, left: 0, right: 0 };
const sideByTransfer = { bottom: 0, top: 0, left: 0, right: 0 };
const neighbourHisto = new Map();
const topExamples = [];
const sideExamples = [];

/** The tile the door event itself stands on, top layer first. */
function topTile(map, x, y) {
  const i = y * map.width + x;
  for (let z = 3; z >= 0; z--) {
    const t = map.data[z * map.width * map.height + i];
    if (t) return { z, tile: t };
  }
  return { z: -1, tile: 0 };
}

for (const file of fs.readdirSync(SAMPLE_DIR)) {
  if (!file.endsWith('.json')) continue;
  const map = readJson(path.join(SAMPLE_DIR, file));
  if (!map || !Array.isArray(map.data)) continue;
  counts.maps++;

  const tileset = tilesets[map.tilesetId];
  if (!tileset || !Array.isArray(tileset.flags) || tileset.flags.length === 0) continue;
  const flags = tileset.flags;

  const doors = (map.events ?? []).filter((e) => e && isDoorEvent(e));
  if (doors.length === 0) continue;
  counts.mapsWithDoors++;

  const standable = standableGrid(map, flags);

  for (const door of doors) {
    counts.doors++;
    const goesSomewhere = door.pages.some((p) =>
      (p.list ?? []).some((c) => c.code === CODE_TRANSFER_PLAYER)
    );
    if (goesSomewhere) counts.transferDoors++;

    // A side counts as an approach when the player could stand there AND the
    // engine would let them step from there onto the door tile. Doors are
    // priority "same as characters", so the tile under them is usually
    // impassable wall — canPass is asked about the map, and the event's own
    // blocking is what makes the Player Touch trigger fire.
    const open = [];
    for (const [dx, dy, , name] of SIDES) {
      const nx = door.x + dx;
      const ny = door.y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      if (!standable[ny][nx]) continue;
      // Can the player leave that tile toward the door?
      if (!canPass(map, flags, nx, ny, FACING[name])) continue;
      open.push(name);
    }

    neighbourHisto.set(open.length, (neighbourHisto.get(open.length) ?? 0) + 1);
    if (open.length === 0) {
      counts.noStandableNeighbour++;
      continue;
    }
    for (const name of open) {
      sideCounts[name]++;
      if (goesSomewhere) sideByTransfer[name]++;
    }
    if (open.length === 1) {
      soleSideCounts[open[0]]++;
      if (open[0] === 'top' && topExamples.length < 12) {
        const t = topTile(map, door.x, door.y);
        topExamples.push(`${file} (${door.x},${door.y}) tile ${t.tile} on z${t.z}`);
      }
      if ((open[0] === 'left' || open[0] === 'right') && sideExamples.length < 12) {
        const t = topTile(map, door.x, door.y);
        sideExamples.push(`${file} ${open[0]} (${door.x},${door.y}) tile ${t.tile} on z${t.z}`);
      }
    }
  }
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0');

console.log(`maps scanned            ${counts.maps}`);
console.log(`maps with a door        ${counts.mapsWithDoors}`);
console.log(`door events             ${counts.doors}`);
console.log(`  ... with a transfer   ${counts.transferDoors}`);
console.log(`  ... with no approach  ${counts.noStandableNeighbour}`);
console.log('');
console.log('approach sides (a door with two open sides counts on both):');
for (const [name, n] of Object.entries(sideCounts)) {
  console.log(`  ${name.padEnd(7)} ${String(n).padStart(4)}  ${pct(n, counts.doors)}%   (transfer doors: ${sideByTransfer[name]})`);
}
console.log('');
console.log('doors with exactly one open side — the side is then unambiguous:');
const soleTotal = Object.values(soleSideCounts).reduce((a, b) => a + b, 0);
for (const [name, n] of Object.entries(soleSideCounts)) {
  console.log(`  ${name.padEnd(7)} ${String(n).padStart(4)}  ${pct(n, soleTotal)}% of ${soleTotal}`);
}
console.log('');
console.log('open-side count per door:');
for (const k of [...neighbourHisto.keys()].sort()) {
  console.log(`  ${k} side(s)  ${neighbourHisto.get(k)}`);
}
if (topExamples.length) {
  console.log('\ntop-approach examples:');
  for (const e of topExamples) console.log(`  ${e}`);
}
if (sideExamples.length) {
  console.log('\nleft/right-approach examples:');
  for (const e of sideExamples) console.log(`  ${e}`);
}
