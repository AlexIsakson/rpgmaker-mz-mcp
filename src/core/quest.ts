import type { MapEdge } from './map-graph.js';
import type { Item } from '../schemas/database.js';

/**
 * Joining the pieces up: the key that opens a particular door.
 *
 * Chests, shops, flags and locked doors all existed separately before this, and
 * nothing decided that *this* chest holds the key to *that* door. What makes
 * that more than a convenience wrapper is the failure it has to rule out: a key
 * placed behind the door it opens is unwinnable, and it is unwinnable silently —
 * the player wanders, finds nothing, and no rule in the engine or the editor
 * says a word.
 *
 * That check is a graph question, and the graph already exists (`map-graph.ts`).
 * Take the world's transfer edges, drop the ones belonging to the locked door,
 * and ask whether the key's map is still reachable from `startMapId`. If it is
 * not, the key is behind its own door.
 *
 * **Two limits are stated rather than hidden**, both inherited from the graph:
 *
 *  - Variable-driven transfers cannot be resolved statically, so a project that
 *    uses them may have routes this cannot see. The verdict then says the check
 *    is *unproven* rather than claiming a key is unreachable.
 *  - Edges come from Transfer Player commands, so a route that exists only
 *    through a plugin or a script call is invisible here too.
 *
 * This module is pure — it builds a database row and walks a graph, and never
 * reads a file.
 */

// --- the key item -----------------------------------------------------------

/**
 * What a door key looks like in the database.
 *
 * **This departs from the one key the corpus contains, on purpose.** `Wicked
 * Heart`'s "Inn Key" is `itypeId 1`, `consumable true`, `occasion 0` — an
 * ordinary item that happens to open a door — and that combination is a bug
 * waiting to happen: `Game_BattlerBase.isOccasionOk` accepts occasion 0 outside
 * battle, so the key is *usable* from the menu, and `Game_Party.consumeItem`
 * loses one of anything consumable when it is used. The player can eat the key
 * and lock themselves out of the game for good.
 *
 * So the defaults are taken from what the engine does with each field rather
 * than from the single sample:
 *
 *  - `itypeId: 2` files it under Key Items — `Window_ItemList.includes` splits
 *    the category on exactly this — and `$dataSystem.optKeyItemsNumber` then
 *    decides whether a count is shown beside it.
 *  - `occasion: 3` is "never": `isOccasionOk` returns false in *both* branches,
 *    in battle and out, so the item cannot be used and therefore cannot be
 *    consumed by being used.
 *  - `consumable: false` closes the same door from the other side.
 *  - `price: 0` keeps it out of shops and out of chests, because `isTradeable`
 *    — shared by `place_shop` and the loot table, and itself the engine's test
 *    from `Window_ShopSell.isEnabled` — requires a price above zero. A quest key
 *    cannot be sold to a merchant or turn up as random treasure.
 */
export const KEY_ITEM_FIELDS = {
  itypeId: 2,
  occasion: 3,
  consumable: false,
  price: 0,
} as const;

export interface KeyItemOptions {
  name: string;
  description?: string;
  /** Icon in the shipped IconSet. 195 is the key the measured project uses. */
  iconIndex?: number;
  note?: string;
}

export class QuestError extends Error {}

/** The fields to write over a default item row to make it a key. */
export function keyItemFields(options: KeyItemOptions): Partial<Item> {
  if (options.name.trim() === '') {
    throw new QuestError(
      'A key needs a name. An unnamed database row is what the RTP separator entries are, and ' +
        'the shop and loot filters both drop them.'
    );
  }
  return {
    ...KEY_ITEM_FIELDS,
    name: options.name,
    description: options.description ?? '',
    iconIndex: options.iconIndex ?? 195,
    note: options.note ?? '',
  };
}

// --- is the key behind its own door? ----------------------------------------

export interface DoorRef {
  mapId: number;
  eventId: number;
}

/**
 * The maps reachable from the start without using a particular event's
 * transfers.
 *
 * Only edges *belonging to the door* are dropped, not every edge between the
 * two maps: a second, unlocked way through means the key is reachable, and
 * saying otherwise would refuse a perfectly good placement.
 */
export function mapsReachableWithout(
  edges: MapEdge[],
  startMapId: number,
  door: DoorRef
): Set<number> {
  const usable = edges.filter(
    (e) => !(e.from === door.mapId && e.eventId === door.eventId)
  );

  const outgoing = new Map<number, number[]>();
  for (const edge of usable) {
    const list = outgoing.get(edge.from);
    if (list) list.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }

  const seen = new Set<number>([startMapId]);
  const stack = [startMapId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const next of outgoing.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }

  return seen;
}

/** What is being placed: the thing that opens the door. */
export type Opener = 'key' | 'lever';

export interface OpenerPlacementVerdict {
  /** False when the map cannot be reached without opening the door. */
  reachable: boolean;
  /**
   * False when something in the project makes the answer unprovable — a
   * variable-driven transfer could be the route this cannot see.
   */
  certain: boolean;
  /** Maps reachable without the door, for a report. */
  reachableMaps: Set<number>;
  message: string;
}

export interface OpenerPlacementInput {
  edges: MapEdge[];
  startMapId: number;
  door: DoorRef;
  /** The map the key or lever is going on. */
  placedOnMapId: number;
  /** True when the project has transfers whose destination is a variable. */
  hasDynamicTransfers: boolean;
  opener: Opener;
}

/**
 * Whether putting the thing that opens a door on `placedOnMapId` leaves the game
 * winnable.
 *
 * A key and a lever ask the identical question — *can this be got at without
 * the door it opens* — so they share the walk and differ only in wording. A
 * lever beyond its own gate is the shape people reach for deliberately (find
 * another way in, open the gate from inside), and that case passes here: it only
 * fails when there is no other route at all, which is a dead end either way.
 *
 * The door's own map is a special case worth being explicit about: standing in
 * front of a locked door is not the same as being through it, so placing on the
 * *near* side is fine and this reports it as such — the check is about the maps
 * the door leads to, not about the door's neighbourhood.
 */
export function checkOpenerPlacement(input: OpenerPlacementInput): OpenerPlacementVerdict {
  const { edges, startMapId, door, placedOnMapId, hasDynamicTransfers, opener } = input;

  const reachableMaps = mapsReachableWithout(edges, startMapId, door);
  const reachable = reachableMaps.has(placedOnMapId);

  if (reachable) {
    return {
      reachable: true,
      certain: true,
      reachableMaps,
      message:
        `Map ${placedOnMapId} is reachable from the start map without opening the door, so the ` +
        `${opener} can be ${opener === 'key' ? 'fetched' : 'reached'} before it is needed.`,
    };
  }

  if (hasDynamicTransfers) {
    return {
      reachable: false,
      certain: false,
      reachableMaps,
      message:
        `No route to map ${placedOnMapId} avoids the door — but this project has transfers whose ` +
        'destination comes from a variable, and those cannot be resolved statically. The route ' +
        'may exist and be invisible here.',
    };
  }

  return {
    reachable: false,
    certain: true,
    reachableMaps,
    message:
      `Map ${placedOnMapId} can only be reached by going through the door this ${opener} opens. ` +
      (opener === 'key'
        ? 'The player would need the key to reach the key, which no amount of exploring solves '
        : 'The player would need the door open to reach the lever that opens it, which no ' +
          'amount of exploring solves ') +
      'and nothing at runtime reports.',
  };
}
