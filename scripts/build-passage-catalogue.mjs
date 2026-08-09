// Builds src/core/passage-catalogue.ts from the configured tilesets RPG Maker MZ
// ships, so a project whose tileset was never set up can be given real passage
// flags without opening the editor.
//
//   node scripts/build-passage-catalogue.mjs [editorDir] [moreDirs...]
//
// Why this works: passage flags turn out to be a property of the *sheet*, not of
// the tileset that uses it. Across 54 configured tilesets from 5 independent
// databases, 58 of 62 sheet+slot combinations carry byte-identical flags
// everywhere they appear. The 4 that do not are recorded as disagreements below
// rather than hidden — see the header the generator writes.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_EDITOR = 'C:/Program Files (x86)/Steam/steamapps/common/RPG Maker MZ';
const args = process.argv.slice(2);
const editorDirs = args.length > 0 ? args : [DEFAULT_EDITOR];

/** Slot index -> [name, first tile id, tile count]. Matches tilesetNames order. */
const SLOTS = [
  ['A1', 2048, 768],
  ['A2', 2816, 1536],
  ['A3', 4352, 1536],
  ['A4', 5888, 2304],
  ['A5', 1536, 512],
  ['B', 0, 256],
  ['C', 256, 256],
  ['D', 512, 256],
  ['E', 768, 256],
];

const FLAG_STAR = 0x10;

// --- find every reference database ------------------------------------------

const sources = [];
for (const editorDir of editorDirs) {
  if (!fs.existsSync(editorDir)) {
    console.error(`skipping missing directory: ${editorDir}`);
    continue;
  }
  const stack = [editorDir];
  const seen = new Set();
  while (stack.length > 0) {
    const dir = stack.pop();
    if (seen.has(dir)) continue;
    seen.add(dir);

    const candidate = path.join(dir, 'data', 'Tilesets.json');
    if (fs.existsSync(candidate)) sources.push(candidate);

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // The lang/ trees are translations of the same database; they would only
      // inflate the agreement counts with copies of what is already counted.
      if (e.name === 'lang' || e.name === 'node_modules') continue;
      if (seen.size > 400) break;
      stack.push(path.join(dir, e.name));
    }
  }
}

if (sources.length === 0) {
  console.error('No Tilesets.json found. Pass the RPG Maker MZ install directory.');
  process.exit(1);
}

/**
 * Which database to believe when two disagree.
 *
 * `newdata` is what the editor writes when you create a new project, so it *is*
 * the default configuration by definition. Everything else is a sample or a
 * third-party project whose author may have tweaked things — and one does: the
 * Card Game Combat demo ships a Dungeon tileset differing from the editor's on
 * 96 tiles, and it sorts first alphabetically, so plain sort order would have
 * taught the outlier over the default.
 */
function authority(file) {
  const normalized = file.replace(/\\/g, '/');
  if (/\/newdata(-\d+)?\/data\//.test(normalized)) return 0;
  if (/RemakeMapResourcePack/.test(normalized)) return 1;
  return 2;
}
sources.sort((a, b) => authority(a) - authority(b) || a.localeCompare(b));
console.log(`reading ${sources.length} reference database(s); ` +
  `${sources.filter((s) => authority(s) === 0).length} from the editor's own template`);

// --- collect, first writer wins ---------------------------------------------

/** sheet name -> { slot, values: number[], sources: string[], conflicts: number } */
const catalogue = new Map();
let configured = 0;
let skipped = 0;

for (const file of sources) {
  let tilesets;
  try {
    tilesets = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  if (!Array.isArray(tilesets)) continue;

  // Lowest tileset id first, so where one database defines a sheet twice the
  // eponymous tileset wins: "Inside" (3) is a better source for Inside_A1 than
  // "SF Inside" (6), which merely borrows the sheet.
  for (const ts of [...tilesets].sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0))) {
    if (!ts || !Array.isArray(ts.flags) || ts.flags.length < 8192) continue;
    // Only learn from tilesets the editor actually configured. Without the star
    // bit on tile 0 the whole array is the unconfigured default and would teach
    // exactly the bug this catalogue exists to fix.
    if ((ts.flags[0] & FLAG_STAR) === 0) { skipped++; continue; }
    configured++;

    for (let slot = 0; slot < SLOTS.length; slot++) {
      const [slotName, start, count] = SLOTS[slot];
      const sheet = ts.tilesetNames?.[slot];
      if (!sheet) continue;

      const values = ts.flags.slice(start, start + count);
      const existing = catalogue.get(sheet);
      if (!existing) {
        catalogue.set(sheet, {
          slot: slotName, values, sources: [ts.name], conflicts: 0,
          from: `${path.basename(path.dirname(path.dirname(file)))}/${ts.name}`,
        });
        continue;
      }
      if (existing.slot !== slotName) {
        console.warn(`  ${sheet}: used in slot ${existing.slot} and ${slotName}; keeping ${existing.slot}`);
        continue;
      }
      let differing = 0;
      for (let i = 0; i < count; i++) if (existing.values[i] !== values[i]) differing++;
      if (differing > 0) existing.conflicts = Math.max(existing.conflicts, differing);
      if (!existing.sources.includes(ts.name)) existing.sources.push(ts.name);
    }
  }
}

console.log(`learned from ${configured} configured tileset(s); skipped ${skipped} unconfigured`);

// --- run-length encode -------------------------------------------------------

function encode(values) {
  const runs = [];
  let i = 0;
  while (i < values.length) {
    let j = i;
    while (j < values.length && values[j] === values[i]) j++;
    runs.push([values[i], j - i]);
    i = j;
  }
  return runs;
}

const names = [...catalogue.keys()].sort();
let rawTotal = 0;
let runTotal = 0;
const conflicted = [];

const body = names.map((name) => {
  const entry = catalogue.get(name);
  const runs = encode(entry.values);
  rawTotal += entry.values.length;
  runTotal += runs.length;
  if (entry.conflicts > 0) {
    conflicted.push(`${name}: ${entry.conflicts} tile(s) differ elsewhere; took ${entry.from}`);
  }

  const pairs = runs.map(([v, n]) => `[${v},${n}]`).join(',');
  return `  ${JSON.stringify(name)}: { slot: ${JSON.stringify(entry.slot)}, runs: [${pairs}] },`;
}).join('\n');

const header = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/build-passage-catalogue.mjs [editorDir]
//
// Passage flags for the tileset sheets RPG Maker MZ ships, taken from the
// tilesets the editor itself has configured. Nothing in the server can invent
// these: which materials are solid is authored art direction, not something
// derivable from the image.
//
// **Flags are a property of the sheet, not of the tileset that uses it.** That
// is what makes this catalogue possible, and it was measured rather than
// assumed: across ${configured} configured tilesets from ${sources.length} database(s), ${names.length - conflicted.length}
// of ${names.length} sheets carry identical flags everywhere they appear.
//
// ${conflicted.length} sheet(s) are configured differently somewhere. For those the editor's own
// new-project template wins, then the official sample packs, then anything else;
// and within one database the lowest tileset id, so a sheet is taken from the
// tileset it is named after rather than one that merely borrows it:
${conflicted.length === 0 ? '//   (none)' : conflicted.map((c) => `//   - ${c}`).join('\n')}
//
// Values are run-length encoded as [flag, repeatCount] over the sheet's tile
// range, which is ${(runTotal / rawTotal * 100).toFixed(1)}% the size of the raw arrays (${runTotal} runs for
// ${rawTotal} tiles) — flags repeat across all 48 shapes of an autotile material.

export interface SheetPassage {
  /** Which tileset slot this sheet was catalogued in. */
  slot: string;
  /** [flag, repeatCount] pairs covering the slot's tile range in order. */
  runs: [number, number][];
}

export const PASSAGE_SHEETS: Record<string, SheetPassage> = {
${body}
};
`;

const out = path.join(process.cwd(), 'src', 'core', 'passage-catalogue.ts');
fs.writeFileSync(out, header);
console.log(`wrote ${out}`);
console.log(`  ${names.length} sheets, ${runTotal} runs for ${rawTotal} tiles (${(runTotal / rawTotal * 100).toFixed(1)}%)`);
if (conflicted.length > 0) {
  console.log('  disagreements recorded:');
  for (const c of conflicted) console.log(`    ${c}`);
}
