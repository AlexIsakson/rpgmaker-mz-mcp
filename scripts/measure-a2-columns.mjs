// Reports how well a *column* of the A2 sheet predicts what a material actually
// is, by running src/core/tileset-image.ts's classifier over every A2 sheet the
// RTP ships and cross-referencing the editor's own tile-label .txt files.
//
//   npm run build && node scripts/measure-a2-columns.mjs [editorDir] [moreDirs...]
//
// This exists because the repo used to carry a column rule in prose — "columns
// 1-4 are patch materials with visible outlines" — and a caller who followed it
// painted a transparent overlay on layer 0, which the engine draws as black.
// The rule is not merely off by one: no column is opaque-and-outlined in all
// four sheets, so no column rule can be right. Run this before writing any
// sentence of the form "column N is ...".
//
// Unlike build-passage-catalogue.mjs this generates nothing. The output is the
// evidence for a paragraph in ROADMAP.md, and re-running it is how that
// paragraph gets rechecked.

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { classifyA2Sheet } from '../dist/core/tileset-image.js';

const DEFAULT_DIRS = [
  'C:/Program Files (x86)/Steam/steamapps/common/RPG Maker MZ/newdata/img/tilesets',
  'M:/SteamLibrary/steamapps/common/RPG Maker MZ/newdata/img/tilesets',
];

const args = process.argv.slice(2);
const dirs = args.length > 0 ? args : DEFAULT_DIRS;

/** sheet name -> classified rows, first directory that has the sheet wins */
const sheets = new Map();

for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir)) {
    if (!/_A2\.png$/i.test(file)) continue;
    const name = file.replace(/\.png$/i, '');
    if (sheets.has(name)) continue;

    let png;
    try {
      png = PNG.sync.read(fs.readFileSync(path.join(dir, file)));
    } catch {
      continue;
    }

    // The editor ships a .txt beside each sheet: one "English|Japanese" line per
    // kind in row-major order. It is what the material is *called*, which is the
    // only way to say out loud that A2 kind 20 is a bush rather than a floor.
    let labels = [];
    const txt = path.join(dir, `${name}.txt`);
    if (fs.existsSync(txt)) {
      labels = fs.readFileSync(txt, 'utf8')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((line) => line.split('|')[0].trim());
    }

    sheets.set(
      name,
      classifyA2Sheet(png).map((m) => ({ ...m, label: labels[m.row * 8 + m.column] ?? '' }))
    );
  }
}

if (sheets.size === 0) {
  console.error(`No *_A2.png found. Tried:\n${dirs.map((d) => `  ${d}`).join('\n')}`);
  console.error('Pass one or more img/tilesets directories.');
  process.exit(1);
}

const names = [...sheets.keys()].sort();
const all = names.flatMap((n) => sheets.get(n).map((m) => ({ ...m, sheet: n })));
console.log(`${names.length} A2 sheet(s), ${all.length} kinds: ${names.join(', ')}\n`);

// --- per column --------------------------------------------------------------

const pad = (v, n) => String(v).padStart(n);

console.log('column   ground  overlay  empty   | of the ground ones: outlined  seamless');
for (let col = 0; col < 8; col++) {
  const cells = all.filter((m) => m.column === col);
  const ground = cells.filter((m) => m.opacity === 'ground');
  console.log(
    `${pad(col, 6)}   ${pad(ground.length, 6)}  ` +
    `${pad(cells.filter((m) => m.opacity === 'overlay').length, 7)}  ` +
    `${pad(cells.filter((m) => m.opacity === 'empty').length, 5)}   | ` +
    `${pad(ground.filter((m) => m.outline === 'outlined').length, 27)}  ` +
    `${pad(ground.filter((m) => m.outline === 'seamless').length, 8)}`
  );
}

// --- the question a caller actually asks -------------------------------------
//
// "Which column can I paint on layer 0 and see an edge?" — the answer has to
// hold for every row of the sheet, or it is not a rule about the column.

const safe = (m) => m.opacity === 'ground' && m.outline === 'outlined';

console.log('\nColumns that are opaque *and* outlined in every row of the sheet:');
const perSheet = [];
for (const name of names) {
  const rows = sheets.get(name);
  const cols = [];
  for (let col = 0; col < 8; col++) {
    const cells = rows.filter((m) => m.column === col);
    if (cells.length > 0 && cells.every(safe)) cols.push(col);
  }
  perSheet.push(cols);
  console.log(`  ${name.padEnd(14)} ${cols.join(', ') || 'none'}`);
}

const universal = perSheet.reduce((a, b) => a.filter((c) => b.includes(c)), perSheet[0] ?? []);
console.log(
  `\n  Safe in every sheet: ${universal.join(', ') || 'NONE'} — ` +
  `${universal.length === 0 ? 'so no column rule holds. Call describe_tileset_materials.' : 'check this before trusting it.'}`
);

// --- what the misconception cost, named --------------------------------------

const misled = all.filter((m) => m.column >= 1 && m.column <= 4 && !safe(m));
console.log(
  `\n"Columns 1-4 are patch materials with visible outlines" is wrong for ` +
  `${misled.length} of ${all.filter((m) => m.column >= 1 && m.column <= 4).length} kinds in columns 1-4. Examples:`
);
for (const m of misled.slice(0, 12)) {
  console.log(
    `  ${m.sheet.padEnd(12)} kind ${pad(m.kind, 2)} col ${m.column}  ` +
    `${m.opacity.padEnd(8)} ${m.outline.padEnd(9)} ${m.label}`
  );
}
if (misled.length > 12) console.log(`  ... and ${misled.length - 12} more`);
