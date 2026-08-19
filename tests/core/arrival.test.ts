import { describe, it, expect } from 'vitest';
import {
  collectTransferArrivals,
  newGameArrival,
  dedupeArrivals,
  surveyArrival,
  describeArrival,
  type ArrivalPoint,
  type CommandSource,
} from '../../src/core/arrival.js';
import { reachableFromAny, analyseWalkability } from '../../src/core/walkability.js';
import { tileIndex } from '../../src/core/map-layers.js';
import { TILE_ID_A3, makeAutotileId } from '../../src/core/autotile.js';
import { PASSAGE_BIT, FLAG_STAR } from '../../src/core/map-grid.js';
import type { MapData } from '../../src/schemas/map.js';

const GROUND = makeAutotileId(16, 0);
const WALL = TILE_ID_A3;
const TOTAL_LAYERS = 6;

function makeMap(rows: string[]): MapData {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Array(width * height * TOTAL_LAYERS).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[tileIndex(width, height, x, y, 0)] = GROUND;
      if (rows[y][x] === '#') data[tileIndex(width, height, x, y, 1)] = WALL;
    }
  }
  return { width, height, data, tilesetId: 1, events: [] } as unknown as MapData;
}

function makeFlags(): number[] {
  const flags = new Array(8192).fill(0);
  flags[0] = FLAG_STAR;
  const all = PASSAGE_BIT.down | PASSAGE_BIT.left | PASSAGE_BIT.right | PASSAGE_BIT.up;
  for (let id = TILE_ID_A3; id < TILE_ID_A3 + 1024; id++) flags[id] = all;
  return flags;
}

const FLAGS = makeFlags();

/**
 * Three unconnected rooms across five rows: a 3-wide one on the left (15
 * tiles) and two 1-wide ones (5 each). The largest is deliberately *not* where
 * the arrivals go, which is the whole point.
 */
const rooms = () =>
  makeMap([
    '##########',
    '#...##.#.#',
    '#...##.#.#',
    '#...##.#.#',
    '#...##.#.#',
    '#...##.#.#',
    '##########',
  ]);

const transfer = (mapId: number, x: number, y: number) => ({
  code: 201,
  parameters: [0, mapId, x, y, 0, 0],
});

describe('collectTransferArrivals', () => {
  it('takes the destination of every literal transfer aimed at the map', () => {
    const sources: CommandSource[] = [
      { mapId: 2, list: [transfer(5, 3, 4), transfer(9, 1, 1)] },
      { mapId: 7, list: [{ code: 101, parameters: [] }, transfer(5, 8, 2)] },
    ];
    expect(collectTransferArrivals(sources, 5)).toEqual([
      { x: 3, y: 4, source: 'transfer', fromMapId: 2 },
      { x: 8, y: 2, source: 'transfer', fromMapId: 7 },
    ]);
  });

  it('skips a transfer whose destination comes from variables', () => {
    // params[0] === 1 means params[1..3] are variable ids, not coordinates —
    // the destination is only knowable at runtime.
    const sources: CommandSource[] = [
      { mapId: 2, list: [{ code: 201, parameters: [1, 11, 12, 13, 0, 0] }] },
    ];
    expect(collectTransferArrivals(sources, 5)).toEqual([]);
  });

  it('reports a common event transfer with no map of its own', () => {
    expect(collectTransferArrivals([{ list: [transfer(3, 2, 2)] }], 3)).toEqual([
      { x: 2, y: 2, source: 'transfer', fromMapId: undefined },
    ]);
  });

  it('ignores lists that are missing or not arrays', () => {
    expect(collectTransferArrivals([{ mapId: 1 }, { mapId: 2, list: null }], 1)).toEqual([]);
  });
});

describe('newGameArrival', () => {
  it('takes System.json start only on the map it names', () => {
    const system = { startMapId: 4, startX: 8, startY: 6 };
    expect(newGameArrival(system, 4)).toEqual({ x: 8, y: 6, source: 'new-game' });
    expect(newGameArrival(system, 5)).toBeNull();
    expect(newGameArrival(undefined, 4)).toBeNull();
  });
});

describe('dedupeArrivals', () => {
  it('keeps the first mention of a tile, since a busy map names one door twice', () => {
    const points: ArrivalPoint[] = [
      { x: 1, y: 1, source: 'new-game' },
      { x: 1, y: 1, source: 'transfer', fromMapId: 9 },
      { x: 2, y: 1, source: 'transfer', fromMapId: 9 },
    ];
    expect(dedupeArrivals(points)).toEqual([points[0], points[2]]);
  });
});

describe('reachableFromAny', () => {
  it('unions the areas the starts land in, rather than picking one', () => {
    const map = rooms();
    const both = reachableFromAny(map, FLAGS, [
      { x: 1, y: 1 }, // big room
      { x: 8, y: 1 }, // small room
    ]);
    let count = 0;
    for (const row of both.grid) for (const cell of row) if (cell) count++;
    expect(both.used).toHaveLength(2);
    expect(both.areas).toBe(2);
    expect(count).toBe(15 + 5);
  });

  it('counts two starts in the same area once', () => {
    const map = rooms();
    const same = reachableFromAny(map, FLAGS, [{ x: 1, y: 1 }, { x: 2, y: 3 }]);
    expect(same.areas).toBe(1);
    expect(same.used).toHaveLength(2);
  });

  it('drops a start on an impassable tile instead of dragging its area in', () => {
    const map = rooms();
    const result = reachableFromAny(map, FLAGS, [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(result.stranded).toEqual([{ x: 0, y: 0 }]);
    expect(result.used).toEqual([{ x: 1, y: 1 }]);
  });

  it('drops a start off the edge of the map', () => {
    const map = rooms();
    const result = reachableFromAny(map, FLAGS, [{ x: 99, y: 99 }]);
    expect(result.stranded).toHaveLength(1);
    expect(result.grid.every((row) => row.every((cell) => !cell))).toBe(true);
  });

  it('reaches nothing when given nothing', () => {
    const result = reachableFromAny(rooms(), FLAGS, []);
    expect(result.used).toEqual([]);
    expect(result.grid.every((row) => row.every((cell) => !cell))).toBe(true);
  });
});

describe('surveyArrival', () => {
  it('follows the arrival, not the largest area', () => {
    const map = rooms();
    const largest = analyseWalkability(map, FLAGS).reachableTiles;
    const survey = surveyArrival(map, FLAGS, [
      { x: 8, y: 3, source: 'transfer', fromMapId: 2 },
    ]);

    expect(largest).toBe(15);
    expect(survey.reachableTiles).toBe(5);
    expect(survey.assumedLargest).toBe(false);
    expect(survey.reachable[3][1]).toBe(false); // the big room is off limits
    expect(survey.reachable[3][8]).toBe(true);
  });

  it('unions two doors that open into unconnected halves', () => {
    const survey = surveyArrival(rooms(), FLAGS, [
      { x: 1, y: 1, source: 'transfer', fromMapId: 2 },
      { x: 8, y: 1, source: 'transfer', fromMapId: 3 },
    ]);
    expect(survey.areas).toBe(2);
    expect(survey.reachableTiles).toBe(20);
    expect(describeArrival(survey)).toContain('2 unconnected areas');
  });

  it('falls back to the largest area and says so when nothing is known', () => {
    const survey = surveyArrival(rooms(), FLAGS, []);
    expect(survey.assumedLargest).toBe(true);
    expect(survey.reachableTiles).toBe(15);
    const text = describeArrival(survey);
    expect(text).toContain('Arrival: unknown');
    expect(text).toContain('Nothing on disk transfers to this map');
    expect(text).toContain('startX/startY');
  });

  it('falls back, and names the tiles, when every arrival is unstandable', () => {
    const survey = surveyArrival(rooms(), FLAGS, [
      { x: 0, y: 0, source: 'transfer', fromMapId: 2 },
    ]);
    expect(survey.assumedLargest).toBe(true);
    expect(survey.stranded).toHaveLength(1);
    const text = describeArrival(survey);
    expect(text).toContain('cannot be stood on');
    expect(text).toContain('transferred to from map 2');
  });

  it('uses the good arrivals and reports the stranded one', () => {
    const survey = surveyArrival(rooms(), FLAGS, [
      { x: 0, y: 0, source: 'transfer', fromMapId: 2 },
      { x: 8, y: 3, source: 'new-game' },
    ]);
    expect(survey.assumedLargest).toBe(false);
    expect(survey.used).toHaveLength(1);
    expect(survey.stranded).toHaveLength(1);
    const text = describeArrival(survey);
    expect(text).toContain('the new game start');
    expect(text).toContain('1 further arrival tile(s) land where the player cannot stand');
  });

  it('names a given tile as given, so a refusal says where the belief came from', () => {
    const survey = surveyArrival(rooms(), FLAGS, [{ x: 1, y: 1, source: 'given' }]);
    expect(describeArrival(survey)).toContain('(1, 1) as given');
  });

  it('does not tell a caller to pass a start they already passed', () => {
    const survey = surveyArrival(rooms(), FLAGS, [{ x: 0, y: 0, source: 'given' }]);
    expect(survey.assumedLargest).toBe(true);
    const text = describeArrival(survey);
    expect(text).toContain('the tile(s) given — (0, 0) — cannot be stood on');
    expect(text).not.toContain('Pass startX/startY');
    expect(text).toContain('check_map_walkability');
  });

  it('warns when the arrival reaches far less than the largest area', () => {
    // The right room is 5 tiles against a largest area of 15 — the shape of
    // Wicked Heart map 59, where a real transfer lands on a wall strip.
    const survey = surveyArrival(rooms(), FLAGS, [{ x: 8, y: 3, source: 'transfer', fromMapId: 2 }]);
    expect(survey.largestArea).toBe(15);
    const text = describeArrival(survey);
    expect(text).toContain('far less than');
    expect(text).toContain('15 tile(s)');
  });

  it('states the comparison but not the diagnosis for a start the caller chose', () => {
    const survey = surveyArrival(rooms(), FLAGS, [{ x: 8, y: 3, source: 'given' }]);
    const text = describeArrival(survey);
    expect(text).toContain('under half');
    expect(text).not.toContain('Warning');
  });

  it('does not warn when the arrival reaches most of the map', () => {
    const map = makeMap(Array.from({ length: 4 }, () => '.'.repeat(8)));
    const text = describeArrival(surveyArrival(map, FLAGS, [{ x: 1, y: 1, source: 'given' }]));
    expect(text).not.toContain('far less than');
  });

  it('lists at most four arrivals and counts the rest', () => {
    const map = makeMap(Array.from({ length: 4 }, () => '.'.repeat(8)));
    const points: ArrivalPoint[] = [0, 1, 2, 3, 4, 5].map((x) => ({
      x,
      y: 0,
      source: 'transfer' as const,
      fromMapId: x + 1,
    }));
    const text = describeArrival(surveyArrival(map, FLAGS, points));
    expect(text).toContain('and 2 more');
  });
});
