import { describe, it, expect } from 'vitest';
import {
  keyItemFields,
  mapsReachableWithout,
  checkKeyPlacement,
  KEY_ITEM_FIELDS,
  QuestError,
} from '../../src/core/quest.js';
import { isTradeable } from '../../src/core/shop.js';
import type { MapEdge } from '../../src/core/map-graph.js';

/**
 * The key-item fields are asserted against `Window_ItemList.includes`,
 * `Game_BattlerBase.isOccasionOk` and `Game_Party.consumeItem`; the graph walk
 * against the one bug it exists to prevent — a key that can only be reached by
 * opening the door it unlocks.
 */

const edge = (from: number, to: number, eventId: number): MapEdge => ({
  from,
  to,
  x: 0,
  y: 0,
  eventId,
  eventName: `Door${eventId}`,
});

describe('keyItemFields', () => {
  it('writes a key that cannot be used, consumed or sold', () => {
    const fields = keyItemFields({ name: 'Cellar Key' });
    // itypeId 2 is the Key Items category; occasion 3 is refused by
    // isOccasionOk in battle and out; consumable false closes the same door
    // from the other side; price 0 fails isTradeable.
    expect(fields).toMatchObject({ itypeId: 2, occasion: 3, consumable: false, price: 0 });
    expect(fields.name).toBe('Cellar Key');
  });

  it('produces something the shop and loot filters both reject', () => {
    // Not a coincidence worth leaving untested: isTradeable is shared by
    // place_shop and buildLootTable, so a key can never be sold or found in a
    // random chest.
    const fields = keyItemFields({ name: 'Cellar Key' });
    expect(
      isTradeable({ id: 1, name: fields.name!, price: fields.price!, itypeId: fields.itypeId })
    ).toBe(false);
  });

  it('defaults the icon to a key and leaves text empty', () => {
    expect(keyItemFields({ name: 'Cellar Key' })).toMatchObject({
      iconIndex: 195,
      description: '',
      note: '',
    });
  });

  it('refuses a nameless key', () => {
    expect(() => keyItemFields({ name: '   ' })).toThrow(QuestError);
  });

  it('exports the engine-derived fields for reuse', () => {
    expect(KEY_ITEM_FIELDS).toEqual({ itypeId: 2, occasion: 3, consumable: false, price: 0 });
  });
});

describe('mapsReachableWithout', () => {
  it('walks the graph forwards from the start', () => {
    const edges = [edge(1, 2, 5), edge(2, 3, 6)];
    expect([...mapsReachableWithout(edges, 1, { mapId: 9, eventId: 9 })].sort()).toEqual([1, 2, 3]);
  });

  it('drops only the door being tested', () => {
    const edges = [edge(1, 2, 5), edge(2, 3, 6)];
    // event 6 on map 2 is the locked door: map 3 is behind it.
    expect([...mapsReachableWithout(edges, 1, { mapId: 2, eventId: 6 })].sort()).toEqual([1, 2]);
  });

  it('keeps a second, unlocked way through', () => {
    // Two doors between the same pair of maps: removing the locked one leaves
    // the other, and refusing the placement would be wrong.
    const edges = [edge(1, 2, 5), edge(1, 2, 7)];
    expect(mapsReachableWithout(edges, 1, { mapId: 1, eventId: 5 }).has(2)).toBe(true);
  });

  it('does not walk an edge backwards', () => {
    // Transfers are one-way in the data; a way in is not a way out.
    expect(mapsReachableWithout([edge(2, 1, 5)], 1, { mapId: 9, eventId: 9 }).has(2)).toBe(false);
  });

  it('survives a cycle', () => {
    const edges = [edge(1, 2, 5), edge(2, 1, 6)];
    expect([...mapsReachableWithout(edges, 1, { mapId: 9, eventId: 9 })].sort()).toEqual([1, 2]);
  });
});

describe('checkKeyPlacement', () => {
  const edges = [edge(1, 2, 5), edge(2, 3, 6)];
  const door = { mapId: 2, eventId: 6 };

  it('passes a key on a map reachable without the door', () => {
    const verdict = checkKeyPlacement({
      edges, startMapId: 1, door, keyMapId: 1, hasDynamicTransfers: false,
    });
    expect(verdict).toMatchObject({ reachable: true, certain: true });
  });

  it('passes a key on the door\'s own map — standing in front of it is not being through it', () => {
    const verdict = checkKeyPlacement({
      edges, startMapId: 1, door, keyMapId: 2, hasDynamicTransfers: false,
    });
    expect(verdict.reachable).toBe(true);
  });

  it('catches a key behind the door it opens', () => {
    const verdict = checkKeyPlacement({
      edges, startMapId: 1, door, keyMapId: 3, hasDynamicTransfers: false,
    });
    expect(verdict).toMatchObject({ reachable: false, certain: true });
    expect(verdict.message).toContain('the key to reach the key');
  });

  it('will not claim certainty when transfers are variable-driven', () => {
    // The route may exist and be invisible to static analysis, so the verdict
    // stops short of "unwinnable" rather than refusing on a guess.
    const verdict = checkKeyPlacement({
      edges, startMapId: 1, door, keyMapId: 3, hasDynamicTransfers: true,
    });
    expect(verdict).toMatchObject({ reachable: false, certain: false });
    expect(verdict.message).toContain('variable');
  });

  it('reports what is reachable, for a caller that has to choose again', () => {
    const verdict = checkKeyPlacement({
      edges, startMapId: 1, door, keyMapId: 3, hasDynamicTransfers: false,
    });
    expect([...verdict.reachableMaps].sort()).toEqual([1, 2]);
  });
});
