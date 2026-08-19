import { describe, it, expect } from 'vitest';
import {
  planEncounters,
  renderEncounterPlan,
  surveyEncounterRegions,
  EncounterError,
  ENCOUNTER_STEP_DEFAULT,
  type EncounterRowInput,
  type TroopRow,
} from '../../src/core/encounters.js';
import { paintRegionRect, paintRegionTiles } from '../../src/core/regions.js';
import { tileIndex } from '../../src/core/map-layers.js';
import { TILE_ID_A3, makeAutotileId } from '../../src/core/autotile.js';
import { PASSAGE_BIT, FLAG_STAR } from '../../src/core/map-grid.js';
import type { MapData } from '../../src/schemas/map.js';

const GROUND = makeAutotileId(16, 0);
const WALL = TILE_ID_A3;
const TOTAL_LAYERS = 6;

/** '#' puts a wall on layer 1 over ground; '.' is ground only. */
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

  return { width, height, data, tilesetId: 1, events: [], encounterList: [], encounterStep: 30 } as unknown as MapData;
}

/**
 * Ground passable every way, the A3 wall blocked every way. `flags[0]` carries
 * the star bit as a configured tileset's does — without it the empty layers
 * above a wall decide passage in `checkPassage` and every tile reads walkable.
 */
function makeFlags(): number[] {
  const flags = new Array(8192).fill(0);
  flags[0] = FLAG_STAR;
  const all = PASSAGE_BIT.down | PASSAGE_BIT.left | PASSAGE_BIT.right | PASSAGE_BIT.up;
  for (let i = 0; i < 8192; i++) flags[i] = 0;
  flags[0] = FLAG_STAR;
  for (let id = TILE_ID_A3; id < TILE_ID_A3 + 1024; id++) flags[id] = all;
  return flags;
}

const FLAGS = makeFlags();

/** Five named, filled troops plus an empty slot at 6 — the shape every project ships. */
const TROOPS: (TroopRow | null)[] = [
  null,
  { id: 1, name: 'Goblin*2', members: [{}, {}] },
  { id: 2, name: 'Gnome*2', members: [{}, {}] },
  { id: 3, name: 'Crow*2', members: [{}, {}] },
  { id: 4, name: 'Treant', members: [{}] },
  { id: 5, name: 'Hi_monster', members: [{}] },
  { id: 6, name: 'EMPTY SLOT', members: [] },
  { id: 7, members: [{}] },
];

/** An open 8x6 field cut clean in two by a wall down column 3. */
const split = () => makeMap(Array.from({ length: 6 }, () => '...#....'));

const open = () => makeMap(Array.from({ length: 6 }, () => '.'.repeat(8)));

const plan = (map: MapData, rows: EncounterRowInput[], options = {}) =>
  planEncounters(map, FLAGS, rows, { troops: TROOPS, ...options });

describe('planEncounters — what gets written', () => {
  it('writes the engine field order and defaults weight to 1', () => {
    const result = plan(open(), [{ troopName: 'Crow*2' }]);
    expect(result.rows).toEqual([{ regionSet: [], troopId: 3, weight: 1 }]);
    expect(Object.keys(result.rows[0])).toEqual(['regionSet', 'troopId', 'weight']);
    expect(result.encounterStep).toBe(ENCOUNTER_STEP_DEFAULT);
    expect(result.troopNames).toEqual(['Crow*2']);
  });

  it('resolves a troop name case-insensitively', () => {
    expect(plan(open(), [{ troopName: '  hi_MONSTER ' }]).rows[0].troopId).toBe(5);
  });

  it('sorts and keeps a regionSet, so the written row matches what was checked', () => {
    const map = open();
    paintRegionRect(map, { x: 0, y: 0, width: 2, height: 2 }, 3);
    paintRegionRect(map, { x: 5, y: 0, width: 2, height: 2 }, 1);
    const result = plan(map, [{ troopId: 1, regionSet: [3, 1] }]);
    expect(result.rows[0].regionSet).toEqual([1, 3]);
  });

  it('clears the table on an empty list without touching encounterStep', () => {
    const result = plan(open(), [], { encounterStep: 12 });
    expect(result.rows).toEqual([]);
    expect(result.encounterStep).toBe(12);
    expect(renderEncounterPlan(result, 4)).toContain('cleared');
  });
});

describe('planEncounters — the engine guards it refuses on', () => {
  it('refuses a troop with no members: the battle is won on the first frame', () => {
    expect(() => plan(open(), [{ troopId: 6 }])).toThrow(EncounterError);
    expect(() => plan(open(), [{ troopId: 6 }])).toThrow(/no members/);
  });

  it('refuses a troop id past the end of Troops.json', () => {
    expect(() => plan(open(), [{ troopId: 99 }])).toThrow(/not in Troops\.json/);
  });

  it('refuses a name no troop carries, and lists the ones that do', () => {
    let message = '';
    try {
      plan(open(), [{ troopName: 'Dragon' }]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('not in Troops.json');
    expect(message).toContain('"Crow*2"');
  });

  it('refuses a row that names both an id and a name', () => {
    expect(() => plan(open(), [{ troopId: 1, troopName: 'Crow*2' }])).toThrow(/Give one/);
  });

  it('refuses a row that names no troop at all', () => {
    expect(() => plan(open(), [{ weight: 5 }])).toThrow(/names no troop/);
  });

  it('refuses a negative weight — it understates weightSum and can never be picked', () => {
    expect(() => plan(open(), [{ troopId: 1, weight: -1 }])).toThrow(/whole number/);
  });

  it('refuses a table whose every weight is 0: the pick is guarded by weightSum > 0', () => {
    expect(() => plan(open(), [{ troopId: 1, weight: 0 }, { troopId: 2, weight: 0 }])).toThrow(
      /weightSum > 0/
    );
  });

  it('refuses encounterStep 0 — Math.randomInt(0) is 0, so one fires every step', () => {
    expect(() => plan(open(), [{ troopId: 1 }], { encounterStep: 0 })).toThrow(/every single step/);
    expect(() => plan(open(), [{ troopId: 1 }], { encounterStep: -5 })).toThrow(EncounterError);
  });

  it('refuses a region the map never paints, and names the ones it does', () => {
    const map = open();
    paintRegionRect(map, { x: 0, y: 0, width: 2, height: 2 }, 7);
    let message = '';
    try {
      plan(map, [{ troopId: 1, regionSet: [4] }]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('never paints');
    expect(message).toContain('region 7');
  });

  it('refuses a repeated region id rather than pretending it adds weight', () => {
    const map = open();
    paintRegionRect(map, { x: 0, y: 0, width: 2, height: 2 }, 2);
    expect(() => plan(map, [{ troopId: 1, regionSet: [2, 2] }])).toThrow(/twice/);
  });

  it('refuses a region id outside the palette', () => {
    expect(() => plan(open(), [{ troopId: 1, regionSet: [256] }])).toThrow(/0-255/);
  });
});

describe('planEncounters — reachability, which is the half a tile view cannot show', () => {
  it('refuses a region painted only on walls: the player never stands there', () => {
    const map = open();
    // Put a wall down, then paint the region on top of it.
    map.data[tileIndex(map.width, map.height, 4, 2, 1)] = WALL;
    paintRegionTiles(map, [{ x: 4, y: 2, regionId: 5 }]);

    const survey = surveyEncounterRegions(map, FLAGS);
    expect(survey.get(5)).toEqual({ regionId: 5, tiles: 1, reachable: 0 });

    let message = '';
    try {
      plan(map, [{ troopId: 1, regionSet: [5] }]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('never stand on');
    expect(message).toContain('1 tile(s), 0 of them reachable');
  });

  it('refuses a region on floor walled off from where the player starts', () => {
    const map = split();
    // Region 2 sits east of the wall; the player starts west of it.
    paintRegionRect(map, { x: 5, y: 1, width: 2, height: 3 }, 2);
    expect(surveyEncounterRegions(map, FLAGS, { x: 0, y: 1 }).get(2)).toEqual({
      regionId: 2,
      tiles: 6,
      reachable: 0,
    });
    expect(() => plan(map, [{ troopId: 1, regionSet: [2] }], { start: { x: 0, y: 1 } })).toThrow(
      /never stand on/
    );
  });

  it('accepts that same region once the player starts on its side of the wall', () => {
    const map = split();
    paintRegionRect(map, { x: 5, y: 1, width: 2, height: 3 }, 2);
    const result = plan(map, [{ troopId: 1, regionSet: [2] }], { start: { x: 7, y: 1 } });
    expect(result.rows[0].regionSet).toEqual([2]);
    expect(result.zones.find((z) => z.regionId === 2)?.tiles).toBe(6);
  });

  it('lets a zero-weight row sit in an unreachable region without refusing', () => {
    // Weight 0 rows can never be picked anyway, so reachability is moot for them.
    const map = split();
    paintRegionRect(map, { x: 5, y: 1, width: 2, height: 3 }, 2);
    const result = plan(
      map,
      [{ troopId: 1 }, { troopId: 2, weight: 0, regionSet: [2] }],
      { start: { x: 0, y: 1 } }
    );
    expect(result.rows).toHaveLength(2);
    expect(result.notes.join(' ')).toContain('weight 0');
  });
});

describe('planEncounters — the odds, which are per zone and not per row', () => {
  it('computes weightSum under the player, so an everywhere-row competes in every region', () => {
    const map = open();
    paintRegionRect(map, { x: 0, y: 0, width: 2, height: 2 }, 1);
    const result = plan(map, [
      { troopId: 3, weight: 5 }, // everywhere
      { troopId: 1, weight: 3, regionSet: [1] }, // region 1 only
    ]);

    const bare = result.zones.find((z) => z.regionId === 0)!;
    expect(bare.weightSum).toBe(5);
    expect(bare.chances).toEqual([
      { row: 0, troopId: 3, troopName: 'Crow*2', chance: 1 },
    ]);

    // The point: 3 against 5, not 3 against 3.
    const region = result.zones.find((z) => z.regionId === 1)!;
    expect(region.weightSum).toBe(8);
    expect(region.chances.map((c) => c.chance)).toEqual([5 / 8, 3 / 8]);
    expect(region.tiles).toBe(4);
  });

  it('matches a port of makeEncounterTroopId over every reachable tile', () => {
    const map = open();
    paintRegionRect(map, { x: 0, y: 0, width: 3, height: 2 }, 1);
    paintRegionRect(map, { x: 6, y: 4, width: 2, height: 2 }, 2);
    const rows: EncounterRowInput[] = [
      { troopId: 3, weight: 5 },
      { troopId: 1, weight: 3, regionSet: [1] },
      { troopId: 5, weight: 1, regionSet: [1, 2] },
    ];
    const result = plan(map, rows);

    // meetsEncounterConditions, straight from rmmz_objects.js.
    const meets = (regionSet: number[], regionId: number) =>
      regionSet.length === 0 || regionSet.includes(regionId);

    for (const zone of result.zones) {
      const qualifying = result.rows.filter((r) => meets(r.regionSet, zone.regionId));
      const weightSum = qualifying.reduce((sum, r) => sum + r.weight, 0);
      expect(zone.weightSum).toBe(weightSum);
      expect(zone.chances.reduce((sum, c) => sum + c.chance, 0)).toBeCloseTo(1, 10);
    }
    expect(result.zones.map((z) => z.regionId)).toEqual([0, 1, 2]);
    expect(result.zones.reduce((sum, z) => sum + z.tiles, 0)).toBe(8 * 6);
  });

  it('treats regionSet [0] as unpainted ground specifically, not as everywhere', () => {
    const map = open();
    paintRegionRect(map, { x: 0, y: 0, width: 2, height: 2 }, 1);
    const result = plan(map, [
      { troopId: 1, weight: 1, regionSet: [0] },
      { troopId: 2, weight: 1, regionSet: [1] },
    ]);
    expect(result.zones.find((z) => z.regionId === 0)!.chances.map((c) => c.troopId)).toEqual([1]);
    expect(result.zones.find((z) => z.regionId === 1)!.chances.map((c) => c.troopId)).toEqual([2]);
  });

  it('notes a zone where nothing can fire rather than passing it over', () => {
    const map = open();
    paintRegionRect(map, { x: 0, y: 0, width: 2, height: 2 }, 1);
    const result = plan(map, [{ troopId: 1, weight: 4, regionSet: [1] }]);
    const bare = result.zones.find((z) => z.regionId === 0)!;
    expect(bare.weightSum).toBe(0);
    expect(bare.chances).toEqual([]);
    expect(result.notes.join(' ')).toContain('nothing is ever encountered there');
  });
});

describe('planEncounters — degrading rather than guessing', () => {
  it('takes an id on trust and says so when Troops.json is unreadable', () => {
    const result = planEncounters(open(), FLAGS, [{ troopId: 42 }], { troops: undefined });
    expect(result.rows[0].troopId).toBe(42);
    expect(result.notes.join(' ')).toContain('could not be read');
  });

  it('refuses a name when there is nothing to look it up in', () => {
    expect(() =>
      planEncounters(open(), FLAGS, [{ troopName: 'Crow*2' }], { troops: undefined })
    ).toThrow(/could not be read/);
  });

  it('reports an unnamed troop without inventing a name for it', () => {
    const result = plan(open(), [{ troopId: 7 }]);
    expect(result.troopNames).toEqual([null]);
    expect(renderEncounterPlan(result, 1)).toContain('troop 7 ');
  });
});

describe('renderEncounterPlan', () => {
  it('states the step range the engine actually produces', () => {
    const text = renderEncounterPlan(plan(open(), [{ troopId: 1 }], { encounterStep: 30 }), 9);
    expect(text).toContain('1 to 59, averaging 30');
    expect(text).toContain('bush tile counts double');
  });

  it('shows the per-zone odds, not one percentage per row', () => {
    const map = open();
    paintRegionRect(map, { x: 0, y: 0, width: 2, height: 2 }, 1);
    const text = renderEncounterPlan(
      plan(map, [
        { troopId: 3, weight: 5 },
        { troopId: 1, weight: 3, regionSet: [1] },
      ]),
      9
    );
    expect(text).toContain('unpainted');
    expect(text).toContain('region 1');
    expect(text).toContain('62.5%');
    expect(text).toContain('37.5%');
  });
});
