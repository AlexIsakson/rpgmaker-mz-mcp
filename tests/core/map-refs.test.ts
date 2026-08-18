import { describe, it, expect } from 'vitest';
import {
  checkMapRefs,
  referencesMap,
  requireCharacterSheet,
  requireTileset,
  transferTargets,
  MapRefError,
  type MapRefInventory,
} from '../../src/core/map-refs.js';

/**
 * Three references a map carries, and the two different ways they fail.
 *
 * The loader pair throws rather than shrugging:
 *
 *  - `DataManager.checkError` — a 404 on `Map%03d.json` sits in `_errors`
 *    until the next `isMapLoaded()`, which throws `["LoadError", url, retry]`.
 *  - `ImageManager.isReady` — a sheet whose `Bitmap._onError` fired is in the
 *    `"error"` state, and `throwLoadError` fires the moment a scene asks.
 *
 * The tileset is the silent one, and the assertions below check the two halves
 * of it separately because they are two different engine functions:
 * `Game_Map.tilesetFlags` returning `[]` (nothing is passable-checked) and
 * `Spriteset_Map.loadTileset` skipping `setBitmaps` (nothing is drawn).
 */

// --- a port of the engine's passage read, for the tileset assertion ---------

/**
 * `Game_Map.checkPassage`, verbatim enough for the one question asked of it:
 * what does it answer when `tilesetFlags()` returned `[]`?
 */
function checkPassage(flags: number[], tiles: number[], bit: number): boolean {
  for (const tile of tiles) {
    const flag = flags[tile];
    if ((flag & 0x10) !== 0) continue;
    if ((flag & bit) === 0) return true;
    if ((flag & bit) === bit) return false;
  }
  return false;
}

const sheets = new Set(['!Door1', '!Chest', 'People1', 'Actor1']);
const tilesets = [null, { name: 'Overworld' }, { name: 'Outside' }, null, { name: 'Inside' }];

const transfer = (mapId: number, x = 0, y = 0) => ({ type: 'transfer_player', mapId, x, y });

describe('referencesMap', () => {
  it('is true only for transfer_player', () => {
    expect(referencesMap('transfer_player')).toBe(true);
    for (const type of ['show_text', 'battle_processing', 'control_switches', '']) {
      expect(referencesMap(type)).toBe(false);
    }
  });
});

describe('transferTargets', () => {
  it('collects each target once, in the order first seen', () => {
    const list = [transfer(4), { type: 'show_text', text: 'hi' }, transfer(2), transfer(4)];
    expect(transferTargets(list)).toEqual([4, 2]);
  });

  it('reads a missing or zero mapId as 1, the way convertCommand does', () => {
    expect(transferTargets([{ type: 'transfer_player' }])).toEqual([1]);
    expect(transferTargets([transfer(0)])).toEqual([1]);
  });
});

describe('checkMapRefs — the map a transfer names', () => {
  const inventory: MapRefInventory = { mapIds: new Set([1, 2, 4]) };

  it('accepts a target that has a file', () => {
    expect(() => checkMapRefs([transfer(4)], inventory)).not.toThrow();
  });

  it('refuses a target with no MapXXX.json', () => {
    expect(() => checkMapRefs([transfer(3)], inventory)).toThrow(MapRefError);
  });

  it('names the file, the throw and the maps that do exist', () => {
    let message = '';
    try {
      checkMapRefs([{ type: 'show_text' }, transfer(9)], inventory);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('command 2'); // 1-based, and it is the second command
    expect(message).toContain('Map009.json');
    expect(message).toContain('LoadError');
    expect(message).toContain('1, 2, 4');
  });

  it('refuses a negative id, which makeEmptyMap swallows into a blank 100x100', () => {
    expect(() => checkMapRefs([transfer(-1)], inventory)).toThrow(/makeEmptyMap/);
  });

  it('makes no claim when the map folder could not be listed', () => {
    expect(() => checkMapRefs([transfer(999)], {})).not.toThrow();
  });

  it('leaves non-transfer commands alone', () => {
    const list = [{ type: 'battle_processing', troopId: 1 }, { type: 'show_text', text: 'x' }];
    expect(() => checkMapRefs(list, inventory)).not.toThrow();
    expect(checkMapRefs(list, inventory).targets).toEqual([]);
  });
});

describe('checkMapRefs — where the player lands', () => {
  const inventory: MapRefInventory = {
    mapIds: new Set([1, 2]),
    mapSizes: new Map([[2, { width: 17, height: 13 }]]),
  };

  it('accepts a square inside the target map', () => {
    expect(() => checkMapRefs([transfer(2, 16, 12)], inventory)).not.toThrow();
  });

  it.each([
    ['one past the right edge', 17, 0],
    ['one past the bottom edge', 0, 13],
    ['negative x', -1, 0],
  ])('refuses %s', (_label, x, y) => {
    expect(() => checkMapRefs([transfer(2, x, y)], inventory)).toThrow(MapRefError);
  });

  it('says what the map measures and why the player would be stuck', () => {
    let message = '';
    try {
      checkMapRefs([transfer(2, 40, 40)], inventory);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('17x13');
    expect(message).toContain('isValid');
  });

  it('makes no claim about a map whose size was not read', () => {
    // Map 1 is known to exist but was not measured — unchecked, not invalid.
    expect(() => checkMapRefs([transfer(1, 900, 900)], inventory)).not.toThrow();
  });

  it('defaults a missing x/y to 0, which is inside any map', () => {
    expect(() => checkMapRefs([{ type: 'transfer_player', mapId: 2 }], inventory)).not.toThrow();
  });
});

describe('requireCharacterSheet', () => {
  it('accepts a sheet that is on disk', () => {
    expect(() => requireCharacterSheet('!Door1', sheets, 'doorSprite')).not.toThrow();
  });

  it('refuses one that is not', () => {
    expect(() => requireCharacterSheet('!Door9', sheets, 'doorSprite')).toThrow(MapRefError);
  });

  it('says the whole map fails, not just the event', () => {
    let message = '';
    try {
      requireCharacterSheet('!Door9', sheets, 'doorSprite');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('doorSprite');
    expect(message).toContain('img/characters/!Door9.png');
    expect(message).toContain('LoadError');
    expect(message).toContain('whole map');
  });

  it('calls out a case difference, since the name is a URL', () => {
    expect(() => requireCharacterSheet('people1', sheets, 'characterName')).toThrow(
      /case-sensitive/
    );
  });

  it('leaves an empty name alone — loadBitmap returns _emptyBitmap for a falsy filename', () => {
    expect(() => requireCharacterSheet('', sheets, 'characterName')).not.toThrow();
  });

  it('makes no claim when img/characters could not be listed', () => {
    expect(() => requireCharacterSheet('Whatever', undefined, 'characterName')).not.toThrow();
    expect(() => requireCharacterSheet('Whatever', new Set(), 'characterName')).not.toThrow();
  });
});

describe('requireTileset', () => {
  it('accepts a real row', () => {
    for (const id of [1, 2, 4]) {
      expect(() => requireTileset(id, tilesets, 'tilesetId')).not.toThrow();
    }
  });

  it.each([
    ['past the end', 5],
    ['index 0, the editor null', 0],
    ['a hole in the middle', 3],
    ['negative', -2],
  ])('refuses %s', (_label, id) => {
    expect(() => requireTileset(id, tilesets, 'tilesetId')).toThrow(MapRefError);
  });

  it('reports how many rows there really are, ignoring the nulls', () => {
    let message = '';
    try {
      requireTileset(5, tilesets, "The new map's tilesetId");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('3 tileset(s)');
    expect(message).toContain('ids 1-4');
  });

  it('makes no claim when Tilesets.json could not be read', () => {
    expect(() => requireTileset(99, undefined, 'tilesetId')).not.toThrow();
  });

  it('is refused because the failure is silent, which the port confirms', () => {
    // Game_Map.tilesetFlags() returns [] when tileset() is undefined, and
    // checkPassage then takes its "[o] Passable" branch on every tile: the map
    // is invisible and walkable everywhere, with nothing raised.
    const noFlags: number[] = [];
    for (const bit of [0x01, 0x02, 0x04, 0x08]) {
      expect(checkPassage(noFlags, [2816, 0], bit)).toBe(true);
    }
    // With a real flag table the same tile is impassable, so the difference is
    // the missing tileset and not the tile.
    const flags: number[] = [];
    flags[2816] = 0x0f;
    expect(checkPassage(flags, [2816, 0], 0x02)).toBe(false);
  });
});
