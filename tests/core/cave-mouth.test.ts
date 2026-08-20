import { describe, it, expect } from 'vitest';
import { planCaveMouth, CaveMouthError } from '../../src/core/cave-mouth.js';

describe('planCaveMouth', () => {
  it('caps a 1x1 entrance with one row of top over one row of face plus headroom', () => {
    const plan = planCaveMouth({ entranceWidth: 1, entranceHeight: 1 });
    // default margin 1, headroom 1: width = 1 + 2*1 = 3, height = (1+1) + 1 = 3
    expect(plan.width).toBe(3);
    expect(plan.height).toBe(3);
    expect(plan.cells[0]).toEqual(['wallTop', 'wallTop', 'wallTop']);
    expect(plan.cells[1]).toEqual(['wallFace', 'wallFace', 'wallFace']);
    expect(plan.cells[2]).toEqual(['wallFace', 'wallFace', 'wallFace']);
  });

  it('grows the footprint for a taller entrance', () => {
    const plan = planCaveMouth({ entranceWidth: 1, entranceHeight: 2 });
    expect(plan.width).toBe(3);
    expect(plan.height).toBe(4); // (2 + 1 headroom) face rows + 1 top row
  });

  it('places the entrance flush with the bottom of the footprint', () => {
    const plan = planCaveMouth({ entranceWidth: 1, entranceHeight: 2, margin: 2, headroom: 0 });
    expect(plan.entranceOffset).toEqual({ x: 2, y: plan.height - 2 });
    expect(plan.entranceOffset.y + 2).toBe(plan.height);
  });

  it('widens the footprint with margin, and can drop headroom to zero', () => {
    const plan = planCaveMouth({ entranceWidth: 2, entranceHeight: 1, margin: 3, headroom: 0 });
    expect(plan.width).toBe(2 + 3 * 2);
    expect(plan.height).toBe(1 + 1); // no headroom row, just the capping top row
    expect(plan.cells[0].every((c) => c === 'wallTop')).toBe(true);
    expect(plan.cells[1].every((c) => c === 'wallFace')).toBe(true);
  });

  it('refuses an entrance smaller than one tile', () => {
    expect(() => planCaveMouth({ entranceWidth: 0, entranceHeight: 1 })).toThrow(CaveMouthError);
    expect(() => planCaveMouth({ entranceWidth: 1, entranceHeight: 0 })).toThrow(CaveMouthError);
  });

  it('refuses a negative margin or headroom', () => {
    expect(() => planCaveMouth({ entranceWidth: 1, entranceHeight: 1, margin: -1 }))
      .toThrow(CaveMouthError);
    expect(() => planCaveMouth({ entranceWidth: 1, entranceHeight: 1, headroom: -1 }))
      .toThrow(CaveMouthError);
  });

  it('always caps with exactly one row of wall top, at row 0', () => {
    for (const [w, h] of [[1, 1], [1, 2], [2, 3], [3, 1]] as const) {
      const plan = planCaveMouth({ entranceWidth: w, entranceHeight: h, margin: 2, headroom: 2 });
      expect(plan.cells[0].every((c) => c === 'wallTop')).toBe(true);
      for (let y = 1; y < plan.height; y++) {
        expect(plan.cells[y].every((c) => c === 'wallFace'), `row ${y}`).toBe(true);
      }
    }
  });
});
