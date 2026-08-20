// What shape are hand-made maps, actually?
//
//   node scripts/measure-map-shape.mjs [mapsDir] [dataDir] [tilesetImgDir]
//
// With no arguments it measures the 293 shipped sample maps. **Point it at a
// generated project's `data` folder to measure the generators with the same
// instrument** — that is how P5-09 checks itself, and it is where the numbers
// below stop being a description and become a target:
//
//   node scripts/measure-map-shape.mjs path/to/Project/data path/to/Project/data
//
// This is the evidence behind "The shape of a hand-made map" in ROADMAP.md, and
// the numbers P5-08 (L-shaped roofs), P5-09 (ragged ground edges) and P5-10
// (rooms and blocks that are not boxes) are designed against.
//
// Visual review finding 7 has never moved: everything the generators emit is a
// rectangle. That is an impression until it has a number opposite it, so this
// asks four questions of the 293 shipped sample maps.
//
//  1. **How far does a material boundary run straight before it turns?**
//     `fill_map_region` over a 20-wide rect emits a boundary that runs straight
//     for 20 tiles. The question is what a person draws instead.
//
//  2. **Is a roof footprint a rectangle, and when it is not, which pieces does
//     it turn the corner with?** `blueprint.ts` catalogues each set's
//     inner-corner pair and nothing uses them.
//
//  3. **Are ground regions — streets and patches — rectangles?**
//
//  4. **Are interior rooms rectangles?**
//
// **Roofs are identified from the editor's own tile labels, not guessed.** RPG
// Maker ships a `.txt` beside every tileset PNG holding one line per tile,
// `English|Japanese`. On the object sheets that is one line per tile id; on the
// autotile sheets it is one line per *kind*. A roof is a tile the editor calls
// one, which is the only non-circular way to ask the question — the C sheets
// hold towers, monuments and chimneys that a purely structural test reads as
// roofs. Those files ship only with the editor, never inside a project.

import fs from 'node:fs';
import path from 'node:path';

const MZ = 'M:/SteamLibrary/steamapps/common/RPG Maker MZ';
const sampleDir = process.argv[2] ?? path.join(MZ, 'samplemaps');
const dataDir = process.argv[3] ?? path.join(MZ, 'newdata/data');
const imgDir = process.argv[4] ?? path.join(MZ, 'newdata/img/tilesets');

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

// --- sheet geometry ---------------------------------------------------------
// Tilemap._drawNormalTile reads the object sheets as two 8-wide halves.
const HALF = 8;
const sheetCol = (id) => (Math.floor(id / 128) % 2) * HALF + (id % HALF);
const sheetRow = (id) => Math.floor((id % 256) / HALF) % 16;

/** A tileset's nine sheet slots, in `tilesetNames` order — same table as passage.ts. */
const SLOTS = [
  { name: 'A1', index: 0, start: 2048, count: 768, kinds: [0, 15] },
  { name: 'A2', index: 1, start: 2816, count: 1536, kinds: [16, 47] },
  { name: 'A3', index: 2, start: 4352, count: 1536, kinds: [48, 79] },
  { name: 'A4', index: 3, start: 5888, count: 2304, kinds: [80, 127] },
  { name: 'A5', index: 4, start: 1536, count: 512, kinds: null },
  { name: 'B', index: 5, start: 0, count: 256, kinds: null },
  { name: 'C', index: 6, start: 256, count: 256, kinds: null },
  { name: 'D', index: 7, start: 512, count: 256, kinds: null },
  { name: 'E', index: 8, start: 768, count: 256, kinds: null },
];

const autotileKind = (id) => Math.floor((id - 2048) / 48);

// --- tile labels ------------------------------------------------------------

const labelCache = new Map();
function sheetLabels(name) {
  if (!name) return null;
  if (labelCache.has(name)) return labelCache.get(name);
  let lines = null;
  try {
    lines = fs
      .readFileSync(path.join(imgDir, `${name}.txt`), 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((l) => l.split('|')[0].trim());
  } catch {
    lines = null;
  }
  labelCache.set(name, lines);
  return lines;
}

/**
 * The editor's label for a tile id under a given tileset, or null.
 *
 * Autotile sheets label one line per kind; object sheets one line per tile id.
 */
function labelFor(tilesetNames, tileId) {
  for (const slot of SLOTS) {
    if (tileId < slot.start || tileId >= slot.start + slot.count) continue;
    const lines = sheetLabels(tilesetNames[slot.index]);
    if (!lines) return null;
    const line = slot.kinds
      ? lines[autotileKind(tileId) - slot.kinds[0]]
      : lines[tileId - slot.start];
    return line || null;
  }
  return null;
}

/** Every tile id of `sheet` whose label is exactly `label`. */
const setCache = new Map();
function idsWithLabel(sheetName, slot, label) {
  const key = `${sheetName}\u0000${label}`;
  if (setCache.has(key)) return setCache.get(key);
  const lines = sheetLabels(sheetName) ?? [];
  const ids = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === label) ids.push(slot.start + i);
  }
  setCache.set(key, ids);
  return ids;
}

const isRoofLabel = (l) => !!l && /^Roof /.test(l) && !/^Roof Detail/.test(l);

// --- helpers ----------------------------------------------------------------

function stats(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return {
    n: s.length,
    min: s[0],
    median: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    total: s.reduce((a, b) => a + b, 0),
  };
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0');

function histogram(values, buckets) {
  const out = buckets.map((b) => ({ b, n: 0 }));
  for (const v of values) {
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (v >= buckets[i]) {
        out[i].n++;
        break;
      }
    }
  }
  return out;
}

/** 4-connected components of cells for which `same(a, b)` holds. */
function components(width, height, keyAt) {
  const seen = new Uint8Array(width * height);
  const out = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (seen[i]) continue;
      const key = keyAt(x, y);
      if (key === null) continue;
      const cells = [];
      const stack = [[x, y]];
      seen[i] = 1;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        cells.push([cx, cy]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (seen[ni]) continue;
          if (keyAt(nx, ny) !== key) continue;
          seen[ni] = 1;
          stack.push([nx, ny]);
        }
      }
      out.push({ key, cells });
    }
  }
  return out;
}

function bbox(cells) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of cells) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// --- load -------------------------------------------------------------------

const tilesets = readJson(path.join(dataDir, 'Tilesets.json'));
if (!tilesets) {
  console.error(`No Tilesets.json under ${dataDir}`);
  process.exit(1);
}

const maps = [];
for (const file of fs.readdirSync(sampleDir)) {
  if (!file.endsWith('.json')) continue;
  const m = readJson(path.join(sampleDir, file));
  if (!m || !Array.isArray(m.data) || !m.width) continue;
  const ts = tilesets[m.tilesetId];
  if (!ts) continue;
  maps.push({ file, map: m, tileset: ts });
}

/** Material identity of a layer-0 tile: autotile kind, or the raw id. */
function materialAt(m, z, x, y) {
  const t = m.data[z * m.width * m.height + y * m.width + x];
  if (!t) return null;
  return t >= 2048 ? `k${autotileKind(t)}` : `t${t}`;
}

console.log(`# Map shape, measured over ${maps.length} sample maps\n`);

// ===========================================================================
// 1. How far does a material boundary run straight before it turns?
// ===========================================================================
//
// A boundary exists between two orthogonally adjacent cells of different
// material. It runs *straight* for as long as the same ordered pair of
// materials stays on the same two sides — the moment either side changes, the
// boundary has turned or ended.

const hRuns = [];
const vRuns = [];

for (const { map: m } of maps) {
  const mat = (x, y) => materialAt(m, 0, x, y);

  for (let y = 1; y < m.height; y++) {
    let run = 0;
    let pair = null;
    for (let x = 0; x < m.width; x++) {
      const a = mat(x, y - 1);
      const b = mat(x, y);
      const p = a !== b ? `${a}|${b}` : null;
      if (p !== null && p === pair) run++;
      else {
        if (run > 0) hRuns.push(run);
        run = p === null ? 0 : 1;
        pair = p;
      }
    }
    if (run > 0) hRuns.push(run);
  }

  for (let x = 1; x < m.width; x++) {
    let run = 0;
    let pair = null;
    for (let y = 0; y < m.height; y++) {
      const a = mat(x - 1, y);
      const b = mat(x, y);
      const p = a !== b ? `${a}|${b}` : null;
      if (p !== null && p === pair) run++;
      else {
        if (run > 0) vRuns.push(run);
        run = p === null ? 0 : 1;
        pair = p;
      }
    }
    if (run > 0) vRuns.push(run);
  }
}

const allRuns = [...hRuns, ...vRuns];
const runStats = stats(allRuns);

console.log('## 1. Straight material-boundary runs on layer 0\n');
console.log(`horizontal runs ${hRuns.length}, vertical runs ${vRuns.length}, total ${allRuns.length}`);
console.log(
  `length: median ${runStats.median}, mean ${runStats.mean.toFixed(2)}, ` +
    `p90 ${runStats.p90}, p99 ${runStats.p99}, max ${runStats.max}`
);
console.log('\nhow many runs are at least N long, and what share of all boundary length they carry:');
for (const n of [1, 2, 3, 4, 6, 8, 12, 16, 20, 30]) {
  const long = allRuns.filter((r) => r >= n);
  const carried = long.reduce((a, b) => a + b, 0);
  console.log(
    `  >= ${String(n).padStart(2)}: ${String(long.length).padStart(6)} runs ` +
      `(${pct(long.length, allRuns.length).padStart(5)}% of runs, ` +
      `${pct(carried, runStats.total).padStart(5)}% of boundary length)`
  );
}
console.log('\nrun-length histogram:');
for (const { b, n } of histogram(allRuns, [1, 2, 3, 4, 5, 6, 8, 10, 14, 20, 30])) {
  console.log(`  ${String(b).padStart(2)}+ : ${String(n).padStart(6)}  ${pct(n, allRuns.length)}%`);
}

// ===========================================================================
// 2. Roof footprints
// ===========================================================================
//
// A roof set occupies 5 sheet columns by 3 rows: the leftmost 3x3 is the
// nine-slice (ridge / middle / eave by row, left / middle / right by column) and
// columns 3-4 hold the inner-corner pieces an L-shape needs.
//
// A cell's *expected* nine-slice position follows from the silhouette: column 0
// where nothing is to its left, 2 where nothing is to its right, 1 between.
// A cell whose actual position disagrees is either a seam between two buildings
// that happen to share an edge and a roof material, or an inner corner.

let roofComponents = 0;
let roofRect = 0;
let roofNonRect = 0;
const roofSizes = [];
// P5-10: how much does a building's own size vary? A generated town gives every
// band the same height, so every block in it is the same height; this is the
// spread the corpus has instead.
const roofBoxW = [];
const roofBoxH = [];
const innerCornerCells = new Map();
const nonRectFill = [];
const roofByLayer = new Map();
const roofExamples = [];
// Nine-slice roofs cross-tabbed: a component with seam cells is two buildings
// that happen to share an edge and a roof material, so its silhouette says
// nothing about whether one roof is L-shaped.
const nineSlice = { rectClean: 0, rectSeam: 0, bentClean: 0, bentSeam: 0 };
const concave = { dedicated: 0, plain: 0 };
let autotileRoofs = 0;
let autotileRoofRect = 0;

for (const { file, map: m, tileset } of maps) {
  const N = m.width * m.height;
  // Layer 0 included: an A3 roof is an autotile and `place_building` paints it
  // on the ground layer, so leaving z0 out would report zero A3 roofs.
  for (const z of [0, 1, 2, 3]) {
    const at = (x, y) => m.data[z * N + y * m.width + x];

    const keyAt = (x, y) => {
      const t = at(x, y);
      if (!t) return null;
      const l = labelFor(tileset.tilesetNames, t);
      return isRoofLabel(l) ? l : null;
    };

    for (const { key, cells } of components(m.width, m.height, keyAt)) {
      if (cells.length < 4) continue; // a 1-3 tile scrap is not a roof footprint
      roofComponents++;
      roofSizes.push(cells.length);
      roofByLayer.set(z, (roofByLayer.get(z) ?? 0) + 1);

      const box = bbox(cells);
      roofBoxW.push(box.width);
      roofBoxH.push(box.height);
      const isRect = cells.length === box.width * box.height;
      if (isRect) roofRect++;
      else {
        roofNonRect++;
        nonRectFill.push(cells.length / (box.width * box.height));
      }

      // Which sheet cell does each map cell use, relative to the set's origin?
      const slot = SLOTS.find(
        (s) => at(cells[0][0], cells[0][1]) >= s.start &&
               at(cells[0][0], cells[0][1]) < s.start + s.count
      );
      if (!slot) continue;
      if (slot.kinds) {
        // An A3 roof is an autotile: the engine computes its shape from the
        // silhouette, so there are no nine-slice cells to check and no
        // inner-corner piece to choose. Only "is it a rectangle" applies.
        autotileRoofs++;
        if (isRect) autotileRoofRect++;
        continue;
      }

      const inComp = new Set(cells.map(([x, y]) => `${x},${y}`));
      const has = (x, y) => inComp.has(`${x},${y}`);

      // The set's origin is read off the roof itself rather than off the sheet:
      // the cell with nothing above it and nothing to its left is by definition
      // the nine-slice's top-left piece. Taking the minimum sheet column over
      // the label's tile ids does NOT work — the Snow set's inner corners wrap
      // onto the next row band, two columns to the *left* of its own origin.
      const origins = cells.filter(([x, y]) => !has(x - 1, y) && !has(x, y - 1));
      const originIds = new Set(origins.map(([x, y]) => at(x, y)));
      if (originIds.size !== 1) continue; // ambiguous: can't fix the set's origin
      const topLeftId = [...originIds][0];
      const c0 = sheetCol(topLeftId);
      const r0 = sheetRow(topLeftId);

      let seams = 0;
      for (const [x, y] of cells) {
        const id = at(x, y);
        const wantC = !has(x - 1, y) ? 0 : !has(x + 1, y) ? 2 : 1;
        const wantR = !has(x, y - 1) ? 0 : !has(x, y + 1) ? 2 : 1;
        if (sheetCol(id) - c0 === wantC && sheetRow(id) - r0 === wantR) continue;

        // Not the plain nine-slice piece this position calls for. A concave
        // corner — all four orthogonal neighbours present, a diagonal missing —
        // is where an inner-corner piece belongs; anything else is a seam
        // between two buildings that share an edge and a roof material.
        const allOrth = has(x - 1, y) && has(x + 1, y) && has(x, y - 1) && has(x, y + 1);
        const missing = [
          !has(x - 1, y - 1) && 'UL',
          !has(x + 1, y - 1) && 'UR',
          !has(x - 1, y + 1) && 'DL',
          !has(x + 1, y + 1) && 'DR',
        ].filter(Boolean);
        if (allOrth && missing.length > 0) {
          const dc = sheetCol(id) - c0;
          const dr = sheetRow(id) - r0;
          // A piece from outside the 3x3 is a dedicated inner-corner piece; one
          // from inside it is an ordinary edge tile the mapper reused.
          const dedicated = dc < 0 || dc > 2 || dr < 0 || dr > 2;
          if (dedicated) concave.dedicated++;
          else concave.plain++;
          const k =
            `missing ${missing.join('+')} -> ${dedicated ? 'inner-corner piece' : 'plain piece  '} ` +
            `at offset (${dc}, ${dr}), tile ${id}`;
          innerCornerCells.set(k, (innerCornerCells.get(k) ?? 0) + 1);
        } else seams++;
      }
      if (isRect) seams > 0 ? nineSlice.rectSeam++ : nineSlice.rectClean++;
      else seams > 0 ? nineSlice.bentSeam++ : nineSlice.bentClean++;
      if (!isRect && seams === 0 && roofExamples.length < 12) {
        roofExamples.push(
          `${file} z${z} ${key} — ${box.width}x${box.height} box, ${cells.length} tiles`
        );
      }
    }
  }
}

console.log('\n## 2. Roof footprints\n');
console.log(`roof components of 4+ tiles: ${roofComponents}`);
console.log(`  by layer: ${[...roofByLayer.entries()].sort().map(([z, n]) => `z${z} ${n}`).join(', ')}`);
const rs = stats(roofSizes);
console.log(`  size: median ${rs.median}, p90 ${rs.p90}, max ${rs.max} tiles`);
const rbw = stats(roofBoxW);
const rbh = stats(roofBoxH);
console.log(
  `  bounding box: width min ${rbw.min} median ${rbw.median} p90 ${rbw.p90} max ${rbw.max}; ` +
    `height min ${rbh.min} median ${rbh.median} p90 ${rbh.p90} max ${rbh.max}`
);
console.log(`  rectangular footprint:     ${roofRect}  ${pct(roofRect, roofComponents)}%`);
console.log(`  NOT rectangular:           ${roofNonRect}  ${pct(roofNonRect, roofComponents)}%`);
if (nonRectFill.length) {
  const f = stats(nonRectFill);
  console.log(
    `  non-rectangles fill ${(f.median * 100).toFixed(0)}% of their bounding box at the median, ` +
      `${(f.min * 100).toFixed(0)}% at the least`
  );
}

console.log('\nA3 autotile roofs (shape computed by the engine, no piece to choose):');
console.log(
  `  ${autotileRoofs} component(s), ${autotileRoofRect} rectangular ` +
    `(${pct(autotileRoofRect, autotileRoofs)}%)`
);

console.log('\nNine-slice (object-sheet) roofs, cross-tabbed against seams.');
console.log('A seam cell means the component is two buildings that share an edge and a roof');
console.log('material, so its outline says nothing about whether one roof is L-shaped:');
const nsTotal = nineSlice.rectClean + nineSlice.rectSeam + nineSlice.bentClean + nineSlice.bentSeam;
console.log(`  one coherent roof, rectangular:     ${nineSlice.rectClean}  ${pct(nineSlice.rectClean, nsTotal)}%`);
console.log(`  one coherent roof, NOT rectangular: ${nineSlice.bentClean}  ${pct(nineSlice.bentClean, nsTotal)}%`);
console.log(`  merged buildings, rectangular box:  ${nineSlice.rectSeam}  ${pct(nineSlice.rectSeam, nsTotal)}%`);
console.log(`  merged buildings, ragged box:       ${nineSlice.bentSeam}  ${pct(nineSlice.bentSeam, nsTotal)}%`);
const coherent = nineSlice.rectClean + nineSlice.bentClean;
console.log(
  `  => of the ${coherent} components that are one roof, ` +
    `${pct(nineSlice.bentClean, coherent)}% are not rectangles`
);

const concaveTotal = concave.dedicated + concave.plain;
console.log(`\nconcave corners across every sample roof: ${concaveTotal}`);
console.log(
  `  turned with the set's dedicated inner-corner piece: ${concave.dedicated}  ` +
    `${pct(concave.dedicated, concaveTotal)}%`
);
console.log(
  `  turned with an ordinary edge piece instead:         ${concave.plain}  ` +
    `${pct(concave.plain, concaveTotal)}%`
);
console.log('\nconcave corners, and the piece the mapper put there:');
if (innerCornerCells.size === 0) {
  console.log('  none — no sample roof turns a concave corner.');
} else {
  [...innerCornerCells.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`  ${k}: ${n}`));
}
if (roofExamples.length) {
  console.log('\ngenuinely non-rectangular single roofs (examples):');
  for (const e of roofExamples) console.log(`  ${e}`);
}

// ===========================================================================
// 3. Ground regions — streets and patches
// ===========================================================================

let groundRegions = 0;
let groundRect = 0;
const groundFill = [];
const groundRunWidths = [];
let regionsWithVaryingWidth = 0;
// Bucketed by area, because a 2x4 patch being a rectangle says nothing: a
// generator emits *large* rectangles, so that is the size band that matters.
const sizeBands = [
  { label: '   8-15', lo: 8, hi: 15, n: 0, rect: 0 },
  { label: '  16-31', lo: 16, hi: 31, n: 0, rect: 0 },
  { label: '  32-63', lo: 32, hi: 63, n: 0, rect: 0 },
  { label: ' 64-127', lo: 64, hi: 127, n: 0, rect: 0 },
  { label: '   128+', lo: 128, hi: Infinity, n: 0, rect: 0 },
];

for (const { map: m } of maps) {
  for (const { cells } of components(m.width, m.height, (x, y) => materialAt(m, 0, x, y))) {
    if (cells.length < 8) continue; // below this, "is it a rectangle" is not a real question
    groundRegions++;
    const box = bbox(cells);
    const area = box.width * box.height;
    const isRect = cells.length === area;
    if (isRect) groundRect++;
    groundFill.push(cells.length / area);

    const band = sizeBands.find((b) => cells.length >= b.lo && cells.length <= b.hi);
    if (band) {
      band.n++;
      if (isRect) band.rect++;
    }

    // Width profile: how many cells the region occupies in each of its rows.
    const perRow = new Map();
    for (const [, y] of cells) perRow.set(y, (perRow.get(y) ?? 0) + 1);
    const widths = [...perRow.values()];
    groundRunWidths.push(...widths);
    if (new Set(widths).size > 1) regionsWithVaryingWidth++;
  }
}

console.log('\n## 3. Ground regions on layer 0 (8+ tiles of one material)\n');
console.log(`regions: ${groundRegions}`);
console.log(`  exactly a rectangle: ${groundRect}  ${pct(groundRect, groundRegions)}%`);
console.log(`  width varies row to row: ${regionsWithVaryingWidth}  ${pct(regionsWithVaryingWidth, groundRegions)}%`);
const gf = stats(groundFill);
console.log(
  `  fill of bounding box: median ${(gf.median * 100).toFixed(0)}%, ` +
    `mean ${(gf.mean * 100).toFixed(0)}%, least ${(gf.min * 100).toFixed(0)}%`
);
const gw = stats(groundRunWidths);
console.log(`  per-row width: median ${gw.median}, p90 ${gw.p90}, max ${gw.max}`);
console.log('\n  rectangularity by region size — the band a generator actually emits is the big one:');
for (const b of sizeBands) {
  console.log(
    `    ${b.label} tiles: ${String(b.n).padStart(5)} regions, ` +
      `${String(b.rect).padStart(4)} rectangular  ${pct(b.rect, b.n).padStart(5)}%`
  );
}

// ===========================================================================
// 4. Interior rooms
// ===========================================================================
//
// An interior map is one whose A4 slot names an "Inside" sheet — A4 is the wall
// family, and it is what makes a room a room. The floor is then the layer-0
// material that is not a wall.

let interiorMaps = 0;
let interiorRegions = 0;
let interiorRect = 0;
const interiorFill = [];

for (const { map: m, tileset } of maps) {
  const a4 = tileset.tilesetNames[3] ?? '';
  const a5 = tileset.tilesetNames[4] ?? '';
  if (!/Inside/i.test(a4) && !/Inside/i.test(a5)) continue;
  interiorMaps++;

  for (const { key, cells } of components(m.width, m.height, (x, y) => materialAt(m, 0, x, y))) {
    if (cells.length < 8) continue;
    // Skip walls: A4 kinds are 80-127.
    if (key.startsWith('k')) {
      const kind = Number(key.slice(1));
      if (kind >= 80) continue;
    }
    interiorRegions++;
    const box = bbox(cells);
    const area = box.width * box.height;
    if (cells.length === area) interiorRect++;
    interiorFill.push(cells.length / area);
  }
}

console.log('\n## 4. Interior rooms\n');
console.log(`maps on an Inside tileset: ${interiorMaps}`);
console.log(`floor regions of 8+ tiles: ${interiorRegions}`);
console.log(`  exactly a rectangle: ${interiorRect}  ${pct(interiorRect, interiorRegions)}%`);
if (interiorFill.length) {
  const f = stats(interiorFill);
  console.log(
    `  fill of bounding box: median ${(f.median * 100).toFixed(0)}%, ` +
      `mean ${(f.mean * 100).toFixed(0)}%`
  );
}
