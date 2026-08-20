// Generates src/core/a1-catalogue.ts from the tile-name files the editor ships.
//
//   node scripts/build-a1-catalogue.mjs [tilesetsDir] [outFile]
//
// An A1 sheet's `.txt` holds **one line per autotile kind**, not one per tile id
// — the autotile sheets are labelled by material, so the file is 16 lines long.
// As with the prop catalogue, projects do not ship these files, only the
// editor's `newdata` folder does, so the result is generated here and committed.
//
// The point of having the names at all is that A1 is the one sheet where the
// engine's behaviour and the editor's label can disagree. `Tilemap.isWaterfallTile`
// is arithmetic on the tile id — kind 4 and up, odd — so the *slot* decides
// which shape table a kind takes, whatever the art shows. `World_A1` kind 15 is
// called "Cloud" and is drawn with the waterfall table. A caller who picks a
// kind by name and gets four shapes instead of 48 has been misled, so
// describe_tileset_materials pairs the two and says when they diverge.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIR =
  'M:/SteamLibrary/steamapps/common/RPG Maker MZ/newdata/img/tilesets';

const tilesetsDir = process.argv[2] ?? DEFAULT_DIR;
const outFile =
  process.argv[3] ?? path.join(import.meta.dirname, '..', 'src', 'core', 'a1-catalogue.ts');

const KINDS_PER_SHEET = 16;
const isWaterfallKind = (kind) => kind >= 4 && kind % 2 === 1;

const sheets = {};
let disagreements = 0;
let waterfallSlots = 0;

for (const file of fs.readdirSync(tilesetsDir).sort()) {
  if (!/_A1\.txt$/i.test(file)) continue;
  const name = file.replace(/\.txt$/i, '');
  const lines = fs
    .readFileSync(path.join(tilesetsDir, file), 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.split('|')[0].trim())
    .filter((line) => line.length > 0);

  if (lines.length !== KINDS_PER_SHEET) {
    console.error(`  ! ${name}: ${lines.length} labels, expected ${KINDS_PER_SHEET} — skipped`);
    continue;
  }
  sheets[name] = lines;

  for (let kind = 0; kind < KINDS_PER_SHEET; kind++) {
    if (!isWaterfallKind(kind)) continue;
    waterfallSlots++;
    if (!/waterfall|fall\b/i.test(lines[kind])) disagreements++;
  }
}

const body = Object.entries(sheets)
  .map(
    ([name, labels]) =>
      `  ${JSON.stringify(name)}: [\n` +
      labels.map((l) => `    ${JSON.stringify(l)},`).join('\n') +
      '\n  ],'
  )
  .join('\n');

const out = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node scripts/build-a1-catalogue.mjs [tilesetsDir]
//
// Source: the \`.txt\` file RPG Maker MZ ships beside each tileset PNG. On the
// autotile sheets it holds one line per *kind* rather than per tile id, so an A1
// file is 16 lines. Projects do not ship those files, so the labels are baked in.
//
// These are names only. What the engine *does* with a kind comes from its slot —
// see describeA1Kind in water-autotile.ts — and the two disagree often enough to
// be worth reporting: of the ${waterfallSlots} waterfall slots across these sheets,
// ${disagreements} carry a label that does not say "waterfall".

/** The editor's label for each of the 16 A1 kinds, indexed by kind. */
export const A1_SHEET_LABELS: Record<string, string[]> = {
${body}
};

/** The editor's name for a kind on a named A1 sheet, or null if it is not one we have. */
export function a1KindLabel(sheetName: string, kind: number): string | null {
  const labels = A1_SHEET_LABELS[sheetName];
  if (!labels || kind < 0 || kind >= labels.length) return null;
  return labels[kind];
}
`;

fs.writeFileSync(outFile, out);
console.log(`${Object.keys(sheets).length} A1 sheet(s) -> ${outFile}`);
console.log(
  `waterfall slots: ${waterfallSlots}; labelled "waterfall": ${waterfallSlots - disagreements}; ` +
    `not: ${disagreements}`
);
