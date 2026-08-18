import { describe, it, expect } from 'vitest';
import {
  battleDesignationOf,
  transferDesignationOf,
  resolveBattleDesignation,
  resolveTransferDesignation,
  checkEncounterSource,
  DesignationError,
  type EncounterRow,
} from '../../src/core/designation.js';
import { convertCommand } from '../../src/schemas/event.js';

/**
 * `params[0]` decides what the parameters after it mean, so every assertion
 * here is against the engine's own fork:
 *
 * ```js
 * command301: 0 -> params[1]; 1 -> $gameVariables.value(params[1]); else makeEncounterTroopId()
 * command201: 0 -> params[1..3] as map/x/y; else all three as variable ids
 * ```
 *
 * The encounter tests are against `makeEncounterTroopId` and
 * `meetsEncounterConditions` — a row survives only when its `regionSet` is
 * empty or includes a region the player can be standing in, and the pick
 * happens only `if (weightSum > 0)`. Everything else returns 0, which is not a
 * troop row in any project.
 */

// --- a port of the engine's pick, so the refusals are checked against it -----

/** `Game_Player.makeEncounterTroopId`, minus the random draw. */
function reachableWeight(rows: EncounterRow[], regionId: number): number {
  let weightSum = 0;
  for (const encounter of rows) {
    const regionSet = encounter.regionSet ?? [];
    if (regionSet.length === 0 || regionSet.includes(regionId)) {
      weightSum += encounter.weight ?? 0;
    }
  }
  return weightSum;
}

const battle = (extra: Record<string, unknown> = {}) => ({ type: 'battle_processing', ...extra });
const transfer = (extra: Record<string, unknown> = {}) => ({ type: 'transfer_player', ...extra });

describe('battleDesignationOf', () => {
  it.each([
    ['nothing at all', {}, 0],
    ['a troop id', { troopId: 3 }, 0],
    ['a troop name', { troopName: 'Slime' }, 0],
    ['a troop variable id', { troopVariableId: 4 }, 1],
    ['a troop variable name', { troopVariableName: 'Ambush troop' }, 1],
    ['same as random encounters', { sameAsRandomEncounter: true }, 2],
    ['sameAsRandomEncounter: false', { sameAsRandomEncounter: false }, 0],
  ])('reads %s as designation %s', (_label, cmd, expected) => {
    expect(battleDesignationOf(battle(cmd))).toBe(expected);
  });
});

describe('transferDesignationOf', () => {
  it('is 0 for a direct destination', () => {
    expect(transferDesignationOf(transfer({ mapId: 2, x: 1, y: 1 }))).toBe(0);
    expect(transferDesignationOf(transfer())).toBe(0);
  });

  it('is 1 as soon as any of the three is a variable', () => {
    expect(transferDesignationOf(transfer({ mapVariableId: 1 }))).toBe(1);
    expect(transferDesignationOf(transfer({ yVariableName: 'Landing Y' }))).toBe(1);
  });
});

describe('resolveBattleDesignation', () => {
  it('keeps the old shape for a direct troop id', () => {
    expect(resolveBattleDesignation(battle({ troopId: 7 }), 0)).toEqual({
      designation: 0,
      operand: 7,
    });
  });

  it('defaults a missing troop id to 1, the way convertCommand always has', () => {
    expect(resolveBattleDesignation(battle(), 0)).toEqual({ designation: 0, operand: 1 });
  });

  it('puts a variable id in params[1] at designation 1', () => {
    expect(resolveBattleDesignation(battle({ troopVariableId: 12 }), 0)).toEqual({
      designation: 1,
      operand: 12,
    });
  });

  it('writes designation 2 with a params[1] the engine never reads', () => {
    const { designation } = resolveBattleDesignation(battle({ sameAsRandomEncounter: true }), 0);
    expect(designation).toBe(2);
  });

  it('refuses two sources at once, naming both', () => {
    let message = '';
    try {
      resolveBattleDesignation(battle({ troopId: 3, sameAsRandomEncounter: true }), 0);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('sameAsRandomEncounter');
    expect(message).toContain('troopId');
    expect(message).toContain('exactly one');
  });

  it.each([
    ['variable 0, which setValue never writes', 0],
    ['a negative id', -3],
    ['a fraction', 1.5],
  ])('refuses %s', (_label, id) => {
    expect(() => resolveBattleDesignation(battle({ troopVariableId: id }), 0)).toThrow(
      DesignationError
    );
  });

  it('refuses a non-boolean sameAsRandomEncounter rather than reading it as truthy', () => {
    expect(() => resolveBattleDesignation(battle({ sameAsRandomEncounter: 'yes' }), 0)).toThrow(
      /must be true or false/
    );
  });
});

describe('resolveTransferDesignation', () => {
  it('keeps the old shape for a direct destination', () => {
    expect(resolveTransferDesignation(transfer({ mapId: 4, x: 5, y: 6 }), 0)).toEqual({
      designation: 0,
      operands: [4, 5, 6],
    });
  });

  it('takes all three from variables at designation 1', () => {
    expect(
      resolveTransferDesignation(
        transfer({ mapVariableId: 1, xVariableId: 2, yVariableId: 3 }),
        0
      )
    ).toEqual({ designation: 1, operands: [1, 2, 3] });
  });

  it('refuses a partial set — one flag covers all three numbers', () => {
    let message = '';
    try {
      resolveTransferDesignation(transfer({ mapVariableId: 1 }), 0);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('xVariableId');
    expect(message).toContain('yVariableId');
    expect(message).toContain('all three');
  });

  it('refuses mixing a literal with variables', () => {
    expect(() =>
      resolveTransferDesignation(
        transfer({ mapId: 2, xVariableId: 2, yVariableId: 3, mapVariableId: 1 }),
        0
      )
    ).toThrow(/wholly direct or wholly from variables/);
  });
});

describe('convertCommand carries the designation through', () => {
  it('still writes designation 0 for the direct forms', () => {
    expect(convertCommand(battle({ troopId: 2 }))[0].parameters).toEqual([0, 2, true, false]);
    expect(convertCommand(transfer({ mapId: 3, x: 4, y: 5 }))[0].parameters).toEqual([
      0, 3, 4, 5, 0, 0,
    ]);
  });

  it('writes designation 1 and 2 for the new forms', () => {
    expect(convertCommand(battle({ troopVariableId: 9 }))[0].parameters.slice(0, 2)).toEqual([1, 9]);
    expect(convertCommand(battle({ sameAsRandomEncounter: true }))[0].parameters[0]).toBe(2);
    expect(
      convertCommand(transfer({ mapVariableId: 7, xVariableId: 8, yVariableId: 9 }))[0].parameters
    ).toEqual([1, 7, 8, 9, 0, 0]);
  });

  it('leaves canEscape / canLose and direction / fadeType where they were', () => {
    expect(
      convertCommand(battle({ sameAsRandomEncounter: true, canEscape: false, canLose: true }))[0]
        .parameters.slice(2)
    ).toEqual([false, true]);
    expect(
      convertCommand(
        transfer({ mapVariableId: 1, xVariableId: 2, yVariableId: 3, direction: 8, fadeType: 1 })
      )[0].parameters.slice(4)
    ).toEqual([8, 1]);
  });
});

describe('checkEncounterSource', () => {
  const usable: EncounterRow[] = [
    { troopId: 1, weight: 5, regionSet: [] },
    { troopId: 2, weight: 5, regionSet: [] },
  ];

  it('accepts a table with reachable weight, and counts the rows', () => {
    const result = checkEncounterSource(usable, new Set(), 0, 3);
    expect(result.usable).toBe(2);
    expect(reachableWeight(usable, 0)).toBeGreaterThan(0);
  });

  it('refuses an empty list, which is what every map on disk ships', () => {
    let message = '';
    try {
      checkEncounterSource([], new Set(), 0, 3);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('empty encounterList');
    expect(message).toContain('makeEncounterTroopId returns 0');
    expect(message).toContain('encounterList yet');
  });

  it('refuses a table whose every row is gated on a region the map never paints', () => {
    const rows: EncounterRow[] = [{ troopId: 1, weight: 5, regionSet: [4] }];
    // The port agrees: standing on region 0, nothing survives the filter.
    expect(reachableWeight(rows, 0)).toBe(0);
    expect(() => checkEncounterSource(rows, new Set([1, 2]), 0, 3)).toThrow(/regionSet/);
  });

  it('accepts the same table once the map paints that region', () => {
    const rows: EncounterRow[] = [{ troopId: 1, weight: 5, regionSet: [4] }];
    expect(reachableWeight(rows, 4)).toBe(5);
    expect(checkEncounterSource(rows, new Set([4]), 0, 3).usable).toBe(1);
  });

  it('refuses a table whose weights are all zero — the pick is guarded by weightSum > 0', () => {
    const rows: EncounterRow[] = [{ troopId: 1, weight: 0, regionSet: [] }];
    expect(reachableWeight(rows, 0)).toBe(0);
    expect(() => checkEncounterSource(rows, new Set(), 0, 3)).toThrow(/weight 0/);
  });

  it('notes the unreachable rows when some others still work', () => {
    const rows: EncounterRow[] = [
      { troopId: 1, weight: 5, regionSet: [] },
      { troopId: 2, weight: 5, regionSet: [9] },
    ];
    const result = checkEncounterSource(rows, new Set(), 0, 3);
    expect(result.usable).toBe(1);
    expect(result.notes.join(' ')).toContain('never paints');
  });

  it('warns about a row naming a troop that is not there, rather than refusing', () => {
    const rows: EncounterRow[] = [
      { troopId: 1, weight: 5, regionSet: [] },
      { troopId: 99, weight: 5, regionSet: [] },
    ];
    const result = checkEncounterSource(rows, new Set(), 0, 3, (id) => id === 1);
    expect(result.usable).toBe(2);
    expect(result.notes.join(' ')).toContain('99');
    expect(result.notes.join(' ')).toContain('intermittently');
  });

  it('skips the region half when the plane could not be read', () => {
    const rows: EncounterRow[] = [{ troopId: 1, weight: 5, regionSet: [4] }];
    expect(checkEncounterSource(rows, undefined, 0, 3).usable).toBe(1);
  });
});
