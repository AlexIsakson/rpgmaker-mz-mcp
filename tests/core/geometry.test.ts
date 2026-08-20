import { describe, it, expect } from 'vitest';
import { describeDirection, describeDistance } from '../../src/core/geometry.js';

/**
 * Split out of vault.test.ts when these moved to their own module — vault.ts
 * and npcgen.ts both derive dialogue from real placement and need the same
 * direction/distance phrasing.
 */

describe('describeDirection', () => {
  it('names one axis when the other barely counts', () => {
    // Screen coordinates: a larger y is further south.
    expect(describeDirection({ x: 5, y: 5 }, { x: 20, y: 6 })).toBe('east');
    expect(describeDirection({ x: 5, y: 5 }, { x: 4, y: 25 })).toBe('south');
    expect(describeDirection({ x: 20, y: 20 }, { x: 2, y: 19 })).toBe('west');
    expect(describeDirection({ x: 20, y: 20 }, { x: 21, y: 2 })).toBe('north');
  });

  it('names a diagonal only when both axes are worth mentioning', () => {
    expect(describeDirection({ x: 5, y: 5 }, { x: 15, y: 15 })).toBe('south-east');
    expect(describeDirection({ x: 15, y: 15 }, { x: 5, y: 5 })).toBe('north-west');
  });

  it('does not call a barely-diagonal a diagonal', () => {
    // 10 east and 2 south is east. Saying "south-east" is true and reads wrong.
    expect(describeDirection({ x: 0, y: 0 }, { x: 10, y: 2 })).toBe('east');
  });

  it('handles the same tile', () => {
    expect(describeDirection({ x: 3, y: 3 }, { x: 3, y: 3 })).toBe('right here');
  });
});

describe('describeDistance', () => {
  it('scales with the walk, not the straight line', () => {
    expect(describeDistance({ x: 0, y: 0 }, { x: 3, y: 2 })).toBe('not far');
    expect(describeDistance({ x: 0, y: 0 }, { x: 8, y: 6 })).toBe('some way');
    expect(describeDistance({ x: 0, y: 0 }, { x: 30, y: 10 })).toBe('a long way');
  });
});
