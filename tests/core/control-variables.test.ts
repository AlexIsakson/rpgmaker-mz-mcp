import { describe, it, expect } from 'vitest';
import { convertCommand } from '../../src/schemas/event.js';

/**
 * `command122` reads `params[3]` as `operand` and then a different slice of
 * `params[4..6]` depending on it — see `Game_Interpreter.prototype.command122`
 * / `gameDataOperand` in rmmz_objects.js (byte-identical v1.4.4 through
 * v1.9.0). Before this fix every operand but Constant collapsed onto one
 * `value` field, and Random was outright broken: `params[5]` was never
 * emitted, so `randomMax = params[5] - params[4] + 1` was `NaN` and every
 * variable in range was set to `NaN`.
 */

const cmd = (fields: Record<string, unknown>) =>
  convertCommand({ type: 'control_variables', startId: 1, ...fields })[0];

describe('control_variables — operand 0 (Constant)', () => {
  it('emits [startId, endId, operationType, 0, value]', () => {
    const c = cmd({ operand: 0, value: 100 });
    expect(c.code).toBe(122);
    expect(c.parameters).toEqual([1, 1, 0, 0, 100]);
  });

  it('defaults value to 0 when not given', () => {
    const c = cmd({ operand: 0 });
    expect(c.parameters).toEqual([1, 1, 0, 0, 0]);
  });

  it('defaults operand to 0 (Constant) when not given at all', () => {
    const c = cmd({ value: 5 });
    expect(c.parameters).toEqual([1, 1, 0, 0, 5]);
  });
});

describe('control_variables — operand 1 (Variable)', () => {
  it('emits [.., 1, sourceVariableId] — command122 reads $gameVariables.value(params[4])', () => {
    const c = cmd({ operand: 1, sourceVariableId: 7 });
    expect(c.parameters).toEqual([1, 1, 0, 1, 7]);
  });

  it('refuses when sourceVariableId is missing, rather than defaulting to variable 0', () => {
    expect(() => cmd({ operand: 1 })).toThrow(/sourceVariableId/);
  });
});

describe('control_variables — operand 2 (Random)', () => {
  it('emits both ends of the range: [.., 2, value, randomMax]', () => {
    const c = cmd({ operand: 2, value: 1, randomMax: 6 });
    expect(c.parameters).toEqual([1, 1, 0, 2, 1, 6]);
  });

  it('refuses when randomMax is missing — this is the NaN bug, now caught before it is written', () => {
    expect(() => cmd({ operand: 2, value: 1 })).toThrow(/randomMax/);
  });

  it('the six-parameter shape gives command122 a real range instead of NaN', () => {
    // randomMax = params[5] - params[4] + 1, computed here the way the engine does it.
    const c = cmd({ operand: 2, value: 1, randomMax: 6 });
    const [, , , , low, high] = c.parameters as number[];
    const randomMax = Math.max(high - low + 1, 1);
    expect(Number.isNaN(randomMax)).toBe(false);
    expect(randomMax).toBe(6);
  });
});

describe('control_variables — operand 3 (Game Data)', () => {
  it('emits [.., 3, gameDataType, gameDataParam1, gameDataParam2]', () => {
    const c = cmd({ operand: 3, gameDataType: 3, gameDataParam1: 1, gameDataParam2: 2 });
    expect(c.parameters).toEqual([1, 1, 0, 3, 3, 1, 2]);
  });

  it('defaults gameDataParam1/gameDataParam2 to 0 — e.g. type 7 (Other), param1 2 is Gold', () => {
    const c = cmd({ operand: 3, gameDataType: 7 });
    expect(c.parameters).toEqual([1, 1, 0, 3, 7, 0, 0]);
  });

  it('refuses when gameDataType is missing', () => {
    expect(() => cmd({ operand: 3 })).toThrow(/gameDataType/);
  });
});

describe('control_variables — operand 4 (Script)', () => {
  it('emits [.., 4, script]', () => {
    const c = cmd({ operand: 4, script: '$gameParty.gold()' });
    expect(c.parameters).toEqual([1, 1, 0, 4, '$gameParty.gold()']);
  });

  it('refuses a missing script', () => {
    expect(() => cmd({ operand: 4 })).toThrow(/script/);
  });

  it('refuses an empty or blank script — eval("") is not a useful command', () => {
    expect(() => cmd({ operand: 4, script: '' })).toThrow(/script/);
    expect(() => cmd({ operand: 4, script: '   ' })).toThrow(/script/);
  });
});

describe('control_variables — an operand outside 0-4', () => {
  it('refuses rather than silently setting every variable to 0', () => {
    expect(() => cmd({ operand: 5, value: 1 })).toThrow(/operand 5/);
  });
});

describe('control_variables — startId/endId untouched by the operand fix', () => {
  it('still ranges from startId to endId as before', () => {
    const c = convertCommand({
      type: 'control_variables',
      startId: 3,
      endId: 6,
      operand: 0,
      value: 1,
    })[0];
    expect(c.parameters.slice(0, 2)).toEqual([3, 6]);
  });
});
