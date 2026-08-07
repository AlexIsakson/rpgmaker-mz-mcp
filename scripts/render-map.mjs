// Renders an RPG Maker MZ map to a PNG, following rmmz_core.js Tilemap exactly.
// The autotile tables are parsed out of the project's own rmmz_core.js rather
// than copied, so the render is ground truth for what the editor/engine shows.
//
//   node scripts/render-map.mjs <projectDir> <mapId> <outPng> [--scale=1] [--events] [--grid]

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const [projectDir, mapIdArg, outPng, ...argv] = process.argv.slice(2);
const mapId = Number(mapIdArg);
const scale = Number((argv.find((f) => f.startsWith('--scale=')) ?? '--scale=1').split('=')[1]);
const showEvents = argv.includes('--events');
const showGrid = argv.includes('--grid');

const TILE = 48;

// --- engine constants, read from the corescript ------------------------------

const core = fs.readFileSync(path.join(projectDir, 'js', 'rmmz_core.js'), 'utf-8');

function parseTable(name) {
  const start = core.indexOf(`Tilemap.${name} = [`);
  if (start < 0) throw new Error(`${name} not found in rmmz_core.js`);
  const open = core.indexOf('[', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < core.length; i++) {
    if (core[i] === '[') depth++;
    else if (core[i] === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = core.slice(open, end + 1).replace(/\/\/[^\n]*/g, '');
  return JSON.parse(body.replace(/,\s*]/g, ']'));
}

const FLOOR_AUTOTILE_TABLE = parseTable('FLOOR_AUTOTILE_TABLE');
const WALL_AUTOTILE_TABLE = parseTable('WALL_AUTOTILE_TABLE');
const WATERFALL_AUTOTILE_TABLE = parseTable('WATERFALL_AUTOTILE_TABLE');

const TILE_ID_A5 = 1536;
const TILE_ID_A1 = 2048;
const TILE_ID_A2 = 2816;
const TILE_ID_A3 = 4352;
const TILE_ID_A4 = 5888;
const TILE_ID_MAX = 8192;

const isVisibleTile = (id) => id > 0 && id < TILE_ID_MAX;
const isAutotile = (id) => id >= TILE_ID_A1;
const isTileA1 = (id) => id >= TILE_ID_A1 && id < TILE_ID_A2;
const isTileA2 = (id) => id >= TILE_ID_A2 && id < TILE_ID_A3;
const isTileA3 = (id) => id >= TILE_ID_A3 && id < TILE_ID_A4;
const isTileA4 = (id) => id >= TILE_ID_A4 && id < TILE_ID_MAX;
const isTileA5 = (id) => id >= TILE_ID_A5 && id < TILE_ID_A1;
const getAutotileKind = (id) => Math.floor((id - TILE_ID_A1) / 48);
const getAutotileShape = (id) => (id - TILE_ID_A1) % 48;

// --- image helpers -----------------------------------------------------------

function loadPng(file) {
  if (!file) return null;
  const p = path.join(projectDir, 'img', 'tilesets', `${file}.png`);
  if (!fs.existsSync(p)) return null;
  return PNG.sync.read(fs.readFileSync(p));
}

/** Source-over blit with alpha, clipped on both sides. */
function blt(dst, src, sx, sy, sw, sh, dx, dy) {
  if (!src) return;
  for (let y = 0; y < sh; y++) {
    const syy = sy + y;
    const dyy = dy + y;
    if (syy < 0 || syy >= src.height || dyy < 0 || dyy >= dst.height) continue;
    for (let x = 0; x < sw; x++) {
      const sxx = sx + x;
      const dxx = dx + x;
      if (sxx < 0 || sxx >= src.width || dxx < 0 || dxx >= dst.width) continue;
      const si = (syy * src.width + sxx) * 4;
      const di = (dyy * dst.width + dxx) * 4;
      const a = src.data[si + 3] / 255;
      if (a === 0) continue;
      if (a === 1) {
        dst.data[di] = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = 255;
      } else {
        for (let c = 0; c < 3; c++) {
          dst.data[di + c] = Math.round(src.data[si + c] * a + dst.data[di + c] * (1 - a));
        }
        dst.data[di + 3] = Math.min(255, Math.round(a * 255 + dst.data[di + 3] * (1 - a)));
      }
    }
  }
}

function fillRectPx(dst, x0, y0, w, h, [r, g, b, a]) {
  const al = a / 255;
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0 || y >= dst.height) continue;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= dst.width) continue;
      const di = (y * dst.width + x) * 4;
      dst.data[di] = Math.round(r * al + dst.data[di] * (1 - al));
      dst.data[di + 1] = Math.round(g * al + dst.data[di + 1] * (1 - al));
      dst.data[di + 2] = Math.round(b * al + dst.data[di + 2] * (1 - al));
      dst.data[di + 3] = 255;
    }
  }
}

// --- project data ------------------------------------------------------------

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(projectDir, 'data', f), 'utf-8'));

const mapFile = `Map${String(mapId).padStart(3, '0')}.json`;
const map = readJson(mapFile);
const tilesets = readJson('Tilesets.json');
const tileset = tilesets[map.tilesetId];
if (!tileset) throw new Error(`Map ${mapId} uses tileset ${map.tilesetId}, which does not exist.`);

const sheets = tileset.tilesetNames.map(loadPng);
const flags = tileset.flags ?? [];

const { width, height, data } = map;
const readMapData = (x, y, z) =>
  x >= 0 && x < width && y >= 0 && y < height ? data[(z * height + y) * width + x] || 0 : 0;

const isTableTile = (id) => isTileA2(id) && (flags[id] & 0x80);

// --- tile drawing ------------------------------------------------------------

const out = new PNG({ width: width * TILE, height: height * TILE });
out.data.fill(0);

function drawNormalTile(tileId, dx, dy) {
  const setNumber = isTileA5(tileId) ? 4 : 5 + Math.floor(tileId / 256);
  const sx = ((Math.floor(tileId / 128) % 2) * 8 + (tileId % 8)) * TILE;
  const sy = (Math.floor((tileId % 256) / 8) % 16) * TILE;
  blt(out, sheets[setNumber], sx, sy, TILE, TILE, dx, dy);
}

function drawAutotile(tileId, dx, dy) {
  const kind = getAutotileKind(tileId);
  const shape = getAutotileShape(tileId);
  const tx = kind % 8;
  const ty = Math.floor(kind / 8);
  let setNumber = 0;
  let bx = 0;
  let by = 0;
  let table = FLOOR_AUTOTILE_TABLE;
  let isTable = false;

  if (isTileA1(tileId)) {
    const waterSurfaceIndex = 0; // static render: animation frame 0
    setNumber = 0;
    if (kind === 0) { bx = 0; by = 0; }
    else if (kind === 1) { bx = 0; by = 3; }
    else if (kind === 2) { bx = 6; by = 0; }
    else if (kind === 3) { bx = 6; by = 3; }
    else {
      bx = Math.floor(tx / 4) * 8;
      by = ty * 6 + (Math.floor(tx / 2) % 2) * 3;
      if (kind % 2 === 0) bx += waterSurfaceIndex * 2;
      else { bx += 6; table = WATERFALL_AUTOTILE_TABLE; }
    }
  } else if (isTileA2(tileId)) {
    setNumber = 1;
    bx = tx * 2;
    by = (ty - 2) * 3;
    isTable = !!isTableTile(tileId);
  } else if (isTileA3(tileId)) {
    setNumber = 2;
    bx = tx * 2;
    by = (ty - 6) * 2;
    table = WALL_AUTOTILE_TABLE;
  } else if (isTileA4(tileId)) {
    setNumber = 3;
    bx = tx * 2;
    by = Math.floor((ty - 10) * 2.5 + (ty % 2 === 1 ? 0.5 : 0));
    if (ty % 2 === 1) table = WALL_AUTOTILE_TABLE;
  }

  const quads = table[shape];
  const w1 = TILE / 2;
  const h1 = TILE / 2;
  for (let i = 0; i < 4; i++) {
    const qsx = quads[i][0];
    const qsy = quads[i][1];
    const sx1 = (bx * 2 + qsx) * w1;
    const sy1 = (by * 2 + qsy) * h1;
    const dx1 = dx + (i % 2) * w1;
    const dy1 = dy + Math.floor(i / 2) * h1;
    if (isTable && (qsy === 1 || qsy === 5)) {
      const qsx2 = qsy === 1 ? (4 - qsx) % 4 : qsx;
      const sx2 = (bx * 2 + qsx2) * w1;
      const sy2 = (by * 2 + 3) * h1;
      blt(out, sheets[setNumber], sx2, sy2, w1, h1, dx1, dy1);
      blt(out, sheets[setNumber], sx1, sy1, w1, h1 / 2, dx1, dy1 + h1 / 2);
    } else {
      blt(out, sheets[setNumber], sx1, sy1, w1, h1, dx1, dy1);
    }
  }
}

function drawTile(tileId, dx, dy) {
  if (!isVisibleTile(tileId)) return;
  if (isAutotile(tileId)) drawAutotile(tileId, dx, dy);
  else drawNormalTile(tileId, dx, dy);
}

function drawTableEdge(tileId, dx, dy) {
  if (!isTileA2(tileId)) return;
  const kind = getAutotileKind(tileId);
  const shape = getAutotileShape(tileId);
  const bx = (kind % 8) * 2;
  const by = (Math.floor(kind / 8) - 2) * 3;
  const quads = FLOOR_AUTOTILE_TABLE[shape];
  const w1 = TILE / 2;
  const h1 = TILE / 2;
  for (let i = 0; i < 2; i++) {
    const [qsx, qsy] = quads[2 + i];
    blt(out, sheets[1], (bx * 2 + qsx) * w1, (by * 2 + qsy) * h1 + h1 / 2, w1, h1 / 2,
        dx + (i % 2) * w1, dy + Math.floor(i / 2) * h1);
  }
}

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const dx = x * TILE;
    const dy = y * TILE;
    const t0 = readMapData(x, y, 0);
    const t1 = readMapData(x, y, 1);
    drawTile(t0, dx, dy);
    drawTile(t1, dx, dy);

    const shadowBits = readMapData(x, y, 4);
    if (shadowBits & 0x0f) {
      for (let i = 0; i < 4; i++) {
        if (shadowBits & (1 << i)) {
          fillRectPx(out, dx + (i % 2) * 24, dy + Math.floor(i / 2) * 24, 24, 24, [0, 0, 0, 102]);
        }
      }
    }

    const upperT1 = readMapData(x, y - 1, 1);
    if (isTableTile(upperT1) && !isTableTile(t1)) drawTableEdge(upperT1, dx, dy);

    drawTile(readMapData(x, y, 2), dx, dy);
    drawTile(readMapData(x, y, 3), dx, dy);
  }
}

// --- overlays ----------------------------------------------------------------

if (showGrid) {
  for (let x = 0; x <= width; x++) {
    const major = x % 5 === 0;
    fillRectPx(out, x * TILE, 0, 1, height * TILE, major ? [255, 255, 0, 110] : [0, 0, 0, 45]);
  }
  for (let y = 0; y <= height; y++) {
    const major = y % 5 === 0;
    fillRectPx(out, 0, y * TILE, width * TILE, 1, major ? [255, 255, 0, 110] : [0, 0, 0, 45]);
  }
}

if (showEvents) {
  const charCache = new Map();
  const loadChar = (name) => {
    if (!charCache.has(name)) {
      const p = path.join(projectDir, 'img', 'characters', `${name}.png`);
      charCache.set(name, fs.existsSync(p) ? PNG.sync.read(fs.readFileSync(p)) : null);
    }
    return charCache.get(name);
  };

  for (const ev of map.events ?? []) {
    if (!ev) continue;
    const dx = ev.x * TILE;
    const dy = ev.y * TILE;
    const page = (ev.pages ?? [])[0];
    const img = page?.image;
    const sheet = img?.characterName ? loadChar(img.characterName) : null;

    if (sheet) {
      // A sheet holds 4 characters in a 4x2 arrangement of 3-frame x 4-direction
      // blocks, unless the filename starts with '$' (a single big character).
      const big = img.characterName.startsWith('$');
      const cols = big ? 3 : 12;
      const rowsN = big ? 4 : 8;
      const fw = sheet.width / cols;
      const fh = sheet.height / rowsN;
      const n = img.characterIndex ?? 0;
      const blockX = big ? 0 : (n % 4) * 3;
      const blockY = big ? 0 : Math.floor(n / 4) * 4;
      const dir = Math.floor(((img.direction ?? 2) - 2) / 2); // 2,4,6,8 -> 0..3
      const sx = (blockX + (img.pattern ?? 1)) * fw;
      const sy = (blockY + dir) * fh;
      // characters are drawn bottom-anchored and horizontally centred on the tile
      blt(out, sheet, sx, sy, fw, fh, dx + Math.round((TILE - fw) / 2), dy + TILE - fh);
    } else {
      fillRectPx(out, dx + 10, dy + 10, TILE - 20, TILE - 20, [255, 40, 200, 170]);
    }
  }
}

// --- downscale + write -------------------------------------------------------

let final = out;
if (scale !== 1) {
  const w = Math.max(1, Math.round(out.width * scale));
  const h = Math.max(1, Math.round(out.height * scale));
  final = new PNG({ width: w, height: h });
  const bx = out.width / w;
  const by = out.height / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = Math.floor(y * by); sy < Math.min(out.height, Math.ceil((y + 1) * by)); sy++) {
        for (let sx = Math.floor(x * bx); sx < Math.min(out.width, Math.ceil((x + 1) * bx)); sx++) {
          const si = (sy * out.width + sx) * 4;
          r += out.data[si]; g += out.data[si + 1]; b += out.data[si + 2]; a += out.data[si + 3];
          n++;
        }
      }
      const di = (y * w + x) * 4;
      final.data[di] = Math.round(r / n);
      final.data[di + 1] = Math.round(g / n);
      final.data[di + 2] = Math.round(b / n);
      final.data[di + 3] = Math.round(a / n);
    }
  }
}

fs.writeFileSync(outPng, PNG.sync.write(final));
console.log(
  `Rendered map ${mapId} "${map.displayName || mapFile}" ${width}x${height} tiles ` +
  `-> ${final.width}x${final.height}px  ${outPng}`
);
