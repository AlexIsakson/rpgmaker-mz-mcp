// How big is a hand-made dungeon's interior solid clump?
//
//   node scripts/measure-cave-islands.mjs [mapsDir]
//
// "The cave was at 0.154 [edge density], against a hand-made floor of 0.452" is
// what pushed `generateCave` to grow structure into open space — see "Layout
// shape" in ROADMAP.md. The pillar pass that followed was checked by *counting*
// interior islands (median 5 hand-made, 2 before the pass, 10 after — inside the
// [0, 21] range) but never by their *size*. P5-14 needs that number: "single-tile
// pillars read as studs rather than rock formations" is a claim about size, and
// nothing had measured it.
//
// An interior island is the same thing `tests/core/mapgen.test.ts`'s
// `shapeMetrics` counts: a 4-connected run of solid (non-standable) tiles that
// never touches the map border. Standability comes from `standableGrid`, the
// same function `check_map_walkability` uses, so "solid" here means what the
// engine's passage flags say, not what layer 0's material happens to be.
//
// Run against the 55 samplemaps on the Dungeon tileset (id 4 in
// newdata/data/Tilesets.json) — the same 55 "Layout shape" cites.

import fs from 'node:fs';
import path from 'node:path';
import { standableGrid } from '../dist/core/walkability.js';

const MZ = 'M:/SteamLibrary/steamapps/common/RPG Maker MZ';
const mapsDir = process.argv[2] ?? path.join(MZ, 'samplemaps');
const tilesets = JSON.parse(fs.readFileSync(path.join(MZ, 'newdata/data/Tilesets.json'), 'utf-8'));
const DUNGEON_TILESET_ID = tilesets.findIndex((t) => t && t.name === 'Dungeon');

function islands(standable) {
  const h = standable.length;
  const w = standable[0]?.length ?? 0;
  const seen = Array.from({ length: h }, () => new Array(w).fill(false));
  const sizes = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (standable[y][x] || seen[y][x]) continue;
      const stack = [[x, y]];
      seen[y][x] = true;
      let touchesBorder = false;
      let size = 0;
      while (stack.length > 0) {
        const [cx, cy] = stack.pop();
        size++;
        if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) touchesBorder = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny][nx] || standable[ny][nx]) continue;
          seen[ny][nx] = true;
          stack.push([nx, ny]);
        }
      }
      if (!touchesBorder) sizes.push(size);
    }
  }
  return sizes;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

const files = fs.readdirSync(mapsDir).filter((f) => /^Map\d+\.json$/.test(f));
const allSizes = [];
let mapsWithIslands = 0;
let mapsChecked = 0;

for (const file of files) {
  const map = JSON.parse(fs.readFileSync(path.join(mapsDir, file), 'utf-8'));
  if (map.tilesetId !== DUNGEON_TILESET_ID) continue;
  mapsChecked++;

  const tileset = tilesets[map.tilesetId];
  const standable = standableGrid(map, tileset.flags);
  const sizes = islands(standable);
  if (sizes.length > 0) mapsWithIslands++;
  allSizes.push(...sizes);
}

allSizes.sort((a, b) => a - b);
const single = allSizes.filter((s) => s === 1).length;

console.log(`Dungeon-tileset maps: ${mapsChecked} (tileset id ${DUNGEON_TILESET_ID})`);
console.log(`Maps with at least one interior island: ${mapsWithIslands}`);
console.log(`Total interior islands: ${allSizes.length}`);
console.log(`Single-tile islands: ${single} (${((single / allSizes.length) * 100).toFixed(1)}%)`);
console.log(`Size: median ${percentile(allSizes, 0.5)}, p90 ${percentile(allSizes, 0.9)}, ` +
  `max ${allSizes[allSizes.length - 1]}`);
console.log('Size histogram (1, 2, 3, 4, 5, 6-10, 11+):');
const buckets = [0, 0, 0, 0, 0, 0, 0];
for (const s of allSizes) {
  if (s <= 5) buckets[s - 1]++;
  else if (s <= 10) buckets[5]++;
  else buckets[6]++;
}
console.log(buckets.join(', '));
