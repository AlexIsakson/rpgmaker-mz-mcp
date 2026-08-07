import { describe, it, expect } from 'vitest';
import {
  collectProps,
  findProps,
  propCells,
  propGaps,
  propPart,
  propShape,
  slotBase,
  unknownSheets,
  PropError,
  OBJECT_SLOTS,
  type Prop,
} from '../../src/core/props.js';
import { PROP_SHEETS } from '../../src/core/prop-catalogue.js';
import { OUTSIDE_C_ROOF_SETS, nineSliceTileId } from '../../src/core/blueprint.js';

/** A tileset's names: A1 A2 A3 A4 A5 B C D E. */
const OUTSIDE = ['Outside_A1', 'Outside_A2', 'Outside_A3', 'Outside_A4', 'Outside_A5',
                 'Outside_B', 'Outside_C', '', ''];

const prop = (names: string[], query: string): Prop => {
  const found = findProps(collectProps(names), query);
  expect(found).toHaveLength(1);
  return found[0];
};

/** Tilemap._addNormalTile, from the corescript — where a tile is drawn from. */
const sourceColumn = (tileId: number) => (Math.floor(tileId / 128) % 2) * 8 + (tileId % 8);
const sourceRow = (tileId: number) => Math.floor((tileId % 256) / 8) % 16;

describe('sheet slots', () => {
  it('offsets tile ids by which slot the sheet sits in', () => {
    expect(slotBase(5)).toBe(0);     // B
    expect(slotBase(6)).toBe(256);   // C
    expect(slotBase(7)).toBe(512);   // D
    expect(slotBase(8)).toBe(768);   // E
  });

  it('resolves the same sheet differently in different slots', () => {
    // The catalogue is sheet-local, so a PNG used as C rather than B has to come
    // out 256 higher — nothing about the art changes, only where it is bound.
    const asB = prop(['', '', '', '', '', 'Outside_B'], 'Barrel');
    const asC = prop(['', '', '', '', '', '', 'Outside_B'], 'Barrel');
    expect(asC.topLeft - asB.topLeft).toBe(256);
  });

  it('reports object sheets it has no names for instead of failing', () => {
    const names = ['', '', '', '', '', 'Outside_B', 'MyCustomSheet', '', ''];
    expect(unknownSheets(names)).toEqual(['MyCustomSheet']);
    expect(collectProps(names).length).toBeGreaterThan(0);
  });

  it('finds nothing for a tileset with no catalogued sheets', () => {
    expect(collectProps(['', '', '', '', '', 'Custom_B'])).toEqual([]);
  });
});

describe('findProps', () => {
  it('prefers an exact match over the names that contain it', () => {
    // Outside_B has Tree, Dead Tree, Large Tree, Palm Tree and more.
    const props = collectProps(OUTSIDE);
    expect(props.filter((p) => p.name.toLowerCase().includes('tree')).length).toBeGreaterThan(4);
    expect(findProps(props, 'Tree').map((p) => p.name)).toEqual(['Tree']);
  });

  it('ignores case and surrounding space', () => {
    expect(findProps(collectProps(OUTSIDE), '  barrel ').map((p) => p.name)).toEqual(['Barrel']);
  });

  it('falls back to substring when nothing matches exactly', () => {
    const names = findProps(collectProps(OUTSIDE), 'Shop Sign').map((p) => p.name);
    expect(names.length).toBeGreaterThan(5);
    expect(names.every((n) => n.includes('Shop Sign'))).toBe(true);
  });
});

describe('propCells', () => {
  it('addresses cells as topLeft + row * 8 + col', () => {
    const largeTree = prop(OUTSIDE, 'Large Tree');
    expect(largeTree.width).toBe(4);
    expect(largeTree.height).toBe(2);
    expect(propCells(largeTree).map((c) => c.tileId)).toEqual([
      176, 177, 178, 179,
      184, 185, 186, 187,
    ]);
  });

  it('skips the gaps in a ragged prop', () => {
    // Tree's bounding box is 2x2, but its bottom-right cell is a Bush — a
    // different prop that happens to sit in the corner.
    const tree = prop(OUTSIDE, 'Tree');
    expect(propShape(tree)).toEqual(['##', '#.']);
    expect(propCells(tree).map((c) => c.tileId)).toEqual([157, 158, 165]);
    expect(prop(OUTSIDE, 'Bush').topLeft).toBe(166);
  });

  it('lands every cell on a contiguous block of the sheet', () => {
    // The catalogue's whole addressing scheme rests on no prop straddling the
    // boundary between the sheet's two 8-wide halves, where +1 wraps across the
    // image. Checked against the corescript's own source-rect formula.
    for (const [sheet, entries] of Object.entries(PROP_SHEETS)) {
      const props = collectProps(['', '', '', '', '', sheet]);
      expect(props).toHaveLength(entries.length);
      for (const p of props) {
        const col0 = sourceColumn(p.topLeft);
        const row0 = sourceRow(p.topLeft);
        for (const cell of propCells(p)) {
          expect(sourceColumn(cell.tileId)).toBe(col0 + cell.dx);
          expect(sourceRow(cell.tileId)).toBe(row0 + cell.dy);
        }
      }
    }
  });

  it('has a mask exactly as long as the bounding box wherever one is given', () => {
    for (const entries of Object.values(PROP_SHEETS)) {
      for (const [, , width, height, mask] of entries) {
        if (mask === undefined) continue;
        expect(mask.length).toBe(width * height);
        expect(mask).toMatch(/^[01]+$/);
        expect(mask).toContain('0');   // a full box would not carry a mask
      }
    }
  });
});

describe('propGaps', () => {
  it('names the prop the sheet gives each gap to', () => {
    const props = collectProps(OUTSIDE);
    expect(propGaps(props, prop(OUTSIDE, 'Tree'))).toEqual([
      { dx: 1, dy: 1, filledBy: 'Bush' },
    ]);
    expect(propGaps(props, prop(OUTSIDE, 'Tent A'))).toEqual([
      { dx: 1, dy: 2, filledBy: 'Tent A (Entrance)' },
    ]);
  });

  it('reports nothing for a prop that fills its box', () => {
    const props = collectProps(OUTSIDE);
    expect(propGaps(props, prop(OUTSIDE, 'Large Tree'))).toEqual([]);
  });
});

describe('propPart', () => {
  it('takes the tree out of Tree without its canopy filler', () => {
    const tree = prop(OUTSIDE, 'Tree');
    const justTheTree = propPart(tree, { x: 0, y: 0, width: 1, height: 2 });
    expect(propCells(justTheTree).map((c) => c.tileId)).toEqual([157, 165]);
    expect(propShape(justTheTree)).toEqual(['#', '#']);
  });

  it('re-anchors topLeft on the part, not the original', () => {
    const largeTree = prop(OUTSIDE, 'Large Tree');
    const grove = propPart(largeTree, { x: 2, y: 0, width: 2, height: 2 });
    expect(grove.topLeft).toBe(178);
    expect(propCells(grove).map((c) => c.tileId)).toEqual([178, 179, 186, 187]);
  });

  it('refuses a part reaching outside the prop', () => {
    const tree = prop(OUTSIDE, 'Tree');
    expect(() => propPart(tree, { x: 1, y: 0, width: 2, height: 1 })).toThrow(PropError);
    expect(() => propPart(tree, { x: 0, y: 0, width: 2, height: 3 })).toThrow(/outside "Tree"/);
  });

  it('refuses a part that would place nothing', () => {
    // The bottom-right of Tree is the gap where the Bush sits.
    const tree = prop(OUTSIDE, 'Tree');
    expect(() => propPart(tree, { x: 1, y: 1, width: 1, height: 1 })).toThrow(/holds no tiles/);
  });
});

describe('cross-check against the roof sets derived by rendering', () => {
  /**
   * `OUTSIDE_C_ROOF_SETS` was worked out by rendering the sheet and looking at
   * it; the catalogue comes from the editor's own tile labels. They are two
   * independent derivations of the same fact, so they have to agree — and when
   * they did not, the labels were right: brown's extras sit below its block
   * rather than beside it, and it does have inner corners after all.
   */
  const ROOF_NAMES: Record<string, string> = {
    green: 'Roof A (Green Tile)',
    white: 'Roof B (Snow)',
    gold: 'Roof C (Yellow Tile)',
    brown: 'Roof D (Wood)',
  };

  it('puts every roof set inside the group the sheet labels for it', () => {
    const props = collectProps(OUTSIDE);
    for (const set of OUTSIDE_C_ROOF_SETS) {
      const labelled = findProps(props, ROOF_NAMES[set.name])[0];
      expect(labelled, set.name).toBeDefined();

      const owned = new Set(propCells(labelled).map((c) => c.tileId));
      // the 3x3 nine-slice block
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          expect(owned, `${set.name} ${col},${row}`).toContain(nineSliceTileId(set.topLeft, col, row));
        }
      }
      // and the inner corners, which belong to the same labelled group
      for (const corner of set.innerCorners ?? []) {
        expect(owned, `${set.name} inner corner ${corner}`).toContain(corner);
      }
    }
  });

  it('gives all four sets inner corners', () => {
    expect(OUTSIDE_C_ROOF_SETS.every((s) => s.innerCorners !== null)).toBe(true);
  });
});

describe('catalogue coverage', () => {
  it('names props on every object sheet the editor ships', () => {
    expect(Object.keys(PROP_SHEETS).length).toBeGreaterThanOrEqual(12);
    for (const [sheet, entries] of Object.entries(PROP_SHEETS)) {
      expect(entries.length, sheet).toBeGreaterThan(50);
    }
  });

  it('keeps every tile id inside its sheet', () => {
    for (const entries of Object.values(PROP_SHEETS)) {
      for (const [name, topLeft] of entries) {
        expect(topLeft, name).toBeGreaterThanOrEqual(0);
        expect(topLeft, name).toBeLessThan(256);
      }
    }
  });

  it('resolves props for each object slot', () => {
    for (const slot of OBJECT_SLOTS) {
      const names = new Array(9).fill('');
      names[slot] = 'Outside_B';
      const props = collectProps(names);
      expect(props.length).toBeGreaterThan(0);
      expect(props.every((p) => p.slot === slot)).toBe(true);
    }
  });
});
