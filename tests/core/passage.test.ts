import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  SLOTS,
  FLAGS_LENGTH,
  expandRuns,
  sheetPassage,
  catalogueSheetNames,
  normaliseFlags,
  planTilesetPassage,
  applyTilesetPassage,
  setPassageFlags,
  describeFlag,
  PassageError,
} from '../../src/core/passage.js';
import { PASSAGE_SHEETS } from '../../src/core/passage-catalogue.js';
import { FLAG_STAR, FLAG_LADDER, FLAG_BUSH, PASSAGE_BIT } from '../../src/core/map-grid.js';

const REFERENCE =
  'C:/Program Files (x86)/Steam/steamapps/common/RPG Maker MZ/newdata/data/Tilesets.json';

describe('slot ranges', () => {
  it('covers every tile id exactly once, with the unused block left over', () => {
    const owner = new Array<string | null>(FLAGS_LENGTH).fill(null);
    for (const slot of SLOTS) {
      for (let i = 0; i < slot.count; i++) {
        expect(owner[slot.start + i]).toBeNull(); // no slot overlaps another
        owner[slot.start + i] = slot.name;
      }
    }
    // 1024..1535 is the gap MZ leaves between the object sheets and A5.
    const unowned = owner.map((o, i) => (o === null ? i : -1)).filter((i) => i >= 0);
    expect(unowned[0]).toBe(1024);
    expect(unowned[unowned.length - 1]).toBe(1535);
    expect(unowned).toHaveLength(512);
  });
});

describe('the catalogue', () => {
  it('holds every sheet the RTP tilesets use', () => {
    for (const sheet of ['Outside_A2', 'Dungeon_B', 'Inside_A4', 'World_A1', 'SF_Outside_C']) {
      expect(sheetPassage(sheet)).toBeDefined();
    }
    expect(catalogueSheetNames().length).toBeGreaterThan(50);
  });

  it('expands to exactly the tile count of the slot it belongs to', () => {
    for (const [name, entry] of Object.entries(PASSAGE_SHEETS)) {
      const slot = SLOTS.find((s) => s.name === entry.slot);
      expect({ name, slot: entry.slot, found: slot !== undefined })
        .toEqual({ name, slot: entry.slot, found: true });
      expect({ name, length: expandRuns(entry.runs).length })
        .toEqual({ name, length: slot!.count });
    }
  });

  it('marks tile 0 as a star tile, which is what the whole feature turns on', () => {
    // Without it, passage resolves on the empty upper layers and everything is
    // walkable — the exact bug configure_tileset_passage exists to fix.
    const b = sheetPassage('Outside_B')!;
    expect(expandRuns(b.runs)[0] & FLAG_STAR).toBe(FLAG_STAR);
  });
});

// The catalogue is generated from the editor's own databases, so the strongest
// available check is that planning against a configured tileset asks for no
// change at all. Skipped where the editor is not installed.
const haveReference = fs.existsSync(REFERENCE);
describe.skipIf(!haveReference)('against the editor\'s own tilesets', () => {
  const tilesets: { id: number; name: string; flags: number[]; tilesetNames: string[] }[] =
    haveReference ? JSON.parse(fs.readFileSync(REFERENCE, 'utf8')).filter(Boolean) : [];

  const configured = () =>
    tilesets.filter((t) => t.flags?.length >= FLAGS_LENGTH && (t.flags[0] & FLAG_STAR) !== 0);

  /** The lowest-id tileset using a sheet is the one the catalogue took it from. */
  const ownerOf = (sheet: string) => {
    for (const ts of [...configured()].sort((a, b) => a.id - b.id)) {
      if (ts.tilesetNames.includes(sheet)) return ts.id;
    }
    return -1;
  };

  it('knows every sheet the shipped tilesets use', () => {
    for (const ts of configured()) {
      const plan = planTilesetPassage(ts.tilesetNames, ts.flags);
      expect({ name: ts.name, unknown: plan.unknown.map((u) => u.sheetName) })
        .toEqual({ name: ts.name, unknown: [] });
    }
    expect(configured().length).toBeGreaterThanOrEqual(6);
  });

  it('reproduces each sheet exactly for the tileset it was taken from', () => {
    // Where two tilesets share a sheet and configure it differently, the
    // catalogue keeps the lower-id one — so only the borrower can differ, and
    // that is the whole of the divergence the generator reports.
    let exact = 0;
    for (const ts of configured()) {
      const plan = planTilesetPassage(ts.tilesetNames, ts.flags);
      for (const slotPlan of plan.slots) {
        if (ownerOf(slotPlan.sheetName) !== ts.id) continue; // borrowed, may differ
        expect({ tileset: ts.name, sheet: slotPlan.sheetName, changed: slotPlan.changed })
          .toEqual({ tileset: ts.name, sheet: slotPlan.sheetName, changed: 0 });
        exact++;
      }
    }
    expect(exact).toBeGreaterThan(30);
  });

  it('leaves only borrowed sheets differing, and names which', () => {
    const differing = configured()
      .map((ts) => ({ name: ts.name, changed: planTilesetPassage(ts.tilesetNames, ts.flags).changed }))
      .filter((r) => r.changed > 0);
    // SF Inside borrows Inside_A1, Inside_A2 and SF_Outside_A5 — 48 + 48 + 2.
    expect(differing).toEqual([{ name: 'SF Inside', changed: 98 }]);
  });

  it('rebuilds a wiped tileset back to the editor\'s own flags', () => {
    const outside = tilesets.find((t) => t.name === 'Outside')!;
    // The failure this fixes: flags reset to the unconfigured default.
    const broken = new Array<number>(FLAGS_LENGTH).fill(0);

    const plan = planTilesetPassage(outside.tilesetNames, broken);
    const rebuilt = applyTilesetPassage(broken, plan);

    // Compared over the ranges the tileset's own sheets occupy. Two regions
    // cannot be restored and do not need to be: tiles 1024-1535 are the gap MZ
    // leaves between the object sheets and A5, and Outside leaves slots D and E
    // unset. Nothing can paint a tile from either, so their flags never resolve.
    expect(plan.slots.map((s) => s.slot.name)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'B', 'C']);
    for (const { slot } of plan.slots) {
      expect({ slot: slot.name, flags: rebuilt.slice(slot.start, slot.start + slot.count) })
        .toEqual({ slot: slot.name, flags: outside.flags.slice(slot.start, slot.start + slot.count) });
    }
    expect(rebuilt[0] & FLAG_STAR).toBe(FLAG_STAR);
  });
});

describe('planTilesetPassage', () => {
  it('reports a sheet it has never seen instead of guessing', () => {
    const plan = planTilesetPassage(
      ['', 'MyCustom_A2', '', '', '', '', '', '', ''],
      new Array<number>(FLAGS_LENGTH).fill(0)
    );
    expect(plan.slots).toHaveLength(0);
    expect(plan.unknown.map((u) => u.sheetName)).toEqual(['MyCustom_A2']);
    expect(plan.changed).toBe(0);
  });

  it('counts empty slots separately from unknown ones', () => {
    const plan = planTilesetPassage(
      ['', '', '', '', '', 'Outside_B', '', '', ''],
      new Array<number>(FLAGS_LENGTH).fill(0)
    );
    expect(plan.slots.map((s) => s.sheetName)).toEqual(['Outside_B']);
    expect(plan.unknown).toHaveLength(0);
    expect(plan.empty.map((s) => s.name)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'C', 'D', 'E']);
  });

  it('moves an object sheet to whichever of B-E it is actually used in', () => {
    // The object slots are interchangeable, so a project may put Outside_C in D.
    const plan = planTilesetPassage(
      ['', '', '', '', '', '', '', 'Outside_C', ''],
      new Array<number>(FLAGS_LENGTH).fill(0)
    );
    expect(plan.slots).toHaveLength(1);
    expect(plan.slots[0].slot.name).toBe('D');
    expect(plan.slots[0].borrowedFromSlot).toBe('C');

    const flags = applyTilesetPassage(new Array<number>(FLAGS_LENGTH).fill(0), plan);
    const catalogued = expandRuns(sheetPassage('Outside_C')!.runs);
    expect(flags.slice(512, 512 + 256)).toEqual(catalogued);
  });
});

describe('normaliseFlags', () => {
  it('pads a short array rather than letting it become NaN', () => {
    // A tileset seen in the wild carried 1536 of 8192 entries.
    const short = new Array<number>(1536).fill(0x0e);
    const flags = normaliseFlags(short);
    expect(flags).toHaveLength(FLAGS_LENGTH);
    expect(flags[1535]).toBe(0x0e);
    expect(flags[8191]).toBe(0);
    expect(flags.every((f) => Number.isFinite(f))).toBe(true);
  });
});

describe('setPassageFlags', () => {
  const blank = () => new Array<number>(FLAGS_LENGTH).fill(0);

  it('stores passability inverted, because a set bit means blocked', () => {
    const all = PASSAGE_BIT.down | PASSAGE_BIT.left | PASSAGE_BIT.right | PASSAGE_BIT.up;
    expect(setPassageFlags(blank(), [5], { passable: false }).flags[5] & all).toBe(all);
    expect(setPassageFlags(blank(), [5], { passable: true }).flags[5] & all).toBe(0);
  });

  it('sets one direction without disturbing the others', () => {
    const blocked = setPassageFlags(blank(), [5], { passable: false }).flags;
    const opened = setPassageFlags(blocked, [5], { up: true }).flags;
    expect(opened[5] & PASSAGE_BIT.up).toBe(0);
    expect(opened[5] & PASSAGE_BIT.down).toBe(PASSAGE_BIT.down);
    expect(opened[5] & PASSAGE_BIT.left).toBe(PASSAGE_BIT.left);
  });

  it('toggles the property flags the normal way round', () => {
    const on = setPassageFlags(blank(), [7], { star: true, ladder: true, bush: true }).flags;
    expect(on[7] & FLAG_STAR).toBe(FLAG_STAR);
    expect(on[7] & FLAG_LADDER).toBe(FLAG_LADDER);
    const off = setPassageFlags(on, [7], { ladder: false }).flags;
    expect(off[7] & FLAG_LADDER).toBe(0);
    expect(off[7] & FLAG_BUSH).toBe(FLAG_BUSH); // untouched
  });

  it('replaces the terrain tag rather than or-ing into it', () => {
    const first = setPassageFlags(blank(), [9], { terrainTag: 7 }).flags;
    expect(first[9] >>> 12).toBe(7);
    const second = setPassageFlags(first, [9], { terrainTag: 2 }).flags;
    expect(second[9] >>> 12).toBe(2);
  });

  it('leaves every other tile alone', () => {
    const flags = setPassageFlags(blank(), [100], { passable: false }).flags;
    expect(flags.filter((f) => f !== 0)).toHaveLength(1);
  });

  it('counts only tiles whose value actually changed', () => {
    const once = setPassageFlags(blank(), [1, 2, 3], { passable: false });
    expect(once.changed).toBe(3);
    const again = setPassageFlags(once.flags, [1, 2, 3], { passable: false });
    expect(again.changed).toBe(0);
  });

  it('discards out-of-range ids instead of growing the array', () => {
    const result = setPassageFlags(blank(), [10, -1, FLAGS_LENGTH, 8191], { passable: false });
    expect(result.outOfRange).toEqual([-1, FLAGS_LENGTH]);
    expect(result.flags).toHaveLength(FLAGS_LENGTH);
    expect(result.changed).toBe(2);
  });

  it('refuses a terrain tag outside 0-7', () => {
    expect(() => setPassageFlags(blank(), [1], { terrainTag: 9 })).toThrow(PassageError);
  });
});

describe('describeFlag', () => {
  it('reads passability out the way a person would say it', () => {
    expect(describeFlag(0x00)).toBe('passable');
    expect(describeFlag(0x0f)).toBe('impassable');
    expect(describeFlag(0x06)).toContain('blocked left/right');
    expect(describeFlag(0x10)).toContain('star');
    expect(describeFlag(0x0f | 0x20)).toContain('ladder');
    expect(describeFlag(3 << 12)).toContain('terrain 3');
  });
});
