/**
 * `params[0]` on Battle Processing and Transfer Player — the fork that decides
 * whether the rest of the parameters are values or variable ids.
 *
 * Two commands carry one, and `convertCommand` hardcoded 0 on both, so the
 * variable-driven forms could not be written at all:
 *
 * ```js
 * command301: if (params[0] === 0) { troopId = params[1]; }
 *             else if (params[0] === 1) { troopId = $gameVariables.value(params[1]); }
 *             else { troopId = $gamePlayer.makeEncounterTroopId(); }
 *
 * command201: if (params[0] === 0) { mapId = params[1]; x = params[2]; y = params[3]; }
 *             else { mapId = $gameVariables.value(params[1]); x = ...; y = ...; }
 * ```
 *
 * Note the shape of the transfer fork: **one flag covers all three numbers.**
 * There is no mixed mode where the map is literal and the coordinates come from
 * variables, so asking for one is refused rather than silently promoted.
 *
 * **The corpus settles nothing about designation, and says so loudly.** Across
 * 44 project data directories on this machine — the 293 sample maps, the
 * `newdata` reference project, every project under `M:/Projects/RPGMZ`, and the
 * VisuMZ sample — there are **926 maps, and 0 use designation 1 or 2**: all 13
 * `battle_processing` commands and all 766 `transfer_player` commands are
 * designation 0. So the semantics here come from the engine, exactly as they
 * did for the region plane.
 *
 * **Designation 2 has a silent-failure mode and it is the default state of
 * every map that exists.** `makeEncounterTroopId` returns 0 when no encounter
 * row survives its filters, and 0 lands in `command301`'s
 * `if ($dataTroops[troopId])` — which is null at index 0. That is P5-33's
 * failure again: no battle, no `setEventCallback`, and every win/escape/lose
 * arm skipped, with nothing reported.
 *
 * ```js
 * makeEncounterTroopId: for (const e of $gameMap.encounterList()) {
 *                         if (this.meetsEncounterConditions(e)) { list.push(e); weightSum += e.weight; }
 *                       }
 *                       if (weightSum > 0) { ...pick one... }
 *                       return 0;
 * meetsEncounterConditions: e.regionSet.length === 0 || e.regionSet.includes(this.regionId())
 * ```
 *
 * Measured with `scripts/measure-encounters.mjs`: **all 926 maps ship
 * `encounterList: []`**, and all of them ship `encounterStep: 30`, the editor
 * default. Only one map in the whole sweep paints a single region tile. So a
 * "same as random encounters" battle written today would do nothing on every
 * map on disk — which is why `checkEncounterSource` refuses rather than warns.
 * Nothing in the server writes `encounterList` yet; that belongs with the
 * encounter work (P5-17), and the refusal says so.
 *
 * This module is pure: it reads command records and encounter rows, and returns
 * numbers and text.
 */

export class DesignationError extends Error {}

/** 0 direct, 1 from a variable, 2 same as random encounters. */
export type Designation = 0 | 1 | 2;

const ordinal = (index: number) => `command ${index + 1}`;

/** The keys that put a battle into designation 1. */
const BATTLE_VARIABLE_KEYS = ['troopVariableId', 'troopVariableName'] as const;

/** The keys that put a transfer into designation 1, in parameter order. */
const TRANSFER_VARIABLE_KEYS = [
  { id: 'mapVariableId', name: 'mapVariableName', literal: 'mapId', label: 'map' },
  { id: 'xVariableId', name: 'xVariableName', literal: 'x', label: 'x' },
  { id: 'yVariableId', name: 'yVariableName', literal: 'y', label: 'y' },
] as const;

const has = (cmd: Record<string, unknown>, key: string) =>
  cmd[key] !== undefined && cmd[key] !== null;

/**
 * Which designation a battle command is in, without judging whether it is
 * well-formed.
 *
 * `database-refs.ts` calls this so it can skip the troop-row check on a battle
 * that has no static troop id to check — and say so rather than checking the
 * fallback and passing.
 */
export function battleDesignationOf(cmd: Record<string, unknown>): Designation {
  if (cmd.sameAsRandomEncounter === true) return 2;
  if (BATTLE_VARIABLE_KEYS.some((key) => has(cmd, key))) return 1;
  return 0;
}

/** The same predicate for transfers, used by `map-refs.ts`. */
export function transferDesignationOf(cmd: Record<string, unknown>): Designation {
  return TRANSFER_VARIABLE_KEYS.some((k) => has(cmd, k.id) || has(cmd, k.name)) ? 1 : 0;
}

function asVariableId(value: unknown, where: string, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new DesignationError(
      `${where} ${key} must be a whole variable id of 1 or more, got ${JSON.stringify(value)}. ` +
        'Variable 0 is never a real slot — Game_Variables.setValue is guarded by `id > 0`, so it ' +
        'reads as 0 forever.'
    );
  }
  return value;
}

export interface BattleDesignationResult {
  designation: Designation;
  /**
   * `params[1]`. The troop id, the variable holding one, or — at designation 2
   * — a value the engine never reads.
   */
  operand: number;
}

/**
 * Work out a battle's designation and its `params[1]`.
 *
 * Runs after `resolveCommandFlags`, so a `troopVariableName` has already become
 * a `troopVariableId` by the time this sees it; the name key is still refused
 * here in case it arrives unresolved, rather than being ignored.
 */
export function resolveBattleDesignation(
  cmd: Record<string, unknown>,
  index: number
): BattleDesignationResult {
  const where = `${ordinal(index)} (battle_processing)`;
  const wantsRandom = cmd.sameAsRandomEncounter === true;
  const variableKey = BATTLE_VARIABLE_KEYS.find((key) => has(cmd, key));
  const named = has(cmd, 'troopId') || has(cmd, 'troopName');

  if (cmd.sameAsRandomEncounter !== undefined && typeof cmd.sameAsRandomEncounter !== 'boolean') {
    throw new DesignationError(
      `${where} sameAsRandomEncounter must be true or false, got ` +
        `${JSON.stringify(cmd.sameAsRandomEncounter)}.`
    );
  }

  // command301 reads exactly one of the three, so naming two is a caller who
  // believes something is in play that the engine will never look at.
  const chosen = [
    wantsRandom ? 'sameAsRandomEncounter' : null,
    variableKey ?? null,
    named ? (has(cmd, 'troopId') ? 'troopId' : 'troopName') : null,
  ].filter((k): k is string => k !== null);

  if (chosen.length > 1) {
    throw new DesignationError(
      `${where} gives ${chosen.join(' and ')}. command301 reads params[0] and then takes ` +
        'exactly one of them: 0 uses the troop id, 1 reads it from a variable, 2 calls ' +
        'makeEncounterTroopId. Pick one — the others would be written and never read.'
    );
  }

  if (wantsRandom) {
    // params[1] is untouched at designation 2. The corpus has no example to
    // copy, so this is 1 rather than 0 for the editor's sake: its troop
    // dropdown still renders the field, and 0 is not a row in any project.
    return { designation: 2, operand: 1 };
  }
  if (variableKey !== undefined) {
    if (variableKey === 'troopVariableName') {
      throw new DesignationError(
        `${where} still carries troopVariableName. It should have been resolved to an id ` +
          'before this point — pass troopVariableId, or report this as a bug.'
      );
    }
    return { designation: 1, operand: asVariableId(cmd[variableKey], where, variableKey) };
  }
  return { designation: 0, operand: (cmd.troopId as number) || 1 };
}

export interface TransferDesignationResult {
  designation: Designation;
  /** `params[1]`, `params[2]`, `params[3]` — map, x, y, or the variables holding them. */
  operands: [number, number, number];
}

/** Work out a transfer's designation and its three operands. */
export function resolveTransferDesignation(
  cmd: Record<string, unknown>,
  index: number
): TransferDesignationResult {
  const where = `${ordinal(index)} (transfer_player)`;
  const supplied = TRANSFER_VARIABLE_KEYS.filter((k) => has(cmd, k.id) || has(cmd, k.name));

  if (supplied.length === 0) {
    return {
      designation: 0,
      operands: [(cmd.mapId as number) || 1, (cmd.x as number) || 0, (cmd.y as number) || 0],
    };
  }

  // One flag covers all three, so a partial set is a request the engine has no
  // way to honour — the missing two would be read as variable ids anyway.
  if (supplied.length < TRANSFER_VARIABLE_KEYS.length) {
    const missing = TRANSFER_VARIABLE_KEYS.filter((k) => !supplied.includes(k));
    throw new DesignationError(
      `${where} takes ${supplied.map((k) => k.id).join(' and ')} but not ` +
        `${missing.map((k) => k.id).join(' and ')}. command201 has one designation flag for all ` +
        'three numbers: at designation 1 it reads params[1], params[2] and params[3] as ' +
        `variable ids, so the ${missing.length === 1 ? 'missing one' : 'missing ones'} would be ` +
        'read as a variable id too. Give all three, or none.'
    );
  }

  const literal = TRANSFER_VARIABLE_KEYS.filter((k) => has(cmd, k.literal));
  if (literal.length > 0) {
    throw new DesignationError(
      `${where} gives both variable ids and ${literal.map((k) => k.literal).join(', ')}. ` +
        'A transfer is either wholly direct or wholly from variables — the literal value would ' +
        'be written into params and then read as a variable id.'
    );
  }

  const operands = TRANSFER_VARIABLE_KEYS.map((k) => {
    if (has(cmd, k.name)) {
      throw new DesignationError(
        `${where} still carries ${k.name}. It should have been resolved to an id before this ` +
          'point — pass ' + k.id + ', or report this as a bug.'
      );
    }
    return asVariableId(cmd[k.id], where, k.id);
  }) as [number, number, number];

  return { designation: 1, operands };
}

// --- designation 2's other half: the map's encounter table -------------------

/** One row of a map's `encounterList`. */
export interface EncounterRow {
  troopId?: number;
  weight?: number;
  regionSet?: number[];
}

export interface EncounterCheck {
  /** Rows that could actually be picked on this map. */
  usable: number;
  notes: string[];
}

/**
 * Refuse a "same as random encounters" battle on a map that cannot produce a
 * troop for it.
 *
 * `paintedRegions` is the set of region ids the map's z=5 plane actually uses.
 * Pass `undefined` to skip the region half of the check — a caller that could
 * not read the plane should not be told its encounters are unreachable.
 */
export function checkEncounterSource(
  rows: readonly EncounterRow[] | undefined,
  paintedRegions: ReadonlySet<number> | undefined,
  index: number,
  mapId: number,
  troopExists?: (troopId: number) => boolean
): EncounterCheck {
  const where = `${ordinal(index)} (battle_processing)`;
  const consequence =
    'makeEncounterTroopId returns 0 when no row survives, and command301 wraps everything in ' +
    '`if ($dataTroops[troopId])`, which is null at index 0 — so no battle starts, ' +
    'setEventCallback is never installed, and every if_win / if_escape / if_lose arm is ' +
    'skipped. Nothing reports a thing.';

  if (rows === undefined || rows.length === 0) {
    throw new DesignationError(
      `${where} is sameAsRandomEncounter, but map ${mapId} has an empty encounterList. ` +
        `${consequence} No tool writes encounterList yet, so this needs setting in the editor ` +
        'for now.'
    );
  }

  const notes: string[] = [];
  let usable = 0;
  let unreachableByRegion = 0;
  let zeroWeight = 0;
  const missingTroops: number[] = [];

  for (const row of rows) {
    const weight = typeof row.weight === 'number' ? row.weight : 0;
    const regionSet = Array.isArray(row.regionSet) ? row.regionSet : [];
    const reachable =
      regionSet.length === 0 ||
      paintedRegions === undefined ||
      regionSet.some((id) => paintedRegions.has(id));

    if (!reachable) {
      unreachableByRegion++;
      continue;
    }
    if (weight <= 0) {
      zeroWeight++;
      continue;
    }
    usable++;
    const troopId = typeof row.troopId === 'number' ? row.troopId : 0;
    if (troopExists && !troopExists(troopId)) missingTroops.push(troopId);
  }

  if (usable === 0) {
    const why = [
      unreachableByRegion > 0
        ? `${unreachableByRegion} row(s) name a regionSet this map never paints — ` +
          'meetsEncounterConditions is `regionSet.length === 0 || regionSet.includes(regionId())`, ' +
          'and paint_regions is what puts an id on the ground'
        : null,
      zeroWeight > 0
        ? `${zeroWeight} row(s) have weight 0, and the pick is guarded by \`weightSum > 0\``
        : null,
    ].filter(Boolean);
    throw new DesignationError(
      `${where} is sameAsRandomEncounter, but none of map ${mapId}'s ${rows.length} encounter ` +
        `row(s) can ever be picked: ${why.join('; ')}. ${consequence}`
    );
  }

  if (unreachableByRegion > 0) {
    notes.push(
      `Note: ${unreachableByRegion} of map ${mapId}'s ${rows.length} encounter row(s) name a ` +
        'region this map never paints, so they can never fire. paint_regions writes the plane ' +
        'they match against.'
    );
  }
  if (missingTroops.length > 0) {
    notes.push(
      `Warning: encounter row(s) name troop ${[...new Set(missingTroops)].join(', ')}, which ` +
        'is not in Troops.json. When the roll lands on one, $dataTroops[troopId] is undefined ' +
        'and the battle silently does not happen — intermittently, which is worse to diagnose ' +
        'than never.'
    );
  }

  return { usable, notes };
}
