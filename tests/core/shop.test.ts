import { describe, it, expect } from 'vitest';
import {
  shopCommands,
  selectStock,
  stockCandidates,
  isTradeable,
  goodsKindCode,
  describeGoods,
  ShopError,
  type StockCandidate,
} from '../../src/core/shop.js';

/**
 * The encoding assertions here are against `Game_Interpreter.command302` and
 * `Window_ShopBuy` in the corescript, not against a count of sample events —
 * there are only four shop pages to hand, which is far too few to settle
 * anything by counting.
 */

const pool = (entries: [number, string, number, number?][]): StockCandidate[] =>
  entries.map(([id, name, price, itypeId]) => ({ id, name, price, itypeId }));

describe('shopCommands', () => {
  it('puts the first row in the 302 and the rest in 605s', () => {
    // command302 does `goods = [params]` then absorbs each following 605.
    const commands = shopCommands([
      { kind: 'item', dataId: 7 },
      { kind: 'weapon', dataId: 3 },
      { kind: 'armor', dataId: 9 },
    ]);
    expect(commands.map((c) => c.code)).toEqual([302, 605, 605]);
    expect(commands[0].parameters).toEqual([0, 7, 0, 0, false]);
    expect(commands[1].parameters).toEqual([1, 3, 0, 0]);
    expect(commands[2].parameters).toEqual([2, 9, 0, 0]);
  });

  it('carries purchaseOnly as the fifth parameter of the 302 only', () => {
    // SceneManager.prepareNextScene(goods, params[4]) — it is a property of the
    // shop, so a 605 has no room for it.
    const commands = shopCommands([{ kind: 'item', dataId: 7 }, { kind: 'item', dataId: 8 }], true);
    expect(commands[0].parameters[4]).toBe(true);
    expect(commands[1].parameters).toHaveLength(4);
  });

  it('uses price type 0 for a database price and 1 for an override', () => {
    // makeItemList: goods[2] === 0 ? item.price : goods[3]
    const [database] = shopCommands([{ kind: 'item', dataId: 7 }]);
    expect(database.parameters.slice(2, 4)).toEqual([0, 0]);

    const [override] = shopCommands([{ kind: 'item', dataId: 7, price: 25 }]);
    expect(override.parameters.slice(2, 4)).toEqual([1, 25]);
  });

  it('refuses an empty shop rather than opening an empty window', () => {
    expect(() => shopCommands([])).toThrow(ShopError);
  });

  it('refuses an id that cannot be a database row', () => {
    expect(() => shopCommands([{ kind: 'item', dataId: 0 }])).toThrow(/start at 1/);
    expect(() => shopCommands([{ kind: 'item', dataId: 1, price: -5 }])).toThrow(/negative/);
  });

  it('maps kinds the way goodsToItem switches on them', () => {
    expect(goodsKindCode('item')).toBe(0);
    expect(goodsKindCode('weapon')).toBe(1);
    expect(goodsKindCode('armor')).toBe(2);
  });
});

describe('isTradeable', () => {
  it('rejects the separator rows the RTP database is full of', () => {
    // `-----Recovery Items` is a real, named entry with no price. The engine's
    // own sell test is `item.price > 0`, so it already means "not tradeable".
    expect(isTradeable({ id: 6, name: '-----Recovery Items', price: 0, itypeId: 1 })).toBe(false);
    expect(isTradeable({ id: 7, name: 'Potion', price: 100, itypeId: 1 })).toBe(true);
  });

  it('rejects key items, which the engine categorises apart from goods', () => {
    expect(isTradeable({ id: 20, name: 'Gate Key', price: 500, itypeId: 2 })).toBe(false);
  });

  it('accepts weapons and armours, which have no itypeId at all', () => {
    expect(isTradeable({ id: 3, name: 'Sword', price: 500 })).toBe(true);
  });

  it('rejects an unnamed slot', () => {
    expect(isTradeable({ id: 4, name: '', price: 100 })).toBe(false);
    expect(isTradeable({ id: 5, name: '   ', price: 100 })).toBe(false);
  });
});

describe('selectStock', () => {
  const items = pool([
    [1, '-----Reserved', 0, 1],
    [7, 'Potion', 100, 1],
    [8, 'Super Potion', 250, 1],
    [9, 'Full Potion', 550, 1],
    [10, 'Magic Water', 300, 1],
    [20, 'Gate Key', 800, 2],
  ]);

  it('stocks the cheap end by default and skips what cannot be sold', () => {
    const goods = selectStock(items, 'item', { count: 10 });
    // four tradeable entries; the cheaper half is Potion and Super Potion
    expect(goods.map((g) => g.dataId)).toEqual([7, 8]);
    expect(goods.every((g) => g.kind === 'item')).toBe(true);
  });

  it('takes the dear end for a capital-city shop', () => {
    const goods = selectStock(items, 'item', { count: 10, priceBand: [0.5, 1] });
    expect(goods.map((g) => g.dataId)).toEqual([10, 9]);
  });

  it('caps at count', () => {
    expect(selectStock(items, 'item', { count: 1 })).toHaveLength(1);
  });

  it('never returns nothing when the pool has something in it', () => {
    // A narrow band on a short pool would otherwise round down to an empty slice.
    const one = pool([[7, 'Potion', 100, 1]]);
    expect(selectStock(one, 'item', { count: 5, priceBand: [0, 0.01] })).toHaveLength(1);
  });

  it('is stable when entries share a price', () => {
    const tied = pool([[9, 'B', 100, 1], [7, 'A', 100, 1], [8, 'C', 100, 1]]);
    expect(selectStock(tied, 'item', { count: 3, priceBand: [0, 1] }).map((g) => g.dataId))
      .toEqual([7, 8, 9]);
  });

  it('honours a price floor and ceiling', () => {
    const goods = selectStock(items, 'item', { count: 10, priceBand: [0, 1], minPrice: 250, maxPrice: 300 });
    expect(goods.map((g) => g.dataId)).toEqual([8, 10]);
  });

  it('returns nothing when the database has nothing tradeable', () => {
    expect(selectStock(pool([[1, '-----Reserved', 0, 1]]), 'item', { count: 4 })).toEqual([]);
  });

  it('refuses a nonsense band', () => {
    expect(() => selectStock(items, 'item', { count: 1, priceBand: [0.8, 0.2] })).toThrow(ShopError);
  });
});

describe('stockCandidates', () => {
  it('skips the null at index 0 and any deleted rows', () => {
    const candidates = stockCandidates([null, { id: 1, name: 'Potion', price: 100 }, null]);
    expect(candidates).toEqual([{ id: 1, name: 'Potion', price: 100, itypeId: undefined }]);
  });

  it('treats a missing price as zero rather than dropping the row', () => {
    expect(stockCandidates([{ id: 1, name: 'Odd' }])[0].price).toBe(0);
  });
});

describe('describeGoods', () => {
  it('names what it can and says so when it cannot', () => {
    const names = new Map([['item:7', 'Potion']]);
    expect(describeGoods([{ kind: 'item', dataId: 7 }, { kind: 'item', dataId: 8, price: 50 }], names))
      .toEqual(['item 7 "Potion" (database price)', 'item 8 "#8" (50)']);
  });
});
