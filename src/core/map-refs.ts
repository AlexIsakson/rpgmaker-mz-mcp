/**
 * The references a *map* carries to things outside itself.
 *
 * `database-refs.ts` covers the ten tables `add_event_commands` can name. This
 * module covers the other three, and they fail in two different ways — which is
 * the reason they are one module and not a footnote on that one.
 *
 * **Two of them crash the game.** Both go through the same throw:
 *
 * ```js
 * DataManager.checkError = function() { if (this._errors.length > 0) { ... throw ["LoadError", url, retry]; } }
 * ImageManager.isReady   = function() { ... if (bitmap.isError()) { this.throwLoadError(bitmap); } ... }
 * ```
 *
 * - `transfer_player` names a map: `command201` reserves the transfer,
 *   `DataManager.loadMapData` requests `Map%03d.json`, the XHR 404s into
 *   `DataManager._errors`, and the next `isMapLoaded()` throws. The player gets
 *   the engine's error screen mid-transfer, on a black scene.
 * - a page's `image.characterName` names a sheet: `ImageManager.loadCharacter`
 *   builds `img/characters/<name>.png`, `Bitmap._onError` sets the loading state
 *   to `"error"`, and `Scene_Map` throws the moment it tests `isReady()`. It is
 *   not the event that fails — it is the whole map, on arrival, for every
 *   player.
 *
 * **One of them is silent**, and it is the same guard-then-do-nothing shape
 * `database-refs.ts` documents. A map's `tilesetId` past the end of
 * Tilesets.json makes `Game_Map.tileset()` undefined, and then:
 *
 * ```js
 * Game_Map.tilesetFlags     = function() { const t = this.tileset(); if (t) {...} else { return []; } }
 * Spriteset_Map.loadTileset = function() { this._tileset = $gameMap.tileset(); if (this._tileset) {...} }
 * ```
 *
 * `setBitmaps` is never called, so nothing is drawn; and `checkPassage` reads
 * `flags[tile]` as `undefined`, where `(undefined & bit) === 0` is true — the
 * "[o] Passable" branch. **Every tile becomes passable and invisible.** No
 * error, and the map still "works".
 *
 * **Measured.** `scripts/measure-map-refs.mjs` over the 293 sample maps and the
 * 64 maps of `Wicked Heart`:
 *
 * | | 201s | designation 0 | targets that resolve |
 * |---|---|---|---|
 * | samplemaps | 658 | 658 | 658 |
 * | Wicked Heart | 108 | 108 | 108 |
 *
 * | | pages with a sheet | distinct sheets | on disk |
 * |---|---|---|---|
 * | samplemaps | 1716 | 14 | 14 of 14, against the RTP's 45 |
 * | Wicked Heart | 162 | 31 | 31 of 31, of its 88 |
 *
 * Every tilesetId in all five projects on hand is a real row. So **a dangling
 * reference of any of these three kinds appears nowhere in 357 hand-made
 * maps** — it is a shape only a generator produces, which is why it is a
 * refusal rather than a note.
 *
 * The samplemaps transfer figure is the weaker of the two: that folder is
 * several sample projects' maps merged into one numbering, so its targets land
 * inside 1-293 partly by construction. `Wicked Heart` is one real project and
 * its 108 of 108 is the measurement that carries the claim.
 *
 * **Out of reach, recorded rather than checked:** `battle_processing`
 * designation. `command301` reads `params[0]` as 0 direct, 1 troop id from a
 * variable, 2 same as random encounters — and `convertCommand` hardcodes 0.
 * That matches all 13 corpus 301s (11 on maps, 2 in common events, none of
 * either other kind), so nothing is broken today; designation 2 is what an
 * encounter-driven battle needs and belongs with the encounter work rather than
 * here. `transfer_player` designation 1 is the same story — 0 of 766 corpus
 * transfers use it.
 *
 * This module is pure: it is handed what the project has and returns text.
 */

export class MapRefError extends Error {}

/** A map's dimensions, for the landing-square check. */
export interface MapSize {
  width: number;
  height: number;
}

/**
 * What the project has, as far as the caller could read it.
 *
 * Every field is optional and an absent one means **"could not tell"**, not
 * "empty" — the same degrade-to-unchecked rule `DatabaseTables` uses. Refusing
 * every transfer because `data/` would not list is worse than the bug.
 */
export interface MapRefInventory {
  /** Ids that have a `MapXXX.json` on disk. */
  mapIds?: ReadonlySet<number>;
  /** Sizes of whichever of those the caller read. A missing entry is unchecked. */
  mapSizes?: ReadonlyMap<number, MapSize>;
  /** Basenames in `img/characters`, without `.png`. */
  characterSheets?: ReadonlySet<string>;
  /** Tilesets.json, as loaded. Index 0 is the editor's null. */
  tilesets?: readonly (unknown | null)[];
}

/** Commands that name another map. Only one does. */
export function referencesMap(type: string): boolean {
  return type === 'transfer_player';
}

const ordinal = (index: number) => `command ${index + 1}`;

/** Up to eight names, so a refusal is a hint and not a wall of text. */
function sample(names: Iterable<string>): string {
  const all = [...names].sort();
  if (all.length === 0) return 'none';
  const head = all.slice(0, 8).join(', ');
  return all.length > 8 ? `${head}, ... (${all.length} in all)` : head;
}

/**
 * Refuse a character sheet that is not in `img/characters`.
 *
 * `subject` names the caller's own argument — "the door sprite",
 * "characterName" — because by the time this is reached the sheet came from one
 * of a dozen tools, and the message has to say which knob to turn.
 *
 * An empty name is left alone: `ImageManager.loadBitmap` returns
 * `_emptyBitmap` for a falsy filename, so a sprite-less page is deliberate and
 * common — 721 of the 2441 sample pages that carry an image have no sheet.
 */
export function requireCharacterSheet(
  name: string,
  sheets: ReadonlySet<string> | undefined,
  subject: string
): void {
  if (name === '') return;
  if (sheets === undefined || sheets.size === 0) return; // could not list — no claim
  if (sheets.has(name)) return;

  const wanted = name.toLowerCase();
  const near = [...sheets].filter((s) => s.toLowerCase() === wanted);
  const hint =
    near.length > 0
      ? ` The project has "${near[0]}" — the name is case-sensitive, because it is a URL.`
      : ` Sheets in this project: ${sample(sheets)}.`;

  throw new MapRefError(
    `${subject} names character sheet "${name}", and there is no ` +
      `img/characters/${name}.png. Bitmap._onError puts the sheet in the "error" state and ` +
      'ImageManager.isReady then throws a LoadError, so this does not merely leave the event ' +
      'invisible — the whole map fails to open, every time a player walks onto it.' +
      hint
  );
}

/**
 * Refuse a tileset id that is not a row of Tilesets.json.
 *
 * Unlike the two loader failures this one is silent, so the refusal spells out
 * what the map would have become.
 */
export function requireTileset(
  tilesetId: number,
  tilesets: readonly (unknown | null)[] | undefined,
  subject: string
): void {
  if (tilesets === undefined) return; // unreadable — no claim
  if (tilesetId > 0 && tilesetId < tilesets.length && tilesets[tilesetId]) return;

  const rows = tilesets.filter((t) => t !== null && t !== undefined).length;
  throw new MapRefError(
    `${subject} is tileset ${tilesetId}, which is not a row of Tilesets.json — that file holds ` +
      `${rows} tileset(s), ids 1-${Math.max(0, tilesets.length - 1)}. Game_Map.tileset() would ` +
      'be undefined, so Spriteset_Map.loadTileset never calls setBitmaps and tilesetFlags() ' +
      'returns []: nothing is drawn, and checkPassage takes its "[o] Passable" branch on every ' +
      'tile because `undefined & bit` is 0. The map would be invisible and walkable everywhere, ' +
      'with no error anywhere.'
  );
}

export interface MapRefCheckResult {
  /** Every distinct map id the list transfers to, in the order first seen. */
  targets: number[];
  notes: string[];
}

/**
 * The map ids a command list transfers to, so a caller can read just those maps
 * before checking. Separate from `checkMapRefs` because the inventory it needs
 * depends on the answer.
 */
export function transferTargets(commands: readonly Record<string, unknown>[]): number[] {
  const targets: number[] = [];
  for (const command of commands) {
    if (command.type !== 'transfer_player') continue;
    const raw = command.mapId;
    const mapId = typeof raw === 'number' && raw !== 0 ? raw : 1;
    if (mapId > 0 && !targets.includes(mapId)) targets.push(mapId);
  }
  return targets;
}

/**
 * Check the transfer targets in a human-readable command list.
 *
 * Runs on the same shape `checkDatabaseRefs` takes — before `convertCommand`,
 * so a refusal can name the caller's own field rather than a parameter index.
 */
export function checkMapRefs(
  commands: readonly Record<string, unknown>[],
  inventory: MapRefInventory
): MapRefCheckResult {
  const targets: number[] = [];
  const notes: string[] = [];

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    if (command.type !== 'transfer_player') continue;

    // `convertCommand` reads this as `(cmd.mapId as number) || 1`, so 0 and a
    // missing field both mean map 1 by the time the engine sees it.
    const raw = command.mapId;
    const mapId = typeof raw === 'number' && raw !== 0 ? raw : 1;
    if (!targets.includes(mapId)) targets.push(mapId);

    requireTransferTarget(mapId, command, i, inventory);
  }

  return { targets, notes };
}

function requireTransferTarget(
  mapId: number,
  command: Record<string, unknown>,
  index: number,
  inventory: MapRefInventory
): void {
  // `DataManager.loadMapData` loads a file only `if (mapId > 0)` and otherwise
  // calls makeEmptyMap() — a 100x100 blank with no tilesetId at all, which is
  // the invisible all-passable map described above, reached without a bad id.
  if (mapId < 0) {
    throw new MapRefError(
      `${ordinal(index)} (transfer_player) transfers to map ${mapId}. ` +
        'DataManager.loadMapData loads a file only `if (mapId > 0)` and otherwise calls ' +
        'makeEmptyMap(), which is a blank 100x100 map with no tilesetId — the player lands in ' +
        'an invisible void they can walk anywhere in, with no error.'
    );
  }

  const { mapIds, mapSizes } = inventory;
  if (mapIds !== undefined && !mapIds.has(mapId)) {
    const known = [...mapIds].sort((a, b) => a - b);
    const list =
      known.length <= 12
        ? known.join(', ')
        : `${known.slice(0, 12).join(', ')}, ... (${known.length} in all)`;
    throw new MapRefError(
      `${ordinal(index)} (transfer_player) transfers to map ${mapId}, and there is no ` +
        `data/Map${String(mapId).padStart(3, '0')}.json. The load 404s into DataManager._errors ` +
        'and the next isMapLoaded() throws a LoadError, so the player gets the engine error ' +
        'screen on a black scene part-way through the transfer. ' +
        (known.length === 0
          ? 'This project has no map files at all.'
          : `Maps in this project: ${list}.`)
    );
  }

  const size = mapSizes?.get(mapId);
  if (size === undefined) return;

  const x = typeof command.x === 'number' ? command.x : 0;
  const y = typeof command.y === 'number' ? command.y : 0;
  if (x >= 0 && y >= 0 && x < size.width && y < size.height) return;

  throw new MapRefError(
    `${ordinal(index)} (transfer_player) lands the player at (${x}, ${y}) on map ${mapId}, ` +
      `which is ${size.width}x${size.height}. Game_Player.performTransfer calls locate() with ` +
      'no bounds check, and Game_CharacterBase.canPass then returns false for every direction ' +
      'whose neighbour fails Game_Map.isValid — off the map on more than one side, the player ' +
      'cannot move at all, and nothing says why.'
  );
}
