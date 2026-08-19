import type { MapData } from '../schemas/map.js';
import { reachableGrid } from './walkability.js';
import { readRegion, REGION_ID_MAX } from './regions.js';

/**
 * A map's random-encounter table — `encounterList` and `encounterStep`.
 *
 * **What the engine does with it** (v1.9.0 `rmmz_objects.js`; the strongest
 * kind of claim here, because the corpus has nothing to say):
 *
 * ```js
 * makeEncounterCount:       const n = $gameMap.encounterStep();
 *                           this._encounterCount = Math.randomInt(n) + Math.randomInt(n) + 1;
 * makeEncounterTroopId:     for (const e of $gameMap.encounterList())
 *                             if (this.meetsEncounterConditions(e)) { list.push(e); weightSum += e.weight; }
 *                           if (weightSum > 0) { let v = Math.randomInt(weightSum);
 *                             for (const e of list) { v -= e.weight; if (v < 0) return e.troopId; } }
 *                           return 0;
 * meetsEncounterConditions: e.regionSet.length === 0 || e.regionSet.includes(this.regionId())
 * executeEncounter:         const troopId = this.makeEncounterTroopId();
 *                           if ($dataTroops[troopId]) { BattleManager.setup(troopId, true, false); ... }
 * encounterProgressValue:   let value = $gameMap.isBush(this.x, this.y) ? 2 : 1;  // bush counts double
 * ```
 *
 * Three consequences the writer is built around.
 *
 * **1. `weightSum` is recomputed at the player's feet, so a weight only means
 * something next to the other rows that qualify *there*.** `regionSet` is a
 * filter applied before the sum, not after it: a row with an empty `regionSet`
 * competes in every region as well as on bare ground, so a weight-3 row scoped
 * to region 1 is not 3-in-3 there — it is 3 against the weight of every
 * everywhere-row too. `planEncounters` therefore reports one probability table
 * per *zone* (each region id the player can reach, plus id 0 for unpainted
 * ground) rather than one percentage per row, because a single percentage per
 * row would be wrong on most maps.
 *
 * **2. A row the player can never stand in is a row that can never fire, and
 * nothing says so.** `meetsEncounterConditions` compares against
 * `Game_Player.regionId()` — the id under the *player*. So a `regionSet` naming
 * ids that are unpainted, or painted only on impassable tiles, or painted only
 * on tiles walled off from the player's area, is dead weight that looks correct
 * in the editor. This is why the module floods the map with `reachableGrid`
 * before accepting a row, and refuses rather than warns.
 *
 * **3. An empty troop is a battle won on the first frame.** `executeEncounter`
 * guards on `$dataTroops[troopId]`, which is truthy for a row with no members;
 * `Game_Unit.isAllDead()` is then true immediately and `checkBattleEnd` goes
 * straight to `processVictory()`. Measured with `scripts/measure-troops.mjs`
 * over every `data/` directory on this machine — **20 Troops.json files, 459
 * troop rows, and only 173 (37.7%) have a single member.** 286 rows are empty
 * slots the editor allocated. On a table picked by weight that is not a
 * deterministic failure but an intermittent one, which is worse, so an empty
 * troop is refused.
 *
 * **What the corpus says about encounter tables: nothing at all, loudly.**
 * The same sweep found **64 data directories, 1219 maps, and 0 with a single
 * `encounterList` row** — the 293 sample maps, the reference `newdata`, every
 * DLC project, and all of the user's own projects ship the list empty.
 * `encounterStep` is 30 on 1217 of those maps and 31 on exactly two
 * (`samplemaps/Map212` and `newdata-2/Map108`), both of which have an empty
 * list — so the field has been nudged on this machine but never once paired
 * with a table. There is therefore **no measured convention** for how many rows
 * a map should carry, what weights are idiomatic, or whether zones should be
 * regions or the whole map, and this module invents none: it writes what the
 * caller asks for, refuses what the engine cannot use, and reports the
 * resulting probabilities so the caller can judge.
 *
 * Naming is the one handle the data does support: of 459 troop rows, 183 carry
 * a name and **all 173 filled rows are among them**, so `troopName` can reach
 * every troop that could legitimately appear in a table.
 *
 * This module is pure — it reads a map, passage flags and troop rows, and
 * returns rows, counts and text.
 */

export class EncounterError extends Error {}

/**
 * `Math.randomInt(n)` is `Math.floor(n * Math.random())`, so at n = 0 the count
 * is `0 + 0 + 1` and an encounter fires on the very next step, forever; below 0
 * the count starts negative and `_encounterCount <= 0` is true on arrival.
 * Neither is a slower or faster table, it is a broken one.
 */
export const ENCOUNTER_STEP_MIN = 1;

/** The editor's default, on 1217 of the 1219 maps measured. */
export const ENCOUNTER_STEP_DEFAULT = 30;

/** What a caller asks for. `troopName` is resolved before anything else runs. */
export interface EncounterRowInput {
  troopId?: number;
  troopName?: string;
  weight?: number;
  regionSet?: number[];
}

/** What gets written to `encounterList`, in the engine's own field order. */
export interface EncounterRow {
  regionSet: number[];
  troopId: number;
  weight: number;
}

/** Just enough of a Troops.json row to judge it. */
export interface TroopRow {
  id?: number;
  name?: string;
  members?: unknown[];
}

/** What the region plane holds for one id, and how much of it is usable. */
export interface RegionReach {
  regionId: number;
  /** Tiles carrying this id on z=5. */
  tiles: number;
  /** Of those, tiles connected to the player's own walkable area. */
  reachable: number;
}

/**
 * One place the player can stand, from the encounter table's point of view.
 *
 * `regionId` 0 is bare ground — the value `Game_Map.regionId` returns where
 * nothing is painted. It is a zone like any other, and a `regionSet` of `[0]`
 * legitimately means "only off the marked areas".
 */
export interface EncounterZone {
  regionId: number;
  /** Reachable tiles carrying this id. */
  tiles: number;
  /** `weightSum` as `makeEncounterTroopId` would compute it standing here. */
  weightSum: number;
  /** Row index (0-based), and its share of the roll in this zone. */
  chances: { row: number; troopId: number; troopName: string | null; chance: number }[];
}

export interface EncounterPlan {
  rows: EncounterRow[];
  encounterStep: number;
  /** Resolved names, index-aligned with `rows`. Null where the troop is unnamed. */
  troopNames: (string | null)[];
  /** Every zone the player can reach, ascending by region id. */
  zones: EncounterZone[];
  notes: string[];
}

const ordinal = (index: number) => `row ${index + 1}`;

/**
 * Reachable tiles per region id, counting bare ground as id 0.
 *
 * One flood serves both questions the plan asks — which zones exist, and
 * whether a scoped row has anywhere to fire — so they cannot disagree.
 */
function zoneTiles(
  map: MapData,
  flags: number[],
  start?: { x: number; y: number }
): Map<number, number> {
  const reachable = reachableGrid(map, flags, start ? { start } : {});
  const out = new Map<number, number>();
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (!reachable[y][x]) continue;
      const id = readRegion(map, x, y);
      out.set(id, (out.get(id) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * Region ids on z=5, with how many tiles of each the player can actually get
 * to. Exported so a caller can see the gap between painted and usable before
 * writing a table that depends on it.
 */
export function surveyEncounterRegions(
  map: MapData,
  flags: number[],
  start?: { x: number; y: number }
): Map<number, RegionReach> {
  const reachable = reachableGrid(map, flags, start ? { start } : {});
  const out = new Map<number, RegionReach>();

  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const id = readRegion(map, x, y);
      if (id === 0) continue;
      const entry = out.get(id) ?? { regionId: id, tiles: 0, reachable: 0 };
      entry.tiles++;
      if (reachable[y][x]) entry.reachable++;
      out.set(id, entry);
    }
  }
  return out;
}

function resolveTroop(
  input: EncounterRowInput,
  troops: readonly (TroopRow | null)[] | undefined,
  index: number
): { id: number; name: string | null; members: number | null } {
  const where = ordinal(index);
  const named = typeof input.troopName === 'string' && input.troopName.trim() !== '';

  if (input.troopId !== undefined && named) {
    throw new EncounterError(
      `${where} gives both troopId ${input.troopId} and troopName "${input.troopName}". ` +
        'Give one — a row holds a single troopId, so the other would be discarded silently.'
    );
  }
  if (input.troopId === undefined && !named) {
    throw new EncounterError(
      `${where} names no troop. Every encounter row needs a troopId or a troopName; without ` +
        'one there is nothing for makeEncounterTroopId to return.'
    );
  }

  if (input.troopId !== undefined) {
    if (!Number.isInteger(input.troopId) || input.troopId < 1) {
      throw new EncounterError(
        `${where} has troopId ${JSON.stringify(input.troopId)}. Troop ids start at 1 — index 0 ` +
          'of Troops.json is null in every project, and executeEncounter guards on ' +
          '`if ($dataTroops[troopId])`, so a battle there never starts.'
      );
    }
    const row = troops?.[input.troopId];
    if (troops !== undefined && !row) {
      throw new EncounterError(
        `${where} names troop ${input.troopId}, which is not in Troops.json — that file holds ` +
          `ids 1-${troops.length - 1}. A troop is content, not a slot: it has to exist before a ` +
          'table can roll it. When the roll lands there, $dataTroops[troopId] is undefined, no ' +
          'battle starts, the step counter simply resets, and nothing anywhere reports it.'
      );
    }
    return {
      id: input.troopId,
      name: typeof row?.name === 'string' && row.name.trim() !== '' ? row.name : null,
      members: row ? (Array.isArray(row.members) ? row.members.length : 0) : null,
    };
  }

  if (troops === undefined) {
    throw new EncounterError(
      `${where} gives troopName "${input.troopName}", but Troops.json could not be read, so ` +
        'there is nothing to look the name up in. Give troopId instead.'
    );
  }

  const wanted = input.troopName!.trim().toLowerCase();
  const present = troops
    .map((row, id) => ({ row, id }))
    .filter((e): e is { row: TroopRow; id: number } => !!e.row);
  const namedRows = present.filter(
    (e) => typeof e.row.name === 'string' && e.row.name.trim() !== ''
  );
  const matches = namedRows.filter((e) => e.row.name!.trim().toLowerCase() === wanted);

  if (matches.length === 0) {
    throw new EncounterError(
      `${where} names troop "${input.troopName}", which is not in Troops.json. ` +
        (namedRows.length === 0
          ? 'No troop in this project carries a name.'
          : `Named troops here: ${namedRows.map((e) => `${e.id} "${e.row.name}"`).join(', ')}.`)
    );
  }
  if (matches.length > 1) {
    throw new EncounterError(
      `${where} names troop "${input.troopName}", which ${matches.length} rows carry ` +
        `(ids ${matches.map((m) => m.id).join(', ')}). Use troopId to say which.`
    );
  }
  return {
    id: matches[0].id,
    name: matches[0].row.name!,
    members: Array.isArray(matches[0].row.members) ? matches[0].row.members.length : 0,
  };
}

function checkWeight(input: EncounterRowInput, index: number): number {
  const weight = input.weight ?? 1;
  if (!Number.isInteger(weight) || weight < 0) {
    throw new EncounterError(
      `${ordinal(index)} has weight ${JSON.stringify(input.weight)}. A weight is a whole number ` +
        'of 0 or more: makeEncounterTroopId adds them into weightSum and then walks the list ' +
        'subtracting from Math.randomInt(weightSum), so a negative weight both understates the ' +
        'sum and makes its own row unpickable.'
    );
  }
  return weight;
}

function checkRegionSet(
  input: EncounterRowInput,
  index: number,
  regions: Map<number, RegionReach>
): number[] {
  const set = input.regionSet ?? [];
  if (!Array.isArray(set)) {
    throw new EncounterError(`${ordinal(index)} has a regionSet that is not a list.`);
  }
  for (const id of set) {
    if (!Number.isInteger(id) || id < 0 || id > REGION_ID_MAX) {
      throw new EncounterError(
        `${ordinal(index)} has regionSet entry ${JSON.stringify(id)}. Region ids run ` +
          `0-${REGION_ID_MAX} — 0 is what Game_Map.regionId returns on unpainted ground, so ` +
          `[0] means "only where nothing is painted", and 1-${REGION_ID_MAX} is the editor's ` +
          'palette.'
      );
    }
  }
  const deduped = [...new Set(set)].sort((a, b) => a - b);

  // A duplicate is harmless to the engine — `includes` does not care — but it
  // is a caller who thinks weight is being added, and it is not.
  if (deduped.length !== set.length) {
    throw new EncounterError(
      `${ordinal(index)} lists a region id twice. regionSet is tested with ` +
        '`regionSet.includes(regionId())`, so a repeat changes nothing — if the intent was to ' +
        'make this troop likelier there, raise its weight or add a second row.'
    );
  }

  const unpainted = deduped.filter((id) => id !== 0 && !regions.has(id));
  if (unpainted.length > 0) {
    const painted = [...regions.keys()].sort((a, b) => a - b);
    throw new EncounterError(
      `${ordinal(index)} is scoped to region ${unpainted.join(', ')}, which this map never ` +
        'paints. meetsEncounterConditions is `regionSet.length === 0 || ' +
        'regionSet.includes(regionId())`, so the row can never be picked and nothing reports ' +
        'it. ' +
        (painted.length === 0
          ? 'The region plane is empty — paint_regions writes it.'
          : `Painted here: region ${painted.join(', ')}.`)
    );
  }
  return deduped;
}

/**
 * Turn a caller's rows into an `encounterList` the player would actually meet,
 * or refuse and say which engine guard the row would have died on.
 *
 * `start` is where the player arrives; without it the largest walkable area
 * stands in, exactly as `analyseWalkability` does. `troops` may be undefined
 * when Troops.json is unreadable — names then cannot be resolved at all, and
 * ids are taken on trust rather than checked against nothing.
 */
export function planEncounters(
  map: MapData,
  flags: number[],
  inputs: readonly EncounterRowInput[],
  options: {
    encounterStep?: number;
    troops?: readonly (TroopRow | null)[];
    start?: { x: number; y: number };
  } = {}
): EncounterPlan {
  const encounterStep = options.encounterStep ?? ENCOUNTER_STEP_DEFAULT;
  if (!Number.isInteger(encounterStep) || encounterStep < ENCOUNTER_STEP_MIN) {
    throw new EncounterError(
      `encounterStep ${JSON.stringify(encounterStep)} is not a whole number of ` +
        `${ENCOUNTER_STEP_MIN} or more. makeEncounterCount is ` +
        '`Math.randomInt(n) + Math.randomInt(n) + 1`, and Math.randomInt is ' +
        '`Math.floor(n * Math.random())` — at 0 that is always 1, so an encounter fires on ' +
        'every single step, and below 0 the count starts negative and one fires the moment the ' +
        'player arrives.'
    );
  }

  const notes: string[] = [];

  if (inputs.length === 0) {
    return { rows: [], encounterStep, troopNames: [], zones: [], notes };
  }

  const regions = surveyEncounterRegions(map, flags, options.start);
  const rows: EncounterRow[] = [];
  const troopNames: (string | null)[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const troop = resolveTroop(input, options.troops, i);

    if (troop.members === 0) {
      throw new EncounterError(
        `${ordinal(i)} names troop ${troop.id}${troop.name ? ` "${troop.name}"` : ''}, which ` +
          'has no members. The row is truthy, so the battle starts — and Game_Unit.isAllDead() ' +
          'is `aliveMembers().length === 0`, true on the first frame, so checkBattleEnd goes ' +
          'straight to processVictory(). The player gets a victory fanfare for walking. ' +
          '286 of the 459 troop rows on this machine are empty slots like this one.'
      );
    }
    if (troop.members === null) {
      notes.push(
        `Note: ${ordinal(i)} names troop ${troop.id}, but Troops.json could not be read, so ` +
          'neither its existence nor its members were checked.'
      );
    }

    rows.push({
      regionSet: checkRegionSet(input, i, regions),
      troopId: troop.id,
      weight: checkWeight(input, i),
    });
    troopNames.push(troop.name);
  }

  if (rows.every((row) => row.weight === 0)) {
    throw new EncounterError(
      `All ${rows.length} row(s) have weight 0. The pick in makeEncounterTroopId is guarded by ` +
        '`if (weightSum > 0)`, so the function falls through to `return 0` every time and no ' +
        'encounter ever happens — silently, since executeEncounter just resets the counter. ' +
        'Give at least one row a weight of 1 or more.'
    );
  }

  // The zone table. weightSum is recomputed under the player's feet, so each
  // region the player can reach gets its own denominator; a row scoped nowhere
  // the player can reach appears in none of them, which is the refusal below.
  const tiles = zoneTiles(map, flags, options.start);
  const zones: EncounterZone[] = [...tiles.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([regionId, count]) => {
      const qualifying = rows
        .map((row, index) => ({ row, index }))
        .filter((e) => e.row.regionSet.length === 0 || e.row.regionSet.includes(regionId));
      const weightSum = qualifying.reduce((sum, e) => sum + e.row.weight, 0);
      return {
        regionId,
        tiles: count,
        weightSum,
        chances: qualifying
          .filter((e) => e.row.weight > 0)
          .map((e) => ({
            row: e.index,
            troopId: e.row.troopId,
            troopName: troopNames[e.index],
            chance: weightSum > 0 ? e.row.weight / weightSum : 0,
          })),
      };
    });

  const firesSomewhere = new Set(zones.flatMap((z) => z.chances.map((c) => c.row)));
  const dead = rows
    .map((row, index) => ({ row, index }))
    .filter((e) => e.row.weight > 0 && !firesSomewhere.has(e.index));

  if (dead.length > 0) {
    const detail = dead
      .map((e) => {
        const scope = e.row.regionSet.map((id) => (id === 0 ? 'unpainted ground' : `region ${id}`));
        const reach = e.row.regionSet
          .filter((id) => id !== 0)
          .map((id) => {
            const r = regions.get(id);
            return r
              ? `region ${id} covers ${r.tiles} tile(s), ${r.reachable} of them reachable`
              : `region ${id} is unpainted`;
          });
        return (
          `${ordinal(e.index)} is scoped to ${scope.join(' and ')}` +
          (reach.length > 0 ? ` — ${reach.join('; ')}` : '')
        );
      })
      .join('. ');
    throw new EncounterError(
      `${dead.length} row(s) are scoped to ground the player can never stand on, so they can ` +
        `never fire: ${detail}. meetsEncounterConditions tests the region under the *player*, ` +
        'so a region painted on walls, or on floor walled off from where the player starts, is ' +
        'the same as no region at all. check_map_walkability shows which area is which; ' +
        'paint_regions puts an id on ground the player can actually reach.'
    );
  }

  for (const zone of zones) {
    if (zone.weightSum > 0) continue;
    notes.push(
      `Note: the player can reach ${zone.tiles} tile(s) of ` +
        `${zone.regionId === 0 ? 'unpainted ground' : `region ${zone.regionId}`} where no row ` +
        'qualifies, so nothing is ever encountered there. That is a safe zone if you meant it ' +
        'and a gap if you did not.'
    );
  }

  const zeroWeight = rows.filter((row) => row.weight === 0).length;
  if (zeroWeight > 0) {
    notes.push(
      `Note: ${zeroWeight} row(s) have weight 0. They are added to weightSum as 0 and the ` +
        'subtract loop can never take them, so they are written but inert — a table entry ' +
        'parked for later rather than a working one.'
    );
  }

  return { rows, encounterStep, troopNames, zones, notes };
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

const troopLabel = (troopId: number, name: string | null) =>
  `${troopId}${name ? ` "${name}"` : ''}`;

/** The plan as the tool reports it. */
export function renderEncounterPlan(plan: EncounterPlan, mapId: number): string {
  if (plan.rows.length === 0) {
    return (
      `Map ${mapId}: encounter table cleared, encounterStep left at ${plan.encounterStep}. ` +
      'With an empty encounterList, makeEncounterTroopId returns 0 on every roll and no random ' +
      'battle can happen — and a battle_processing command set to sameAsRandomEncounter on this ' +
      'map now has no source.'
    );
  }

  const n = plan.encounterStep;
  const lines: string[] = [
    `Map ${mapId}: wrote ${plan.rows.length} encounter row(s), encounterStep ${n}.`,
    `Steps between encounters: 1 to ${2 * n - 1}, averaging ${n} — makeEncounterCount is ` +
      '`Math.randomInt(n) + Math.randomInt(n) + 1`. A bush tile counts double, so tall grass ' +
      'halves it.',
    '',
  ];

  const width = Math.max(
    ...plan.rows.map((row, i) => troopLabel(row.troopId, plan.troopNames[i]).length)
  );
  for (let i = 0; i < plan.rows.length; i++) {
    const row = plan.rows[i];
    const scope =
      row.regionSet.length === 0
        ? 'everywhere'
        : row.regionSet.map((id) => (id === 0 ? 'unpainted ground' : `region ${id}`)).join(' + ');
    lines.push(
      `  row ${i + 1}  troop ${troopLabel(row.troopId, plan.troopNames[i]).padEnd(width)}  ` +
        `weight ${row.weight}  ${scope}`
    );
  }

  lines.push(
    '',
    'What the player meets, per place they can stand — weightSum is recomputed under their',
    'feet, so a row scoped to everywhere competes inside every region too:'
  );
  for (const zone of plan.zones) {
    const name = zone.regionId === 0 ? 'unpainted' : `region ${zone.regionId}`;
    const what =
      zone.chances.length === 0
        ? 'nothing (no row qualifies)'
        : zone.chances
            .map((c) => `troop ${troopLabel(c.troopId, c.troopName)} ${pct(c.chance)}`)
            .join(', ');
    lines.push(`  ${name.padEnd(12)} ${String(zone.tiles).padStart(5)} tile(s)   ${what}`);
  }

  if (plan.notes.length > 0) lines.push('', ...plan.notes);
  return lines.join('\n');
}
