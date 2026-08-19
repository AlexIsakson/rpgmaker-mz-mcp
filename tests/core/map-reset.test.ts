import { describe, it, expect } from 'vitest';
import {
  censusMap,
  clearMap,
  describeKeptContent,
  PLANE_NAMES,
  TOTAL_LAYERS,
} from '../../src/core/map-reset.js';
import { tileIndex } from '../../src/core/map-layers.js';
import type { MapData } from '../../src/schemas/map.js';

/**
 * The rule under test: a generator that says it replaces a map has to replace
 * all six planes, not just the one it paints. The counts here are structural —
 * the measured evidence for why this matters (139 cells of one town surviving
 * into the next) lives in the module comment and the roadmap.
 */
function emptyMap(width = 4, height = 3): MapData {
  return {
    width,
    height,
    data: new Array(width * height * TOTAL_LAYERS).fill(0),
    events: [null],
    tilesetId: 1,
  } as unknown as MapData;
}

const put = (map: MapData, x: number, y: number, z: number, tileId: number) => {
  map.data[tileIndex(map.width, map.height, x, y, z)] = tileId;
};

const anEvent = (id: number, x: number, y: number) =>
  ({ id, name: `E${id}`, note: '', pages: [], x, y }) as unknown as MapData['events'][number];

describe('censusMap', () => {
  it('counts every plane separately, including shadow and region', () => {
    const map = emptyMap();
    put(map, 0, 0, 0, 2816);
    put(map, 1, 0, 0, 2816);
    put(map, 2, 1, 2, 409);
    put(map, 3, 2, 4, 5);     // shadow
    put(map, 0, 1, 5, 12);    // region

    const census = censusMap(map);
    expect(census.planes).toHaveLength(TOTAL_LAYERS);
    expect(census.planes.map((p) => p.filled)).toEqual([2, 0, 1, 0, 1, 1]);
    expect(census.filledTotal).toBe(5);
    expect(census.planes.map((p) => p.name)).toEqual([...PLANE_NAMES]);
  });

  it('counts the events, not counting the leading null slot', () => {
    const map = emptyMap();
    map.events = [null, anEvent(1, 0, 0), anEvent(2, 1, 1)];
    expect(censusMap(map).events).toBe(2);
  });

  it('leaves out the planes it is told to ignore', () => {
    const map = emptyMap();
    put(map, 0, 0, 0, 2816);
    put(map, 1, 1, 2, 409);

    // A generator about to overwrite layer 0 should not report layer 0 as
    // something it is going to strand.
    const census = censusMap(map, [0]);
    expect(census.planes).toHaveLength(TOTAL_LAYERS - 1);
    expect(census.planes.some((p) => p.z === 0)).toBe(false);
    expect(census.filledTotal).toBe(1);
  });

  it('reports nothing on a map that is already empty', () => {
    const census = censusMap(emptyMap());
    expect(census.filledTotal).toBe(0);
    expect(census.events).toBe(0);
  });
});

describe('clearMap', () => {
  it('empties all six planes by default and returns what it cleared', () => {
    const map = emptyMap();
    for (let z = 0; z < TOTAL_LAYERS; z++) put(map, 0, 0, z, 100 + z);

    expect(clearMap(map)).toBe(TOTAL_LAYERS);
    expect(censusMap(map).filledTotal).toBe(0);
    expect(map.data.every((t) => t === 0)).toBe(true);
  });

  it('clears only the named planes', () => {
    const map = emptyMap();
    put(map, 0, 0, 0, 2816);
    put(map, 0, 0, 2, 409);
    put(map, 0, 0, 4, 5);

    expect(clearMap(map, { planes: [2, 4] })).toBe(2);
    const census = censusMap(map);
    expect(census.planes[0].filled).toBe(1);   // layer 0 untouched
    expect(census.planes[2].filled).toBe(0);
    expect(census.planes[4].filled).toBe(0);
  });

  it('leaves the events alone unless asked', () => {
    const map = emptyMap();
    map.events = [null, anEvent(1, 0, 0)];
    clearMap(map);
    expect(map.events.filter(Boolean)).toHaveLength(1);

    clearMap(map, { events: true });
    expect(map.events).toEqual([null]);
  });

  it('keeps the leading null, because RPG Maker indexes events by id', () => {
    const map = emptyMap();
    map.events = [null, anEvent(1, 0, 0), anEvent(2, 1, 1)];
    clearMap(map, { events: true });
    // An empty list is [null], never [] — slot 0 is never an event.
    expect(map.events).toHaveLength(1);
    expect(map.events[0]).toBeNull();
  });

  it('ignores a plane index that is not one of the six', () => {
    const map = emptyMap();
    put(map, 0, 0, 0, 2816);
    expect(clearMap(map, { planes: [-1, 6, 99] })).toBe(0);
    expect(censusMap(map).filledTotal).toBe(1);
  });

  it('is idempotent: clearing an empty map clears nothing', () => {
    const map = emptyMap();
    clearMap(map);
    expect(clearMap(map)).toBe(0);
  });
});

describe('describeKeptContent', () => {
  it('says nothing when there was nothing to keep', () => {
    expect(describeKeptContent(censusMap(emptyMap()))).toBeNull();
  });

  it('names the planes rather than only the total, so a caller can act on it', () => {
    const map = emptyMap();
    put(map, 0, 0, 2, 409);
    put(map, 1, 0, 2, 417);
    put(map, 0, 1, 1, 144);

    const text = describeKeptContent(censusMap(map, [0]))!;
    expect(text).toContain('2 on layer 2');
    expect(text).toContain('1 on layer 1');
    // The empty planes are not listed — a report of "0 on layer 3" helps nobody.
    expect(text).not.toContain('layer 3');
    // The prop trap is the part a caller cannot guess.
    expect(text).toContain('displaces it');
  });

  it('counts events alongside the planes', () => {
    const map = emptyMap();
    map.events = [null, anEvent(1, 0, 0)];
    expect(describeKeptContent(censusMap(map))).toContain('1 event(s)');
  });
});
