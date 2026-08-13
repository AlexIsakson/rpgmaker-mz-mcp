import { makeRng } from './mapgen.js';
import {
  isTradeable,
  type GoodsKind,
  type StockCandidate,
} from './shop.js';
import type { EventCommand } from '../schemas/event.js';

/**
 * What is in the chest.
 *
 * `decorate_dungeon` used to hand over item id 1 every time. In the RTP
 * database id 1 is `-----Reserved`, a separator row with no price — so the
 * default chest gave the player a nameless nothing, and every chest on a floor
 * gave the same nameless nothing.
 *
 * Two engine facts do the work here, both read off the corescript rather than
 * guessed:
 *
 *  - **Which command hands the item over depends on the database.**
 *    `command126` gains `$dataItems[params[0]]`, `command127` `$dataWeapons`
 *    and `command128` `$dataArmors`, and the two equipment ones take a fifth
 *    parameter, `includeEquip`. Emitting 126 for a weapon id silently gives the
 *    player whichever *item* shares that number — the existing chest could only
 *    ever contain an item, despite its options claiming otherwise.
 *  - **`price > 0` is the engine's own test for a real, tradeable entry**
 *    (`Window_ShopSell.isEnabled`), which is what separates a usable reward from
 *    a separator row. {@link isTradeable} is shared with the shop stocking code
 *    for exactly that reason.
 *
 * What is *not* measured is which items belong in a chest — nothing in a
 * project's data says "this is treasure". So the rule is stated rather than
 * discovered: draw from a price band, and never repeat within a floor.
 *
 * This module is pure — it picks rewards and builds commands, and never reads a file.
 */

const CODE_CHANGE_ITEMS = 126;
const CODE_CHANGE_WEAPONS = 127;
const CODE_CHANGE_ARMORS = 128;

/** `Game_Interpreter.operateValue`: 0 gains, 1 loses. */
const OPERATION_GAIN = 0;
/** 0 takes the operand as a constant, 1 reads it from a variable. */
const OPERAND_CONSTANT = 0;

export interface LootEntry {
  kind: GoodsKind;
  dataId: number;
  name: string;
  price: number;
  amount: number;
}

export class LootError extends Error {}

/**
 * The command that puts one reward in the player's bag.
 *
 * `includeEquip` is false: the flag tells `gainItem` it may pull the item out
 * of a party member's equipment slots to satisfy a *loss*, which is meaningless
 * when gaining and is false in the shipped pickup events.
 */
export function gainCommand(entry: LootEntry): EventCommand {
  const base = [entry.dataId, OPERATION_GAIN, OPERAND_CONSTANT, entry.amount];
  switch (entry.kind) {
    case 'item':
      return { code: CODE_CHANGE_ITEMS, indent: 0, parameters: base };
    case 'weapon':
      return { code: CODE_CHANGE_WEAPONS, indent: 0, parameters: [...base, false] };
    case 'armor':
      return { code: CODE_CHANGE_ARMORS, indent: 0, parameters: [...base, false] };
  }
}

/**
 * The line the chest says.
 *
 * `\c[6]` switches the message colour and `\c[0]` switches it back — the
 * escape the shipped pickup events use to pick the item's name out of the
 * sentence. A quantity is only mentioned when there is more than one, because
 * "You found 1 Potion" reads like a placeholder.
 */
export function lootText(entry: LootEntry): string {
  const name = `\\c[6]${entry.name}\\c[0]`;
  return entry.amount > 1
    ? `You found ${entry.amount} ${name}!`
    : `You found ${name}!`;
}

export interface LootPools {
  items?: StockCandidate[];
  weapons?: StockCandidate[];
  armors?: StockCandidate[];
}

export interface LootTableOptions {
  /**
   * Which slice of the tradeable range chests draw from, as fractions of the
   * pool sorted by price. Defaults to the middle half: the cheap end is what
   * the shop already sells, and the top end is not a corridor find.
   */
  priceBand?: [number, number];
  /** Restrict to these databases. Defaults to all three. */
  kinds?: GoodsKind[];
  minPrice?: number;
  maxPrice?: number;
}

/**
 * Everything a chest on this floor could hold, cheapest first.
 *
 * Kept separate from the roll so a caller can see the pool it is drawing from —
 * an empty one means the project's database has nothing tradeable, which is
 * worth reporting rather than silently falling back to a hardcoded id.
 */
export function buildLootTable(
  pools: LootPools,
  options: LootTableOptions = {}
): LootEntry[] {
  const { priceBand = [0.25, 0.75], kinds, minPrice, maxPrice } = options;

  const [lo, hi] = priceBand;
  if (lo < 0 || hi > 1 || lo >= hi) {
    throw new LootError(
      `priceBand [${lo}, ${hi}] must be two fractions with 0 <= lo < hi <= 1.`
    );
  }

  const wanted = new Set<GoodsKind>(kinds ?? ['item', 'weapon', 'armor']);
  const byKind: [GoodsKind, StockCandidate[]][] = [
    ['item', pools.items ?? []],
    ['weapon', pools.weapons ?? []],
    ['armor', pools.armors ?? []],
  ];

  const table: LootEntry[] = [];
  for (const [kind, pool] of byKind) {
    if (!wanted.has(kind)) continue;

    const tradeable = pool
      .filter(isTradeable)
      .filter((e) => minPrice === undefined || e.price >= minPrice)
      .filter((e) => maxPrice === undefined || e.price <= maxPrice)
      .sort((a, b) => a.price - b.price || a.id - b.id);
    if (tradeable.length === 0) continue;

    // The band is taken per database rather than over the three combined:
    // armours outnumber items four to one in the RTP database, so a shared
    // band would be almost entirely armour.
    const start = Math.floor(tradeable.length * lo);
    const end = Math.max(start + 1, Math.ceil(tradeable.length * hi));

    for (const e of tradeable.slice(start, end)) {
      table.push({ kind, dataId: e.id, name: e.name, price: e.price, amount: 1 });
    }
  }

  return table.sort((a, b) => a.price - b.price || a.kind.localeCompare(b.kind) || a.dataId - b.dataId);
}

/**
 * Deal `count` rewards from a table without repeating one.
 *
 * Chests are dealt from a shuffled copy rather than rolled independently: with
 * six chests and independent rolls, two the same is likelier than not, and two
 * identical chests in one dungeon reads as a bug even though each roll was
 * fair. Asking for more chests than the table holds cycles it — reusing a
 * reward is better than a chest that gives nothing.
 */
export function dealLoot(table: LootEntry[], count: number, seed: number): LootEntry[] {
  if (count <= 0) return [];
  if (table.length === 0) {
    throw new LootError(
      'The loot table is empty: no entry in the chosen databases has a name and a ' +
        'price above zero. Widen priceBand, or check the project actually has items.'
    );
  }

  const rng = makeRng(seed);
  const out: LootEntry[] = [];
  let bag: LootEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (bag.length === 0) {
      bag = [...table];
      for (let j = bag.length - 1; j > 0; j--) {
        const k = Math.floor(rng() * (j + 1));
        [bag[j], bag[k]] = [bag[k], bag[j]];
      }
    }
    out.push(bag.pop()!);
  }

  return out;
}
