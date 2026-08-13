import { describe, it, expect } from 'vitest';
import {
  withoutEntries,
  buildLootTable,
  dealLoot,
  gainCommand,
  lootText,
  LootError,
  type LootEntry,
} from '../../src/core/loot.js';
import type { StockCandidate } from '../../src/core/shop.js';

const pool = (entries: [number, string, number, number?][]): StockCandidate[] =>
  entries.map(([id, name, price, itypeId]) => ({ id, name, price, itypeId }));

const entry = (over: Partial<LootEntry> = {}): LootEntry => ({
  kind: 'item', dataId: 7, name: 'Potion', price: 100, amount: 1, ...over,
});

describe('gainCommand', () => {
  it('picks the command that matches the database', () => {
    // command126 gains $dataItems, 127 $dataWeapons, 128 $dataArmors.
    expect(gainCommand(entry({ kind: 'item' })).code).toBe(126);
    expect(gainCommand(entry({ kind: 'weapon' })).code).toBe(127);
    expect(gainCommand(entry({ kind: 'armor' })).code).toBe(128);
  });

  it('gives the equipment commands their fifth parameter and the item one none', () => {
    // 127/128 pass params[4] to gainItem as includeEquip; 126 takes four.
    expect(gainCommand(entry({ kind: 'item', dataId: 7, amount: 2 })).parameters)
      .toEqual([7, 0, 0, 2]);
    expect(gainCommand(entry({ kind: 'weapon', dataId: 3 })).parameters)
      .toEqual([3, 0, 0, 1, false]);
    expect(gainCommand(entry({ kind: 'armor', dataId: 9 })).parameters)
      .toEqual([9, 0, 0, 1, false]);
  });
});

describe('lootText', () => {
  it('colours the name with the escape the shipped pickups use', () => {
    expect(lootText(entry())).toBe('You found \\c[6]Potion\\c[0]!');
  });

  it('mentions a quantity only when there is more than one', () => {
    expect(lootText(entry({ amount: 3 }))).toBe('You found 3 \\c[6]Potion\\c[0]!');
  });
});

describe('buildLootTable', () => {
  const items = pool([
    [1, '-----Reserved', 0, 1],
    [7, 'Potion', 100, 1],
    [8, 'Super Potion', 250, 1],
    [9, 'Full Potion', 550, 1],
    [10, 'Magic Water', 300, 1],
    [20, 'Gate Key', 800, 2],
  ]);
  const weapons = pool([[1, 'Sword', 500], [2, 'Axe', 900]]);

  it('draws from the middle of the price range by default', () => {
    const table = buildLootTable({ items });
    // tradeable: 100, 250, 300, 550 — the middle half is 250 and 300
    expect(table.map((e) => e.dataId)).toEqual([8, 10]);
  });

  it('never offers a separator row or a key item', () => {
    const table = buildLootTable({ items }, { priceBand: [0, 1] });
    expect(table.map((e) => e.dataId)).not.toContain(1);
    expect(table.map((e) => e.dataId)).not.toContain(20);
  });

  it('bands each database separately so one does not swamp the others', () => {
    // Armours outnumber items four to one in the RTP database; a shared band
    // would be almost entirely armour.
    const table = buildLootTable({ items, weapons }, { priceBand: [0, 1] });
    expect(table.filter((e) => e.kind === 'item')).toHaveLength(4);
    expect(table.filter((e) => e.kind === 'weapon')).toHaveLength(2);
  });

  it('honours a restriction to certain databases', () => {
    const table = buildLootTable({ items, weapons }, { kinds: ['weapon'], priceBand: [0, 1] });
    expect(table.every((e) => e.kind === 'weapon')).toBe(true);
  });

  it('comes back empty rather than inventing something', () => {
    expect(buildLootTable({ items: pool([[1, '-----Reserved', 0, 1]]) })).toEqual([]);
  });

  it('refuses a nonsense band', () => {
    expect(() => buildLootTable({ items }, { priceBand: [1, 0] })).toThrow(LootError);
  });
});

describe('dealLoot', () => {
  const table: LootEntry[] = [
    entry({ dataId: 7, name: 'Potion' }),
    entry({ dataId: 8, name: 'Super Potion' }),
    entry({ dataId: 9, name: 'Full Potion' }),
    entry({ dataId: 10, name: 'Magic Water' }),
  ];

  it('never repeats while the table still has something in it', () => {
    // Independent rolls would collide well before the table ran out, and two
    // identical chests in one dungeon reads as a bug.
    const dealt = dealLoot(table, 4, 1);
    expect(new Set(dealt.map((e) => e.dataId)).size).toBe(4);
  });

  it('is deterministic per seed and varies between seeds', () => {
    expect(dealLoot(table, 4, 5)).toEqual(dealLoot(table, 4, 5));
    const seeds = new Set(
      [1, 2, 3, 4, 5, 6].map((s) => dealLoot(table, 4, s).map((e) => e.dataId).join(','))
    );
    expect(seeds.size).toBeGreaterThan(1);
  });

  it('cycles rather than running dry when more chests than rewards are asked for', () => {
    const dealt = dealLoot(table, 6, 3);
    expect(dealt).toHaveLength(6);
    expect(dealt.every((e) => e !== undefined)).toBe(true);
    // the first four still cover the whole table before any repeat
    expect(new Set(dealt.slice(0, 4).map((e) => e.dataId)).size).toBe(4);
  });

  it('deals nothing for no chests, and refuses an empty table', () => {
    expect(dealLoot(table, 0, 1)).toEqual([]);
    expect(() => dealLoot([], 1, 1)).toThrow(LootError);
  });
});

describe('withoutEntries', () => {
  const table: LootEntry[] = [
    { kind: 'item', dataId: 7, name: 'Potion', price: 100, amount: 1 },
    { kind: 'weapon', dataId: 7, name: 'Sword', price: 500, amount: 1 },
    { kind: 'armor', dataId: 3, name: 'Shield', price: 300, amount: 1 },
  ];

  it('drops only the exact entry, database and all', () => {
    // item 7 and weapon 7 are different things; dropping both for one id would
    // quietly shrink the table.
    const left = withoutEntries(table, [{ kind: 'item', dataId: 7 }]);
    expect(left.map((e) => `${e.kind}:${e.dataId}`)).toEqual(['weapon:7', 'armor:3']);
  });

  it('returns the table untouched when nothing is used', () => {
    expect(withoutEntries(table, [])).toBe(table);
  });

  it('can empty the table, which the caller has to handle', () => {
    const used = table.map((e) => ({ kind: e.kind, dataId: e.dataId }));
    expect(withoutEntries(table, used)).toEqual([]);
  });
});
