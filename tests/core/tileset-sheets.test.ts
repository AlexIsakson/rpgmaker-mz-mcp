import { describe, it, expect } from 'vitest';
import {
  SHEET_SLOT_NAMES,
  checkSheetsPresent,
  sheetSlotForKind,
  sheetSlotForTileId,
} from '../../src/core/tileset-sheets.js';

/**
 * The rule under test: a tileset slot is allowed to be empty, and a tile id
 * addressing an empty slot draws nothing while the map data claims it is there.
 *
 * The slot mapping is the engine's — `Tilemap._addAutotile` and
 * `Tilemap._addNormalTile` — so the assertions below are written from those
 * branches rather than from this module's own arithmetic.
 */

/** `Overworld` as a new project ships it: A1, A2, B and C only. */
const overworld = ['World_A1', 'World_A2', '', '', '', 'World_B', 'World_C', '', ''];
/** `Outside` as it ships: everything but D and E. */
const outside = [
  'Outside_A1', 'Outside_A2', 'Outside_A3', 'Outside_A4', 'Outside_A5',
  'Outside_B', 'Outside_C', '', '',
];

describe('sheetSlotForTileId', () => {
  it('maps each family to the set number the engine uses', () => {
    expect(sheetSlotForTileId(2048)).toBe(0);   // TILE_ID_A1
    expect(sheetSlotForTileId(2815)).toBe(0);
    expect(sheetSlotForTileId(2816)).toBe(1);   // TILE_ID_A2
    expect(sheetSlotForTileId(4351)).toBe(1);
    expect(sheetSlotForTileId(4352)).toBe(2);   // TILE_ID_A3
    expect(sheetSlotForTileId(5887)).toBe(2);
    expect(sheetSlotForTileId(5888)).toBe(3);   // TILE_ID_A4
    expect(sheetSlotForTileId(8191)).toBe(3);
    expect(sheetSlotForTileId(1536)).toBe(4);   // TILE_ID_A5
    expect(sheetSlotForTileId(2047)).toBe(4);
  });

  it('splits the object sheets every 256 ids, as 5 + floor(tileId / 256)', () => {
    expect(sheetSlotForTileId(1)).toBe(5);      // B
    expect(sheetSlotForTileId(255)).toBe(5);
    expect(sheetSlotForTileId(256)).toBe(6);    // C
    expect(sheetSlotForTileId(512)).toBe(7);    // D
    expect(sheetSlotForTileId(768)).toBe(8);    // E
    expect(sheetSlotForTileId(1023)).toBe(8);
  });

  it('returns null for ids that address no sheet', () => {
    expect(sheetSlotForTileId(0)).toBeNull();       // empty cell
    expect(sheetSlotForTileId(1024)).toBeNull();    // the gap before A5
    expect(sheetSlotForTileId(1535)).toBeNull();
    expect(sheetSlotForTileId(8192)).toBeNull();    // TILE_ID_MAX
    expect(sheetSlotForTileId(-1)).toBeNull();
  });

  it('names the nine slots in tilesetNames order', () => {
    expect(SHEET_SLOT_NAMES).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'B', 'C', 'D', 'E']);
  });
});

describe('sheetSlotForKind', () => {
  it('splits the autotile kinds at 16, 48 and 80', () => {
    expect(sheetSlotForKind(0)).toBe(0);    // A1 water
    expect(sheetSlotForKind(15)).toBe(0);
    expect(sheetSlotForKind(16)).toBe(1);   // A2 ground
    expect(sheetSlotForKind(47)).toBe(1);
    expect(sheetSlotForKind(48)).toBe(2);   // A3 walls and roofs
    expect(sheetSlotForKind(79)).toBe(2);
    expect(sheetSlotForKind(80)).toBe(3);   // A4 walls and wall tops
    expect(sheetSlotForKind(127)).toBe(3);
  });

  it('returns null past the last kind', () => {
    expect(sheetSlotForKind(128)).toBeNull();
    expect(sheetSlotForKind(-1)).toBeNull();
    expect(sheetSlotForKind(1.5)).toBeNull();
  });
});

describe('checkSheetsPresent', () => {
  it('passes a kind whose sheet the tileset has', () => {
    expect(checkSheetsPresent([{ kind: 16, label: 'floorKind' }], overworld, 'Overworld'))
      .toBeNull();
  });

  it('refuses the A4 wall default on Overworld, naming kind, sheet and tileset', () => {
    // The case P5-31 was raised for: generate_map_layout's surroundKind: 98.
    const refusal = checkSheetsPresent(
      [{ kind: 98, label: 'surroundKind' }], overworld, 'Overworld'
    );
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('98');
    expect(refusal).toContain('surroundKind');
    expect(refusal).toContain('A4');
    expect(refusal).toContain('Overworld');
    expect(refusal).toContain('Nothing was written');
  });

  it('reports every wrong argument at once, not just the first', () => {
    const refusal = checkSheetsPresent(
      [
        { kind: 48, label: 'roofKind' },      // A3, absent
        { kind: 98, label: 'wallKind' },      // A4, absent
        { kind: 16, label: 'groundKind' },    // A2, present
      ],
      overworld,
      'Overworld'
    );
    expect(refusal).toContain('roofKind');
    expect(refusal).toContain('wallKind');
    expect(refusal).not.toContain('groundKind');
    // Both absent slots are named, and neither is named twice.
    expect(refusal).toContain('A3 and A4');
  });

  it('checks raw tile ids the same way', () => {
    // Outside has B and C but no D or E, which is where a roofTopLeftTileId
    // typed one sheet too far lands.
    expect(checkSheetsPresent([{ tileId: 300, label: 'roofTopLeftTileId' }], outside, 'Outside'))
      .toBeNull();
    const refusal = checkSheetsPresent(
      [{ tileId: 800, label: 'roofTopLeftTileId' }], outside, 'Outside'
    );
    expect(refusal).toContain('E tile id 800');
    expect(refusal).toContain('roofTopLeftTileId');
  });

  it('lets tile id 0 through, because every tileset can express an empty cell', () => {
    expect(checkSheetsPresent([{ tileId: 0, label: 'tileId' }], overworld, 'Overworld'))
      .toBeNull();
  });

  it('says so when a value addresses no sheet at all', () => {
    const refusal = checkSheetsPresent(
      [{ tileId: 1200, label: 'tileId' }], outside, 'Outside'
    );
    expect(refusal).toContain('addresses no tileset sheet at all');
    expect(refusal).toContain('1200');
  });

  it('ignores arguments that were not given', () => {
    expect(checkSheetsPresent([{ label: 'roadKind' }], overworld, 'Overworld')).toBeNull();
  });
});


describe('against the tilesets a new project ships', () => {
  /**
   * Transcribed from `newdata/data/Tilesets.json`. The point of this test is
   * that the trap is in the *shipped defaults*, not in some exotic tileset a
   * user built: four of the six have no A3, and one has neither A3 nor A4.
   */
  const shipped: [string, string[]][] = [
    ['Overworld', ['World_A1', 'World_A2', '', '', '', 'World_B', 'World_C', '', '']],
    ['Outside', ['Outside_A1', 'Outside_A2', 'Outside_A3', 'Outside_A4', 'Outside_A5', 'Outside_B', 'Outside_C', '', '']],
    ['Inside', ['Inside_A1', 'Inside_A2', '', 'Inside_A4', 'Inside_A5', 'Inside_B', 'Inside_C', '', '']],
    ['Dungeon', ['Dungeon_A1', 'Dungeon_A2', '', 'Dungeon_A4', 'Dungeon_A5', 'Dungeon_B', 'Dungeon_C', '', '']],
    ['SF Outside', ['SF_A1', 'SF_A2', 'SF_A3', 'SF_A4', 'SF_A5', 'SF_B', 'SF_C', '', '']],
    ['SF Inside', ['SF_A1', 'SF_A2', '', 'SF_A4', 'SF_A5', 'SF_B', 'SF_C', '', '']],
  ];

  it('refuses an A3 roof kind on the four tilesets that have no A3', () => {
    const refused = shipped.filter(([name, names]) =>
      checkSheetsPresent([{ kind: 48, label: 'roofKind' }], names, name) !== null
    );
    expect(refused.map(([name]) => name)).toEqual(['Overworld', 'Inside', 'Dungeon', 'SF Inside']);
  });

  it('accepts the A2 kind 16 default everywhere, since all six have an A2', () => {
    for (const [name, names] of shipped) {
      expect(checkSheetsPresent([{ kind: 16, label: 'groundKind' }], names, name)).toBeNull();
    }
  });
});
