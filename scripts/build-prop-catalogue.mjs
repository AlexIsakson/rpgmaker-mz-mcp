// Generates src/core/prop-catalogue.ts from the tile-name files the editor ships.
//
//   node scripts/build-prop-catalogue.mjs [tilesetsDir] [outFile]
//
// RPG Maker MZ ships a `.txt` beside every tileset PNG holding one line per tile
// id, `English|Japanese` — the editor's own label for that tile. That is ground
// truth for what each object tile *is*, and it is the only place it exists:
// **projects do not ship these files**, only the editor's `newdata` folder does.
// So the catalogue is generated here and committed, rather than read at runtime.
//
// A prop is a connected run of tiles sharing a label. Tiles are laid out on the
// sheet by Tilemap._addNormalTile's source rect — 16 columns read as two 8-wide
// halves — so adjacency has to be computed in that space, not in tile-id order.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIR =
  'C:/Program Files (x86)/Steam/steamapps/common/RPG Maker MZ/newdata/img/tilesets';

const tilesetsDir = process.argv[2] ?? DEFAULT_DIR;
const outFile =
  process.argv[3] ?? path.join(import.meta.dirname, '..', 'src', 'core', 'prop-catalogue.ts');

const TILES_PER_SHEET = 256;
const SHEET_COLUMNS = 16;
const SHEET_ROWS = 16;

const sheetColumn = (id) => (Math.floor(id / 128) % 2) * 8 + (id % 8);
const sheetRow = (id) => Math.floor((id % TILES_PER_SHEET) / 8) % SHEET_ROWS;

/** grid[row][col] -> sheet-local tile id */
const grid = Array.from({ length: SHEET_ROWS }, () => Array(SHEET_COLUMNS).fill(-1));
for (let id = 0; id < TILES_PER_SHEET; id++) grid[sheetRow(id)][sheetColumn(id)] = id;

function readNames(file) {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.split('|')[0].trim());
}

function groupSheet(names) {
  const seen = new Set();
  const props = [];

  for (let r = 0; r < SHEET_ROWS; r++) {
    for (let c = 0; c < SHEET_COLUMNS; c++) {
      const id = grid[r][c];
      if (seen.has(id)) continue;
      seen.add(id);

      const name = names[id];
      // Tile 0 of every sheet is the empty slot, and unlabelled tiles are unused.
      if (!name || name === 'Transparent') continue;

      const stack = [[r, c]];
      const cells = [];
      while (stack.length > 0) {
        const [cr, cc] = stack.pop();
        cells.push([cr, cc]);
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nr = cr + dr;
          const nc = cc + dc;
          if (nr < 0 || nc < 0 || nr >= SHEET_ROWS || nc >= SHEET_COLUMNS) continue;
          const nid = grid[nr][nc];
          if (seen.has(nid) || names[nid] !== name) continue;
          seen.add(nid);
          stack.push([nr, nc]);
        }
      }

      const rows = cells.map(([cr]) => cr);
      const cols = cells.map(([, cc]) => cc);
      const r0 = Math.min(...rows);
      const c0 = Math.min(...cols);
      const width = Math.max(...cols) - c0 + 1;
      const height = Math.max(...rows) - r0 + 1;

      // No prop straddles the boundary between the sheet's two halves, so
      // `topLeft + row * 8 + col` reaches every cell — asserted below rather
      // than assumed, because a silent wrap would address the wrong art.
      const topLeft = grid[r0][c0];
      for (const [cr, cc] of cells) {
        if (topLeft + (cr - r0) * 8 + (cc - c0) !== grid[cr][cc]) {
          throw new Error(`${name}: cells are not reachable from topLeft ${topLeft}`);
        }
      }

      let mask = null;
      if (cells.length !== width * height) {
        const present = new Set(cells.map(([cr, cc]) => (cr - r0) * width + (cc - c0)));
        mask = Array.from({ length: width * height }, (_, i) => (present.has(i) ? '1' : '0')).join('');
      }

      props.push({ name, topLeft, width, height, mask });
    }
  }

  return props;
}

const sheets = fs
  .readdirSync(tilesetsDir)
  .filter((f) => /_[BCDE]\.txt$/.test(f))
  .map((f) => f.replace(/\.txt$/, ''))
  .sort();

if (sheets.length === 0) {
  console.error(`No object-sheet name files found in ${tilesetsDir}`);
  process.exit(1);
}

const lines = [
  '// GENERATED FILE — do not edit by hand.',
  '// Regenerate with: node scripts/build-prop-catalogue.mjs [tilesetsDir]',
  '//',
  "// Source: the `.txt` file RPG Maker MZ ships beside each tileset PNG, which",
  '// holds the editor\'s own label for every tile. Projects do not ship those',
  '// files, so the catalogue is baked in here.',
  '//',
  '// Each entry is [name, topLeftTileId, width, height, mask?]. Tile ids are',
  '// sheet-local (0-255); a tileset\'s slot for the sheet decides the offset',
  '// (B +0, C +256, D +512, E +768). Cell (row, col) of a prop is',
  '// `topLeft + row * 8 + col`. `mask` is present only when the prop does not',
  '// fill its bounding box, and lists cells row-major as 1 (present) or 0.',
  '',
  'export type PropEntry = [string, number, number, number] | [string, number, number, number, string];',
  '',
  'export const PROP_SHEETS: Record<string, PropEntry[]> = {',
];

let total = 0;
for (const sheet of sheets) {
  const props = groupSheet(readNames(path.join(tilesetsDir, `${sheet}.txt`)));
  total += props.length;
  lines.push(`  ${JSON.stringify(sheet)}: [`);
  for (const p of props) {
    const tuple = [JSON.stringify(p.name), p.topLeft, p.width, p.height];
    if (p.mask) tuple.push(JSON.stringify(p.mask));
    lines.push(`    [${tuple.join(', ')}],`);
  }
  lines.push('  ],');
}
lines.push('};', '');

fs.writeFileSync(outFile, lines.join('\n'));
console.log(`Wrote ${total} props across ${sheets.length} sheets to ${outFile}`);
