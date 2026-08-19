import { describe, it, expect } from 'vitest';
import {
  resolveCommandFlags,
  resolvePageConditions,
  unusableFlagIds,
  describeResolutions,
  usesConditionName,
  usesFlagName,
  CommandFlagError,
} from '../../src/core/command-flags.js';
import { convertCommand } from '../../src/schemas/event.js';

/**
 * The engine facts these assertions rest on:
 *
 *  - `Game_Switches.setValue` / `Game_Variables.setValue` are guarded by
 *    `id > 0 && id < $dataSystem.<kind>.length`, so an id past the end is
 *    silently unwritable — the reason `unusableFlagIds` exists.
 *  - `Game_Interpreter.command111` reads `params[1]` as a switch id on
 *    conditionType 0 and as a variable id on conditionType 1, and on nothing
 *    else — the reason a name is refused on any other type.
 *  - `command121` loops `params[0]..params[1]`, so a name has to fix both ends.
 */

/** A default-sized names array: 21 slots, ids 1-20, none named. */
const fresh = (slots = 21) => new Array<string>(slots).fill('');

describe('resolveCommandFlags', () => {
  it('allocates a switch for a name it has not seen', () => {
    const result = resolveCommandFlags(
      [{ type: 'control_switches', switchName: 'Village gate open', value: 0 }],
      fresh(),
      fresh()
    );

    expect(result.commands[0]).toEqual({
      type: 'control_switches',
      value: 0,
      startId: 1,
      endId: 1,
    });
    expect(result.switches[1]).toBe('Village gate open');
    expect(result.changed).toBe(true);
    expect(result.resolutions).toEqual([
      { kind: 'switch', name: 'Village gate open', id: 1, created: true, grew: false },
    ]);
  });

  it('reuses an existing flag of that name rather than burning a second id', () => {
    const switches = fresh();
    switches[7] = 'Village gate open';

    const result = resolveCommandFlags(
      [{ type: 'control_switches', switchName: 'village GATE open', value: 0 }],
      switches,
      fresh()
    );

    expect(result.commands[0].startId).toBe(7);
    expect(result.changed).toBe(false);
    expect(result.resolutions[0].created).toBe(false);
  });

  it('gives every command in one batch the same id for one name', () => {
    const result = resolveCommandFlags(
      [
        { type: 'conditional_branch', conditionType: 0, switchName: 'Lever thrown', param2: 0 },
        { type: 'control_switches', switchName: 'Lever thrown', value: 0 },
      ],
      fresh(),
      fresh()
    );

    expect(result.commands[0].param1).toBe(1);
    expect(result.commands[1].startId).toBe(1);
    expect(result.resolutions).toHaveLength(1);
  });

  it('leaves the names arrays alone when nothing is named', () => {
    const switches = fresh();
    const result = resolveCommandFlags(
      [{ type: 'control_switches', startId: 3, value: 0 }],
      switches,
      fresh()
    );

    expect(result.changed).toBe(false);
    expect(result.commands[0]).toEqual({ type: 'control_switches', startId: 3, value: 0 });
    expect(result.resolutions).toHaveLength(0);
  });

  it('never mutates the arrays or the commands handed to it', () => {
    const switches = fresh();
    const commands = [{ type: 'control_switches', switchName: 'Quest begun', value: 0 }];

    resolveCommandFlags(commands, switches, fresh());

    expect(switches.every((n) => n === '')).toBe(true);
    expect(commands[0]).toEqual({ type: 'control_switches', switchName: 'Quest begun', value: 0 });
  });

  it('grows the array when every slot is taken, so the id is one setValue reaches', () => {
    const switches = fresh(21).map((_, i) => (i === 0 ? '' : `flag ${i}`));

    const result = resolveCommandFlags(
      [{ type: 'control_switches', switchName: 'One more', value: 0 }],
      switches,
      fresh()
    );

    expect(result.resolutions[0]).toMatchObject({ id: 21, created: true, grew: true });
    expect(result.switches.length).toBeGreaterThan(21);
    expect(result.switches[21]).toBe('One more');
  });

  it('claims the exact id when startId accompanies the name', () => {
    const result = resolveCommandFlags(
      [{ type: 'control_switches', switchName: 'Gate', startId: 12, value: 0 }],
      fresh(),
      fresh()
    );

    expect(result.commands[0].startId).toBe(12);
    expect(result.commands[0].endId).toBe(12);
    expect(result.switches[12]).toBe('Gate');
  });

  it('names variables on the same machinery', () => {
    const result = resolveCommandFlags(
      [{ type: 'control_variables', variableName: 'Bandits routed', operand: 0, value: 3 }],
      fresh(),
      fresh()
    );

    expect(result.commands[0]).toMatchObject({ startId: 1, endId: 1 });
    expect(result.variables[1]).toBe('Bandits routed');
    expect(result.switches.every((n) => n === '')).toBe(true);
  });
});

describe('resolveCommandFlags refusals', () => {
  it('refuses a name on a command with no flag in it', () => {
    expect(() =>
      resolveCommandFlags([{ type: 'show_text', text: 'hi', switchName: 'Gate' }], fresh(), fresh())
    ).toThrow(/no flag for switchName to name/);
  });

  it('refuses a name alongside a range, since a name is one flag', () => {
    expect(() =>
      resolveCommandFlags(
        [{ type: 'control_switches', switchName: 'Gate', endId: 5, value: 0 }],
        fresh(),
        fresh()
      )
    ).toThrow(/endId 5/);
  });

  it('refuses a switch name on a branch that does not test a switch', () => {
    expect(() =>
      resolveCommandFlags(
        [{ type: 'conditional_branch', conditionType: 2, switchName: 'Gate', param2: 0 }],
        fresh(),
        fresh()
      )
    ).toThrow(/does not test a switch/);
  });

  it('refuses a variable name on a switch branch', () => {
    expect(() =>
      resolveCommandFlags(
        [{ type: 'conditional_branch', conditionType: 0, variableName: 'Count' }],
        fresh(),
        fresh()
      )
    ).toThrow(/does not test a variable/);
  });

  it('refuses a branch that names both a switch and a variable', () => {
    expect(() =>
      resolveCommandFlags(
        [{ type: 'conditional_branch', conditionType: 0, switchName: 'A', variableName: 'B' }],
        fresh(),
        fresh()
      )
    ).toThrow(/never both/);
  });

  it('refuses an empty name rather than claiming a free slot with nothing on it', () => {
    expect(() =>
      resolveCommandFlags([{ type: 'control_switches', switchName: '   ' }], fresh(), fresh())
    ).toThrow(CommandFlagError);
  });

  it('refuses to rename someone else’s flag', () => {
    const switches = fresh();
    switches[4] = 'Already here';

    expect(() =>
      resolveCommandFlags(
        [{ type: 'control_switches', switchName: 'Something else', startId: 4 }],
        switches,
        fresh()
      )
    ).toThrow(/already "Already here"/);
  });

  it('allocates nothing when a later command in the batch is refused', () => {
    const switches = fresh();

    expect(() =>
      resolveCommandFlags(
        [
          { type: 'control_switches', switchName: 'First flag', value: 0 },
          { type: 'show_text', text: 'oops', switchName: 'Second flag' },
        ],
        switches,
        fresh()
      )
    ).toThrow();

    // The caller's array is the one that matters: it is what would be written.
    expect(switches.every((n) => n === '')).toBe(true);
  });
});

describe('unusableFlagIds', () => {
  it('flags an id past the end of the array', () => {
    const bad = unusableFlagIds(
      [{ type: 'control_switches', startId: 50, value: 0 }],
      fresh(21),
      fresh(21)
    );

    expect(bad).toEqual([{ kind: 'switch', id: 50, reach: 20 }]);
  });

  it('says nothing about an id the engine can write', () => {
    expect(unusableFlagIds([{ type: 'control_switches', startId: 20 }], fresh(21), fresh(21)))
      .toHaveLength(0);
  });

  it('checks a branch against the kind its conditionType tests', () => {
    const bad = unusableFlagIds(
      [{ type: 'conditional_branch', conditionType: 1, param1: 30 }],
      fresh(101),
      fresh(21)
    );

    expect(bad).toEqual([{ kind: 'variable', id: 30, reach: 20 }]);
  });

  it('ignores branch types that read params[1] as something other than a flag', () => {
    // conditionType 4 is Actor; params[1] is an actor id, not a switch id.
    expect(unusableFlagIds([{ type: 'conditional_branch', conditionType: 4, param1: 99 }], fresh(), fresh()))
      .toHaveLength(0);
  });
});

describe('resolved commands survive conversion', () => {
  it('turns a named switch into a command121 the engine can run', () => {
    const resolved = resolveCommandFlags(
      [{ type: 'control_switches', switchName: 'Village gate open', value: 0 }],
      fresh(),
      fresh()
    );
    const [cmd] = convertCommand(resolved.commands[0] as { type: string });

    // command121 loops params[0]..params[1] and sets each to `params[2] === 0`.
    expect(cmd).toEqual({ code: 121, indent: 0, parameters: [1, 1, 0] });
  });

  it('emits the two extra parameters a variable branch needs to be takeable', () => {
    const [cmd] = convertCommand({ type: 'conditional_branch', conditionType: 1, param1: 3 });

    // command111 case 1 reads params[3] as the value and does `switch (params[4])`;
    // with three parameters that switch falls through and result stays false.
    expect(cmd.parameters).toEqual([1, 3, 0, 0, 0]);
  });

  it('leaves a switch branch at the three parameters command111 case 0 reads', () => {
    const [cmd] = convertCommand({ type: 'conditional_branch', conditionType: 0, param1: 3, param2: 0 });

    expect(cmd.parameters).toEqual([0, 3, 0]);
  });
});

describe('describeResolutions', () => {
  it('distinguishes allocated from reused, and says when the array grew', () => {
    const lines = describeResolutions([
      { kind: 'switch', name: 'New', id: 21, created: true, grew: true },
      { kind: 'variable', name: 'Old', id: 2, created: false, grew: false },
    ]);

    expect(lines[0]).toContain('extending the switches array');
    expect(lines[1]).toContain('already existed and was reused');
  });
});

describe('naming the variable a designation reads', () => {
  it('resolves troopVariableName into troopVariableId', () => {
    const result = resolveCommandFlags(
      [{ type: 'battle_processing', troopVariableName: 'Ambush troop' }],
      fresh(),
      fresh()
    );

    const cmd = result.commands[0];
    expect(cmd.troopVariableName).toBeUndefined();
    expect(typeof cmd.troopVariableId).toBe('number');
    expect(result.variables[cmd.troopVariableId as number]).toBe('Ambush troop');
  });

  it('resolves all three of a transfer destination, reusing one name across two slots', () => {
    const result = resolveCommandFlags(
      [
        {
          type: 'transfer_player',
          mapVariableName: 'Return map',
          xVariableName: 'Return X',
          yVariableName: 'Return Y',
        },
        { type: 'battle_processing', troopVariableName: 'Return map' },
      ],
      fresh(),
      fresh()
    );

    const [tp, bp] = result.commands;
    expect(new Set([tp.mapVariableId, tp.xVariableId, tp.yVariableId]).size).toBe(3);
    // The same name is one variable, wherever it turns up.
    expect(bp.troopVariableId).toBe(tp.mapVariableId);
    expect(result.resolutions).toHaveLength(3);
  });

  it('treats an id alongside the name as the id to claim', () => {
    const result = resolveCommandFlags(
      [{ type: 'battle_processing', troopVariableName: 'Ambush troop', troopVariableId: 9 }],
      fresh(),
      fresh()
    );

    expect(result.commands[0].troopVariableId).toBe(9);
    expect(result.variables[9]).toBe('Ambush troop');
  });

  it('refuses a designation name on a command that has no such operand', () => {
    expect(() =>
      resolveCommandFlags([{ type: 'show_text', troopVariableName: 'Nope' }], fresh(), fresh())
    ).toThrow(/no flag for troopVariableName to name/);
  });

  it('names the command that does take it', () => {
    let message = '';
    try {
      resolveCommandFlags([{ type: 'battle_processing', xVariableName: 'Nope' }], fresh(), fresh());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('transfer_player');
  });
});

describe('usesFlagName', () => {
  it('covers every name key, so the tool never has to list them again', () => {
    for (const key of [
      'switchName',
      'variableName',
      'troopVariableName',
      'mapVariableName',
      'xVariableName',
      'yVariableName',
    ]) {
      expect(usesFlagName({ type: 'x', [key]: 'A name' })).toBe(true);
    }
    expect(usesFlagName({ type: 'battle_processing', troopId: 1 })).toBe(false);
  });
});

describe('usesConditionName', () => {
  it('is true for any of the three name fields', () => {
    expect(usesConditionName({ switch1Name: 'Gate open' })).toBe(true);
    expect(usesConditionName({ switch2Name: 'Gate open' })).toBe(true);
    expect(usesConditionName({ variableName: 'Gold' })).toBe(true);
  });

  it('is false for raw ids, self-switches and database refs', () => {
    expect(usesConditionName({ switch1Id: 3, selfSwitchCh: 'A', itemId: 1, actorId: 1 })).toBe(false);
    expect(usesConditionName({})).toBe(false);
  });
});

describe('resolvePageConditions', () => {
  it('defaults to every condition off — blankConditions() shape', () => {
    const result = resolvePageConditions({}, fresh(), fresh());
    expect(result.conditions).toEqual({
      switch1Valid: false, switch1Id: 1,
      switch2Valid: false, switch2Id: 1,
      variableValid: false, variableId: 1, variableValue: 0,
      selfSwitchValid: false, selfSwitchCh: 'A',
      itemValid: false, itemId: 1,
      actorValid: false, actorId: 1,
    });
    expect(result.changed).toBe(false);
  });

  it('allocates a switch for switch1Name and turns switch1Valid on', () => {
    const result = resolvePageConditions({ switch1Name: 'Village gate open' }, fresh(), fresh());
    expect(result.conditions.switch1Valid).toBe(true);
    expect(result.conditions.switch1Id).toBe(1);
    expect(result.switches[1]).toBe('Village gate open');
    expect(result.changed).toBe(true);
    expect(result.resolutions).toHaveLength(1);
  });

  it('reuses an existing flag of that name rather than allocating a new one', () => {
    const switches = fresh();
    switches[5] = 'Village gate open';
    const result = resolvePageConditions({ switch1Name: 'Village gate open' }, switches, fresh());
    expect(result.conditions.switch1Id).toBe(5);
    expect(result.changed).toBe(false);
    expect(result.resolutions[0].created).toBe(false);
  });

  it('resolves switch1 and switch2 independently, even to the same name', () => {
    const result = resolvePageConditions(
      { switch1Name: 'A', switch2Name: 'B' },
      fresh(),
      fresh()
    );
    expect(result.conditions.switch1Valid).toBe(true);
    expect(result.conditions.switch2Valid).toBe(true);
    expect(result.conditions.switch1Id).not.toBe(result.conditions.switch2Id);
  });

  it('leaves a raw switch1Id alone — no allocation, no name to resolve', () => {
    const result = resolvePageConditions({ switch1Id: 9 }, fresh(), fresh());
    expect(result.conditions.switch1Valid).toBe(true);
    expect(result.conditions.switch1Id).toBe(9);
    expect(result.changed).toBe(false);
  });

  it('claims switch1Id as the id when both switch1Id and switch1Name are given', () => {
    const result = resolvePageConditions(
      { switch1Id: 9, switch1Name: 'Village gate open' },
      fresh(),
      fresh()
    );
    expect(result.conditions.switch1Id).toBe(9);
    expect(result.switches[9]).toBe('Village gate open');
  });

  it('resolves a named variable and keeps variableValue as given', () => {
    const result = resolvePageConditions(
      { variableName: 'Gold', variableValue: 100 },
      fresh(),
      fresh()
    );
    expect(result.conditions.variableValid).toBe(true);
    expect(result.conditions.variableValue).toBe(100);
    expect(result.variables[1]).toBe('Gold');
  });

  it('defaults variableValue to 0 when not given', () => {
    const result = resolvePageConditions({ variableId: 4 }, fresh(), fresh());
    expect(result.conditions.variableValue).toBe(0);
  });

  it('turns selfSwitchValid on from selfSwitchCh, with no allocation involved', () => {
    const result = resolvePageConditions({ selfSwitchCh: 'B' }, fresh(), fresh());
    expect(result.conditions.selfSwitchValid).toBe(true);
    expect(result.conditions.selfSwitchCh).toBe('B');
    expect(result.changed).toBe(false);
    expect(result.resolutions).toHaveLength(0);
  });

  it('turns itemValid/actorValid on straight from the given id, unresolved', () => {
    const result = resolvePageConditions({ itemId: 7, actorId: 2 }, fresh(), fresh());
    expect(result.conditions.itemValid).toBe(true);
    expect(result.conditions.itemId).toBe(7);
    expect(result.conditions.actorValid).toBe(true);
    expect(result.conditions.actorId).toBe(2);
  });

  it('sets every kind at once when every kind is named', () => {
    const result = resolvePageConditions(
      {
        switch1Name: 'A', switch2Name: 'B', variableName: 'Gold', variableValue: 50,
        selfSwitchCh: 'C', itemId: 3, actorId: 1,
      },
      fresh(),
      fresh()
    );
    const c = result.conditions;
    expect(c.switch1Valid && c.switch2Valid && c.variableValid).toBe(true);
    expect(c.selfSwitchValid && c.itemValid && c.actorValid).toBe(true);
  });

  it('does not mutate the input arrays', () => {
    const switches = fresh();
    resolvePageConditions({ switch1Name: 'Village gate open' }, switches, fresh());
    expect(switches.every((n) => n === '')).toBe(true);
  });

  it('refuses a name already carried by a different id, the same as resolveCommandFlags', () => {
    const switches = fresh();
    switches[3] = 'Village gate open';
    expect(() =>
      resolvePageConditions({ switch1Id: 4, switch1Name: 'Village gate open' }, switches, fresh())
    ).toThrow(CommandFlagError);
  });
});
