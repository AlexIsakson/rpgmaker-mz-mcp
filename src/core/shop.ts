import type { EventCommand } from '../schemas/event.js';

/**
 * Shops.
 *
 * Unlike most of this server's measured behaviour, the sample here is thin:
 * across every MZ project on hand there are only **4 shop pages**, all in one
 * project, so "what a shop page looks like" cannot be settled by counting the
 * way the stair and door pages were. What *can* be settled exactly is the
 * encoding, because the engine's own interpreter defines it — and unlike art
 * direction, an interpreter is not a matter of taste:
 *
 *  - `Game_Interpreter.command302` builds `goods = [params]` and then pushes the
 *    parameters of every `605` that immediately follows, so **the 302 command's
 *    own parameters are the first goods row** rather than a list of rows. It
 *    passes `params[4]` as the scene's `purchaseOnly` flag, which is therefore a
 *    property of the shop and lives only on that first row.
 *  - `Window_ShopBuy.goodsToItem` switches on `goods[0]`: 0 items, 1 weapons,
 *    2 armours. `makeItemList` prices a row as `goods[2] === 0 ? item.price :
 *    goods[3]` — so price type 0 means "whatever the database says" and the
 *    price field is dead weight unless the type is 1.
 *  - **A row pointing at an id that does not exist is silently dropped.**
 *    `goodsToItem` returns `undefined` and `makeItemList` skips it, so a shop
 *    that has lost an item just shows a shorter list. Nothing reports it at
 *    runtime, which is why `check_project` grew a rule for it.
 *
 * The 4 measured pages agree with each other and with the above: all four are
 * Action Button, priority "same as characters", not through, `walkAnime` on,
 * and two of the four are exactly `101, 401, 302, 605` — a greeting, then the
 * shop. That is the shape {@link shopCommands} emits, but the page itself comes
 * from `npcgen`'s talking-NPC page, which rests on 70 samples rather than 4.
 *
 * This module is pure — it builds commands and picks stock, and never reads a file.
 */

const CODE_SHOP_PROCESSING = 302;
const CODE_SHOP_GOODS = 605;

/** `Window_ShopBuy.goodsToItem` switches on this. */
export const GOODS_KINDS = ['item', 'weapon', 'armor'] as const;
export type GoodsKind = (typeof GOODS_KINDS)[number];

export function goodsKindCode(kind: GoodsKind): number {
  return GOODS_KINDS.indexOf(kind);
}

export interface Goods {
  kind: GoodsKind;
  dataId: number;
  /**
   * Override the database price. Null or omitted uses the item's own price,
   * which is price type 0 — what every measured row does.
   */
  price?: number | null;
}

export class ShopError extends Error {}

/**
 * The `302` + `605` run for a list of goods.
 *
 * Refuses an empty list. The engine would accept it — `command302` happily
 * pushes a scene with one row — but a shop with nothing in it is never what the
 * caller meant, and the failure is invisible until someone talks to the
 * shopkeeper in game.
 */
export function shopCommands(goods: Goods[], purchaseOnly = false): EventCommand[] {
  if (goods.length === 0) {
    throw new ShopError(
      'A shop needs at least one row of goods. An empty list would open a shop ' +
        'window with nothing for sale, which nothing at runtime reports as wrong.'
    );
  }

  const row = (g: Goods): [number, number, number, number] => {
    if (!Number.isInteger(g.dataId) || g.dataId < 1) {
      throw new ShopError(
        `Goods id ${g.dataId} is not a database id. Ids start at 1 — index 0 of every ` +
          'database file is null.'
      );
    }
    if (g.price != null && g.price < 0) {
      throw new ShopError(`Goods id ${g.dataId} has a negative price (${g.price}).`);
    }
    // priceType 1 means "use the price field"; 0 means "ask the database".
    return g.price == null
      ? [goodsKindCode(g.kind), g.dataId, 0, 0]
      : [goodsKindCode(g.kind), g.dataId, 1, g.price];
  };

  const [first, ...rest] = goods;
  return [
    { code: CODE_SHOP_PROCESSING, indent: 0, parameters: [...row(first), purchaseOnly] },
    ...rest.map((g) => ({ code: CODE_SHOP_GOODS, indent: 0, parameters: row(g) })),
  ];
}

// --- choosing what a shop sells ---------------------------------------------

/** One row of a database file, reduced to what stocking a shop needs. */
export interface StockCandidate {
  id: number;
  name: string;
  price: number;
  /** `itypeId` for items; undefined for weapons and armours, which have none. */
  itypeId?: number;
}

/** `Window_ItemCategory` splits items on this: 1 regular, 2 key item. */
export const ITYPE_REGULAR = 1;
export const ITYPE_KEY_ITEM = 2;

/**
 * Whether an entry is something a shop could trade.
 *
 * The price test is the engine's, not ours: `Window_ShopSell.isEnabled` is
 * `item && item.price > 0`, so a price of 0 already means "not tradeable" to
 * MZ itself. It also excludes the `-----Recovery Items` separator rows the RTP
 * database is full of, which are real entries with real names and no price.
 *
 * Key items are excluded because the engine categorises them apart from
 * regular items, and a shop selling the plot coupon is a bug every time.
 */
export function isTradeable(entry: StockCandidate): boolean {
  if (!entry.name || entry.name.trim() === '') return false;
  if (entry.price <= 0) return false;
  if (entry.itypeId !== undefined && entry.itypeId !== ITYPE_REGULAR) return false;
  return true;
}

export interface StockOptions {
  /** How many rows the shop should end up with. */
  count: number;
  /**
   * Which slice of the tradeable range to stock, as fractions of the pool
   * sorted by price. `[0, 0.5]` is the cheaper half — a village store.
   */
  priceBand?: [number, number];
  minPrice?: number;
  maxPrice?: number;
}

/**
 * Pick a shop's stock from a database.
 *
 * Deliberately **not** random. A shop is a fixed part of a map, so the same
 * inputs should give the same shelf every time without a seed to carry around;
 * and "the cheap end of what exists" is a better village store than a uniform
 * sample of everything, which puts the endgame sword in the starting town.
 *
 * Sorting is by price and then by id, so entries that share a price keep a
 * stable order rather than depending on the sort's implementation.
 */
export function selectStock(
  pool: StockCandidate[],
  kind: GoodsKind,
  options: StockOptions
): Goods[] {
  const { count, priceBand = [0, 0.5], minPrice, maxPrice } = options;
  if (count < 0) throw new ShopError('count cannot be negative.');

  const [lo, hi] = priceBand;
  if (lo < 0 || hi > 1 || lo >= hi) {
    throw new ShopError(
      `priceBand [${lo}, ${hi}] must be two fractions with 0 <= lo < hi <= 1.`
    );
  }

  const tradeable = pool
    .filter(isTradeable)
    .filter((e) => (minPrice === undefined || e.price >= minPrice))
    .filter((e) => (maxPrice === undefined || e.price <= maxPrice))
    .sort((a, b) => a.price - b.price || a.id - b.id);

  if (tradeable.length === 0) return [];

  // The band is taken over the filtered pool, and always yields at least one
  // entry: a narrow band on a short pool would otherwise round down to nothing.
  const start = Math.floor(tradeable.length * lo);
  const end = Math.max(start + 1, Math.ceil(tradeable.length * hi));

  return tradeable
    .slice(start, end)
    .slice(0, count)
    .map((e) => ({ kind, dataId: e.id }));
}

/**
 * Read a database array as stock candidates. Index 0 is null in every MZ
 * database file, and deleted entries are null too.
 */
export function stockCandidates(database: unknown[]): StockCandidate[] {
  const out: StockCandidate[] = [];
  for (const row of database) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { id?: unknown; name?: unknown; price?: unknown; itypeId?: unknown };
    if (typeof r.id !== 'number' || typeof r.name !== 'string') continue;
    out.push({
      id: r.id,
      name: r.name,
      price: typeof r.price === 'number' ? r.price : 0,
      itypeId: typeof r.itypeId === 'number' ? r.itypeId : undefined,
    });
  }
  return out;
}

/** Human-readable summary of a stock list, for a tool's report. */
export function describeGoods(goods: Goods[], names: Map<string, string>): string[] {
  return goods.map((g) => {
    const name = names.get(`${g.kind}:${g.dataId}`) ?? `#${g.dataId}`;
    const price = g.price == null ? 'database price' : `${g.price}`;
    return `${g.kind} ${g.dataId} "${name}" (${price})`;
  });
}
