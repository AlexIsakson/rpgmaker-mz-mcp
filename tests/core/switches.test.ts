import { describe, it, expect } from 'vitest';
import {
  allocateFlag,
  releaseFlag,
  findFlag,
  freeSlots,
  namedFlags,
  growToFit,
  highestUsableId,
  isUsableId,
  systemKey,
  SwitchError,
  SLOT_BLOCK,
  MAX_SLOTS,
} from '../../src/core/switches.js';

/**
 * The bound assertions here are against `Game_Switches.setValue` and
 * `Game_Variables.setValue`, both guarded by
 * `id > 0 && id < $dataSystem.<kind>.length`.
 */

/** A default-sized array: 21 slots, ids 1-20, none named. */
const fresh = (slots = 21) => new Array<string>(slots).fill('');

describe('usable ids', () => {
  it('excludes 0 and anything from the array length up', () => {
    const names = fresh(21);
    expect(isUsableId(names, 0)).toBe(false);
    expect(isUsableId(names, 1)).toBe(true);
    expect(isUsableId(names, 20)).toBe(true);
    expect(isUsableId(names, 21)).toBe(false);
    expect(highestUsableId(names)).toBe(20);
  });

  it('treats a non-integer as unusable', () => {
    expect(isUsableId(fresh(), 1.5)).toBe(false);
  });
});

describe('findFlag', () => {
  it('finds a name regardless of case and surrounding space', () => {
    const names = ['', 'Met the mayor', 'Gate open'];
    expect(findFlag(names, 'met the MAYOR')).toBe(1);
    expect(findFlag(names, '  Gate open  ')).toBe(2);
  });

  it('never matches index 0, which cannot hold a flag', () => {
    expect(findFlag(['Reserved', 'Gate open'], 'Reserved')).toBeNull();
  });

  it('returns null for an empty query rather than matching a free slot', () => {
    expect(findFlag(['', '', 'Gate open'], '')).toBeNull();
    expect(findFlag(['', '', 'Gate open'], '   ')).toBeNull();
  });
});

describe('allocateFlag', () => {
  it('claims the first free slot and leaves the input alone', () => {
    const names = fresh(21);
    const result = allocateFlag(names, 'Gate open');
    expect(result).toMatchObject({ id: 1, created: true, grew: false });
    expect(result.names[1]).toBe('Gate open');
    expect(names[1]).toBe('');
  });

  it('hands back the same id when asked for the same name again', () => {
    // What makes it safe for a generator to call every run.
    const first = allocateFlag(fresh(21), 'Gate open');
    const second = allocateFlag(first.names, 'gate OPEN');
    expect(second).toMatchObject({ id: first.id, created: false, grew: false });
  });

  it('fills a gap in the middle, which is how real projects look', () => {
    // One shipped project names 28 of its 200 slots, so gaps are normal.
    const names = ['', 'A', '', 'C', ''];
    expect(allocateFlag(names, 'B').id).toBe(2);
  });

  it('refuses an empty name, which would hand out a slot twice', () => {
    expect(() => allocateFlag(fresh(), '  ')).toThrow(SwitchError);
  });

  describe('when the array is full', () => {
    it('extends it, because an id past the end is unwritable', () => {
      const names = ['', 'A', 'B'];          // ids 1-2, both taken
      const result = allocateFlag(names, 'C');
      expect(result).toMatchObject({ id: 3, created: true, grew: true });
      expect(result.names[3]).toBe('C');
      // the engine can now actually write to it
      expect(isUsableId(result.names, 3)).toBe(true);
    });

    it('rounds up to the 20n + 1 shape the shipped projects use', () => {
      const full = ['', ...Array.from({ length: 20 }, (_, i) => `F${i + 1}`)]; // 21 slots
      const result = allocateFlag(full, 'Next');
      expect(result.id).toBe(21);
      expect(result.names).toHaveLength(2 * SLOT_BLOCK + 1);
    });
  });

  describe('with an explicit id', () => {
    it('claims it and grows the array to reach it', () => {
      const result = allocateFlag(fresh(21), 'Far', { id: 45 });
      expect(result).toMatchObject({ id: 45, created: true, grew: true });
      expect(isUsableId(result.names, 45)).toBe(true);
      expect(result.names).toHaveLength(3 * SLOT_BLOCK + 1);
    });

    it('is a no-op re-request when the name is already at that id', () => {
      const first = allocateFlag(fresh(21), 'Gate open', { id: 4 });
      const again = allocateFlag(first.names, 'Gate open', { id: 4 });
      expect(again).toMatchObject({ id: 4, created: false });
    });

    it('refuses to rename someone else\'s flag', () => {
      const names = ['', 'Gate open'];
      expect(() => allocateFlag(names, 'Something else', { id: 1 }))
        .toThrow(/already "Gate open"/);
    });

    it('refuses to give one name two ids', () => {
      const first = allocateFlag(fresh(21), 'Gate open');
      expect(() => allocateFlag(first.names, 'Gate open', { id: 9 }))
        .toThrow(/already flag 1/);
    });

    it('refuses id 0, which setValue can never write', () => {
      expect(() => allocateFlag(fresh(), 'Nope', { id: 0 })).toThrow(SwitchError);
    });
  });
});

describe('growToFit', () => {
  it('leaves an array that already reaches the id alone', () => {
    const names = fresh(21);
    expect(growToFit(names, 20)).toBe(names);
  });

  it('refuses to grow past the ceiling this server imposes', () => {
    // Not an engine limit — a guard against a typo writing a huge file.
    expect(() => growToFit(fresh(21), MAX_SLOTS + 1)).toThrow(/ceiling/);
  });
});

describe('releaseFlag', () => {
  it('clears the name but keeps the array length', () => {
    // Shortening it would move the bound and break every id above.
    const names = ['', 'A', 'B', 'C'];
    const after = releaseFlag(names, 2);
    expect(after[2]).toBe('');
    expect(after).toHaveLength(4);
    expect(freeSlots(after)).toEqual([2]);
  });

  it('refuses an id outside the array', () => {
    expect(() => releaseFlag(fresh(21), 21)).toThrow(/1-20/);
  });
});

describe('namedFlags and freeSlots', () => {
  it('split the array and skip index 0', () => {
    const names = ['', 'A', '', 'C'];
    expect(namedFlags(names)).toEqual([{ id: 1, name: 'A' }, { id: 3, name: 'C' }]);
    expect(freeSlots(names)).toEqual([2]);
  });
});

describe('systemKey', () => {
  it('maps to the System.json field names', () => {
    expect(systemKey('switch')).toBe('switches');
    expect(systemKey('variable')).toBe('variables');
  });
});
