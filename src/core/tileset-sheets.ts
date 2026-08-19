import {
  TILE_ID_A1,
  TILE_ID_A2,
  TILE_ID_A3,
  TILE_ID_A4,
  TILE_ID_A5,
  TILE_ID_MAX,
  makeAutotileId,
} from './autotile.js';

/**
 * Does the tileset actually have the sheet a tile is drawn from?
 *
 * A tileset is nine image slots, and **a slot is allowed to be empty**. When it
 * is, a tile id that addresses it is not an error the engine reports — it is a
 * tile that draws nothing. `Tilemap.Layer._createTexture` binds whatever bitmap
 * sits at that set number, and an unset one is a blank bitmap, so the tile is
 * simply absent from the render while the map data says it is there.
 *
 * **Which slot a tile id belongs to is the engine's,** read off
 * `Tilemap._addAutotile` and `Tilemap._addNormalTile` in
 * `corescript/v1.9.0/rmmz_core.js`: A1 is set 0, A2 set 1, A3 set 2, A4 set 3,
 * A5 set 4, and every other id is `5 + floor(tileId / 256)` — B, C, D, E.
 *
 * **How often a slot is empty, measured.** Over the six tilesets a new project
 * ships (`newdata/data/Tilesets.json`):
 *
 * | tileset | empty slots |
 * |---|---|
 * | `Overworld` | A3, A4, A5, D, E |
 * | `Outside` | D, E |
 * | `Inside` | A3, D, E |
 * | `Dungeon` | A3, D, E |
 * | `SF Outside` | D, E |
 * | `SF Inside` | A3, D, E |
 *
 * So `generate_map_layout` with the A4 wall kind 98 on `Overworld` — a
 * perfectly ordinary call — writes 98 into a slot that is not there. Verified
 * by PNG: the surround is absent, the map renders as an island of floor on
 * nothing, and the tool reports it as a success.
 *
 * Across the user's own projects (22 tilesets in `Wicked Heart`, `Foo` and
 * `Learn`) the same slots are the thin ones: **A3 empty in 16 of 22, D in 19,
 * E in 20**, against A2 in 3 and C in 3. A3/A4/D/E are where this bites.
 *
 * **Is a hand-made map ever like this?** Of the 293 sample maps, 292 write only
 * to slots their tileset fills. The one exception (`Map278`, 51 E-sheet tiles
 * on `Outside`, which has no E) is far more likely a tileset-index mismatch
 * between the shipped sample and `newdata` than the editor permitting it — the
 * sample maps carry a bare `tilesetId`, not the tileset itself. Either way it
 * is 1 in 293, so refusing is not going to fight normal authoring.
 *
 * There is deliberately **no override flag**. An overlay on layer 0 at least
 * draws something, so `allowOverlayOnGround` can be a considered choice; a tile
 * from an absent sheet can never draw anything, on any layer, for any caller.
 *
 * This module is pure — it is handed `tilesetNames` and returns text.
 */

/** Slot names in `tilesetNames` order, which is the engine's set number order. */
export const SHEET_SLOT_NAMES = ['A1', 'A2', 'A3', 'A4', 'A5', 'B', 'C', 'D', 'E'] as const;

export type SheetSlotName = (typeof SHEET_SLOT_NAMES)[number];

/**
 * Which of the nine sheets this tile id draws from, or null when it addresses
 * none of them.
 *
 * Ports the set-number branches of `Tilemap._addAutotile` and
 * `Tilemap._addNormalTile`. Ids 1024-1535 fall between the E sheet and A5 and
 * belong to no slot; the editor never emits them — 0 occurrences across the
 * 441,000 non-empty tiles of the 293 sample maps — so they are a caller's
 * arithmetic slip, and null says so rather than pointing at a wrong sheet.
 */
export function sheetSlotForTileId(tileId: number): number | null {
  if (!Number.isInteger(tileId) || tileId <= 0 || tileId >= TILE_ID_MAX) return null;
  if (tileId >= TILE_ID_A4) return 3;
  if (tileId >= TILE_ID_A3) return 2;
  if (tileId >= TILE_ID_A2) return 1;
  if (tileId >= TILE_ID_A1) return 0;
  if (tileId >= TILE_ID_A5) return 4;
  const slot = 5 + Math.floor(tileId / 256);
  return slot <= 8 ? slot : null;
}

/** Which sheet an autotile kind draws from. Shape 0 is as good as any. */
export function sheetSlotForKind(kind: number): number | null {
  if (!Number.isInteger(kind) || kind < 0) return null;
  const tileId = makeAutotileId(kind, 0);
  if (tileId >= TILE_ID_MAX) return null;
  return sheetSlotForTileId(tileId);
}

/** One argument to check, and the name to blame if it is wrong. */
export interface SheetRequest {
  /** An autotile kind, when the argument takes one. */
  kind?: number;
  /** A raw tile id, when the argument takes one instead. */
  tileId?: number;
  /** The argument it came from, so the refusal says which one was wrong. */
  label: string;
}

/**
 * Check every sheet a call is about to draw from, in one pass.
 *
 * Like `checkGroundKinds`, all requests are examined before anything is
 * returned, so a caller who got two arguments wrong hears about both at once.
 * Returns the refusal text, or null when every sheet is present.
 */
export function checkSheetsPresent(
  requests: SheetRequest[],
  tilesetNames: string[],
  tilesetName: string
): string | null {
  const missing: { label: string; what: string; slot: SheetSlotName }[] = [];
  const unaddressable: string[] = [];

  for (const request of requests) {
    const isKind = request.kind !== undefined;
    const value = isKind ? request.kind! : request.tileId;
    if (value === undefined) continue;
    // A tile id of 0 is "empty", which every tileset can express.
    if (!isKind && value === 0) continue;

    const slot = isKind ? sheetSlotForKind(value) : sheetSlotForTileId(value);
    if (slot === null) {
      unaddressable.push(
        `${isKind ? 'kind' : 'tile id'} ${value} (${request.label})`
      );
      continue;
    }
    if (tilesetNames[slot]) continue;

    missing.push({
      label: request.label,
      what: `${isKind ? 'kind' : 'tile id'} ${value}`,
      slot: SHEET_SLOT_NAMES[slot],
    });
  }

  if (unaddressable.length === 0 && missing.length === 0) return null;

  const lines: string[] = [];

  if (missing.length > 0) {
    const listed = missing
      .map((m) => `${m.slot} ${m.what} (${m.label})`)
      .join('; ');
    const slots = [...new Set(missing.map((m) => m.slot))];
    const plural = missing.length > 1;
    lines.push(
      `${listed} — but tileset "${tilesetName}" has no ${slots.join(' and ')} sheet, so ` +
      `${plural ? 'those tiles' : 'that tile'} would draw nothing at all. The map data ` +
      `would say ${plural ? 'they are' : 'it is'} there and the render would be empty. ` +
      'Nothing was written.'
    );
    lines.push(
      `Pick a material from a sheet this tileset fills, or add the ${slots.join('/')} ` +
      'image to the tileset in the editor. describe_tileset_materials lists what is there.'
    );
  }

  if (unaddressable.length > 0) {
    lines.push(
      `${unaddressable.join('; ')} addresses no tileset sheet at all — ids 1024-1535 fall ` +
      'between the E sheet and A5, and autotile kinds stop at 127. Nothing was written.'
    );
  }

  return lines.join('\n\n');
}
