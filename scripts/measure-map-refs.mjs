// Counts the references a *map* carries to things outside itself, and how often
// a real project's are satisfiable.
//
//   node scripts/measure-map-refs.mjs [projectRoot...]
//
// This is the evidence behind "What the map points at" in ROADMAP.md and behind
// which of those references `src/core/map-refs.ts` refuses on. Four families,
// each a lookup the server can write and nothing checks:
//
//   * transfer_player (201) -> Map%03d.json          DataManager.loadMapData
//   * a page image           -> img/characters/*.png  ImageManager.loadCharacter
//   * a map's tilesetId      -> Tilesets.json         Game_Map.tileset
//   * battle_processing (301) designation             command301 params[0]
//
// Unlike build-passage-catalogue.mjs this generates nothing — it prints counts.
// A project root is the folder holding `data/` and `img/`; a bare folder of map
// JSONs (samplemaps) is read for the command counts only, since it has no
// database or images to resolve against.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ROOTS = [
  ['samplemaps', 'M:/SteamLibrary/steamapps/common/RPG Maker MZ/samplemaps'],
  ['newdata', 'M:/SteamLibrary/steamapps/common/RPG Maker MZ/newdata'],
  ['Wicked Heart', 'M:/Projects/RPGMZ/Wicked Heart'],
  ['Foo', 'M:/Projects/RPGMZ/Foo'],
  ['Learn', 'M:/Projects/RPGMZ/Learn'],
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

/** Every command list on a map: each page of each event, plus the two commons. */
function* commandLists(map) {
  for (const event of map.events ?? []) {
    for (const page of event?.pages ?? []) if (Array.isArray(page?.list)) yield page.list;
  }
}

function scanRoot(label, root) {
  // A project root has data/ next to img/; samplemaps is just the JSONs.
  const dataDir = fs.existsSync(path.join(root, 'data')) ? path.join(root, 'data') : root;
  const imgDir = path.join(root, 'img', 'characters');

  const mapFiles = fs
    .readdirSync(dataDir)
    .filter((f) => /^Map\d{3}\.json$/.test(f))
    .sort();

  const presentMapIds = new Set(mapFiles.map((f) => Number(f.slice(3, 6))));
  const tilesets = readJson(path.join(dataDir, 'Tilesets.json'));
  const sheets = fs.existsSync(imgDir)
    ? new Set(fs.readdirSync(imgDir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)))
    : null;

  const t = {
    maps: mapFiles.length,
    commonTransfers: 0,
    commonBattles: 0,
    transfers: 0,
    transferDirect: 0,
    transferVariable: 0,
    transferTargets: new Set(),
    transferHits: 0,
    transferMisses: [],
    transferSelf: 0,
    battles: 0,
    battleDesignation: [0, 0, 0],
    pagesWithImage: 0,
    pagesTile: 0,
    pagesBlank: 0,
    sheetNames: new Set(),
    sheetMisses: new Set(),
    tilesetIds: new Set(),
    tilesetMisses: [],
  };

  for (const file of mapFiles) {
    const mapId = Number(file.slice(3, 6));
    const map = readJson(path.join(dataDir, file));
    if (!map) continue;

    if (typeof map.tilesetId === 'number') {
      t.tilesetIds.add(map.tilesetId);
      if (tilesets && !tilesets[map.tilesetId]) t.tilesetMisses.push(`${file}->${map.tilesetId}`);
    }

    for (const event of map.events ?? []) {
      for (const page of event?.pages ?? []) {
        const image = page?.image;
        if (!image) continue;
        if (image.characterName) {
          t.pagesWithImage++;
          t.sheetNames.add(image.characterName);
          if (sheets && !sheets.has(image.characterName)) t.sheetMisses.add(image.characterName);
        } else if (image.tileId > 0) t.pagesTile++;
        else t.pagesBlank++;
      }
    }

    for (const list of commandLists(map)) {
      for (const cmd of list) {
        const p = cmd?.parameters ?? [];
        if (cmd?.code === 201) {
          t.transfers++;
          if (p[0] === 0) {
            t.transferDirect++;
            const target = p[1];
            t.transferTargets.add(target);
            if (target === mapId) t.transferSelf++;
            if (presentMapIds.has(target)) t.transferHits++;
            else t.transferMisses.push(`${file}->${target}`);
          } else t.transferVariable++;
        } else if (cmd?.code === 301) {
          t.battles++;
          if (p[0] >= 0 && p[0] <= 2) t.battleDesignation[p[0]]++;
        }
      }
    }
  }

  // Common events are not on a map, but the same two commands live there and
  // the roadmap's earlier 301 count included them — scan them so the numbers
  // stay comparable.
  for (const ce of readJson(path.join(dataDir, 'CommonEvents.json')) ?? []) {
    for (const cmd of ce?.list ?? []) {
      const p = cmd?.parameters ?? [];
      if (cmd?.code === 201) {
        t.commonTransfers++;
        if (p[0] === 0 && !presentMapIds.has(p[1])) t.transferMisses.push(`CommonEvent ${ce.id}->${p[1]}`);
      } else if (cmd?.code === 301) {
        t.commonBattles++;
        if (p[0] >= 0 && p[0] <= 2) t.battleDesignation[p[0]]++;
      }
    }
  }

  return { label, dataDir, tilesets, sheets, ...t };
}

const results = roots
  .filter(([, root]) => fs.existsSync(root))
  .map(([label, root]) => scanRoot(label, root));

const pad = (s, n) => String(s).padEnd(n);

console.log('\n=== transfer_player (201) -> Map%03d.json ===');
console.log(pad('project', 16), pad('maps', 6), pad('201s', 6), pad('direct', 7), pad('var', 5), pad('targets', 8), pad('resolve', 8), 'missing');
for (const r of results) {
  console.log(
    pad(r.label, 16), pad(r.maps, 6), pad(r.transfers, 6), pad(r.transferDirect, 7),
    pad(r.transferVariable, 5), pad(r.transferTargets.size, 8),
    pad(`${r.transferHits}/${r.transferDirect}`, 8),
    r.transferMisses.length === 0 ? '-' : r.transferMisses.slice(0, 6).join(', ')
  );
}

console.log('\n=== event page images -> img/characters ===');
console.log(pad('project', 16), pad('sheet', 7), pad('tile', 6), pad('blank', 6), pad('distinct', 9), pad('on disk', 9), 'missing');
for (const r of results) {
  console.log(
    pad(r.label, 16), pad(r.pagesWithImage, 7), pad(r.pagesTile, 6), pad(r.pagesBlank, 6),
    pad(r.sheetNames.size, 9),
    pad(r.sheets === null ? 'no img/' : r.sheets.size, 9),
    r.sheets === null ? '(unresolvable)' : r.sheetMisses.size === 0 ? '-' : [...r.sheetMisses].slice(0, 6).join(', ')
  );
}

console.log('\n=== map tilesetId -> Tilesets.json ===');
console.log(pad('project', 16), pad('rows', 6), pad('distinct ids', 13), pad('range', 10), 'past the end');
for (const r of results) {
  const ids = [...r.tilesetIds].sort((a, b) => a - b);
  const rows = r.tilesets ? r.tilesets.filter((x) => x).length : 'no db';
  console.log(
    pad(r.label, 16), pad(rows, 6), pad(ids.length, 13),
    pad(ids.length ? `${ids[0]}-${ids[ids.length - 1]}` : '-', 10),
    r.tilesetMisses.length === 0 ? '-' : r.tilesetMisses.slice(0, 6).join(', ')
  );
}

console.log('\n=== battle_processing (301) designation ===');
console.log(pad('project', 16), pad('on maps', 8), pad('in commons', 11), pad('0 direct', 9), pad('1 variable', 11), '2 random-encounter');
for (const r of results) {
  console.log(
    pad(r.label, 16), pad(r.battles, 8), pad(r.commonBattles, 11), pad(r.battleDesignation[0], 9),
    pad(r.battleDesignation[1], 11), r.battleDesignation[2]
  );
}
console.log();
