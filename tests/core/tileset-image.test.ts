import { describe, it, expect } from 'vitest';
import { classifyA2Sheet } from '../../src/core/tileset-image.js';

/**
 * Synthetic A2 sheets. The sheet is 8 blocks across and 4 down; each block is
 * 96x144 px (4 half-tiles wide by 6 tall). Quadrant coordinates match
 * FLOOR_AUTOTILE_TABLE: the middle is x 1-2, y 3-4, and the edges run along
 * x 0 and 3 and y 2 and 5.
 */
const HALF = 24;
const SHEET_W = 8 * 4 * HALF;
const SHEET_H = 4 * 6 * HALF;

interface Painter {
  (kind: number, qsx: number, qsy: number): [number, number, number, number];
}

/** `jitter` varies colour per pixel, the way a real texture does. */
function makeSheet(paint: Painter, jitter = 0): { width: number; height: number; data: Buffer } {
  const data = Buffer.alloc(SHEET_W * SHEET_H * 4);
  let seed = 1;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return jitter === 0 ? 0 : ((seed >> 16) % (2 * jitter)) - jitter;
  };
  const clamp = (v: number) => Math.max(0, Math.min(255, v));

  for (let kind = 16; kind < 48; kind++) {
    const bx = (kind % 8) * 2;
    const by = (Math.floor(kind / 8) - 2) * 3;
    for (let qsy = 0; qsy < 6; qsy++) {
      for (let qsx = 0; qsx < 4; qsx++) {
        const [r, g, b, a] = paint(kind, qsx, qsy);
        for (let y = 0; y < HALF; y++) {
          for (let x = 0; x < HALF; x++) {
            const px = (bx * 2 + qsx) * HALF + x;
            const py = (by * 2 + qsy) * HALF + y;
            const i = (py * SHEET_W + px) * 4;
            data[i] = clamp(r + noise());
            data[i + 1] = clamp(g + noise());
            data[i + 2] = clamp(b + noise());
            data[i + 3] = a;
          }
        }
      }
    }
  }

  return { width: SHEET_W, height: SHEET_H, data };
}

const isMiddle = (qsx: number, qsy: number) =>
  qsx >= 1 && qsx <= 2 && qsy >= 3 && qsy <= 4;

describe('classifyA2Sheet', () => {
  it('reports a uniform block as opaque ground with no outline', () => {
    const sheet = makeSheet(() => [120, 160, 80, 255]);
    const materials = classifyA2Sheet(sheet);

    expect(materials).toHaveLength(32);
    for (const material of materials) {
      expect(material.opacity).toBe('ground');
      expect(material.outline).toBe('seamless');
    }
  });

  it('reports a block whose edges are a different colour as outlined', () => {
    const sheet = makeSheet((_kind, qsx, qsy) =>
      isMiddle(qsx, qsy) ? [200, 200, 200, 255] : [40, 120, 40, 255]
    );

    for (const material of classifyA2Sheet(sheet)) {
      expect(material.opacity).toBe('ground');
      expect(material.outline).toBe('outlined');
    }
  });

  it('reports transparent edge pieces as an overlay', () => {
    const sheet = makeSheet((_kind, qsx, qsy) =>
      isMiddle(qsx, qsy) ? [40, 160, 40, 255] : [0, 0, 0, 0]
    );

    for (const material of classifyA2Sheet(sheet)) {
      expect(material.opacity).toBe('overlay');
    }
  });

  it('reports a fully transparent block as empty', () => {
    const sheet = makeSheet(() => [0, 0, 0, 0]);

    for (const material of classifyA2Sheet(sheet)) {
      expect(material.opacity).toBe('empty');
    }
  });

  /**
   * The reason the classifier compares mean colours rather than pixels: a noisy
   * texture differs from itself pixel by pixel about as much as it differs from
   * anything else, so a per-pixel metric calls cobblestone "outlined" against
   * its own middle. The mean is stable under noise.
   */
  it('does not mistake a noisy texture for an outline', () => {
    const sheet = makeSheet(() => [128, 128, 128, 255], 90);

    for (const material of classifyA2Sheet(sheet)) {
      expect(material.outline).toBe('seamless');
    }
  });

  it('still sees an outline through heavy texture noise', () => {
    const sheet = makeSheet(
      (_kind, qsx, qsy) => (isMiddle(qsx, qsy) ? [190, 190, 190, 255] : [60, 110, 60, 255]),
      60
    );

    for (const material of classifyA2Sheet(sheet)) {
      expect(material.outline).toBe('outlined');
    }
  });

  it('classifies each kind independently', () => {
    // even kinds seamless, odd kinds outlined
    const sheet = makeSheet((kind, qsx, qsy) => {
      if (kind % 2 === 0) return [120, 120, 120, 255];
      return isMiddle(qsx, qsy) ? [220, 220, 220, 255] : [20, 20, 20, 255];
    });

    for (const material of classifyA2Sheet(sheet)) {
      expect(material.outline).toBe(material.kind % 2 === 0 ? 'seamless' : 'outlined');
    }
  });

  it('records where in the sheet each kind sits', () => {
    const materials = classifyA2Sheet(makeSheet(() => [10, 10, 10, 255]));
    expect(materials.find((m) => m.kind === 16)?.column).toBe(0);
    expect(materials.find((m) => m.kind === 23)?.column).toBe(7);
    expect(materials.find((m) => m.kind === 24)?.column).toBe(0);
    expect(materials.find((m) => m.kind === 24)?.row).toBe(1);
  });

  /**
   * The column says nothing about the material, and this is the test that keeps
   * anyone from putting the shortcut back. Measured over the four A2 sheets the
   * RTP ships (`scripts/measure-a2-columns.mjs`, 128 kinds): the columns that
   * are opaque and outlined in every row are 1-3 in Outside_A2, 3 in
   * Inside_A2, 2-5 in Dungeon_A2 and 0 in World_A2 — nothing in common. The
   * sheet below inverts the old prose rule, making column 0 the outlined patch
   * and column 4 the transparent overlay.
   */
  it('classifies by pixels, not by column position', () => {
    const sheet = makeSheet((kind, qsx, qsy) => {
      const column = kind % 8;
      if (column === 0) {
        // outlined ground where the rule expected a seamless fill
        return isMiddle(qsx, qsy) ? [210, 200, 170, 255] : [50, 60, 40, 255];
      }
      if (column === 4) {
        // an overlay where the rule expected a safe patch material
        return isMiddle(qsx, qsy) ? [40, 160, 40, 255] : [0, 0, 0, 0];
      }
      return [120, 120, 120, 255];
    });

    for (const material of classifyA2Sheet(sheet)) {
      if (material.column === 0) {
        expect(material.opacity).toBe('ground');
        expect(material.outline).toBe('outlined');
      } else if (material.column === 4) {
        expect(material.opacity).toBe('overlay');
      } else {
        expect(material.opacity).toBe('ground');
        expect(material.outline).toBe('seamless');
      }
    }
  });
});
