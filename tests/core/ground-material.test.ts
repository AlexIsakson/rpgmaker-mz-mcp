import { describe, it, expect } from 'vitest';
import { checkGroundKinds, isA2Kind, overlayKindsAmong } from '../../src/core/ground-material.js';
import type { A2Material } from '../../src/core/tileset-image.js';

/**
 * The rule under test is visual review finding 1: an A2 material whose edge
 * pieces are transparent shows the map background through them, and on layer 0
 * there is nothing behind the map background. `Tilemap` draws it black.
 *
 * The materials here are hand-built rather than classified from a PNG — the
 * classifier has its own tests in tileset-image.test.ts, and mixing the two
 * would make a failure here ambiguous.
 */
const material = (kind: number, opacity: A2Material['opacity'], outline: A2Material['outline'] = 'outlined'): A2Material => ({
  kind,
  column: (kind - 16) % 8,
  row: Math.floor((kind - 16) / 8),
  opacity,
  outline,
  centreOpacity: 1,
  edgeOpacity: opacity === 'ground' ? 1 : 0.4,
  edgeContrast: outline === 'outlined' ? 0.2 : 0,
});

/** A sheet with one of each classification, at known kinds. */
const sheet: A2Material[] = [
  material(16, 'ground', 'seamless'),
  material(17, 'ground', 'outlined'),
  material(22, 'overlay'),
  material(23, 'empty'),
];

describe('isA2Kind', () => {
  it('accepts the A2 range and rejects the wall families', () => {
    // A2 is kinds 16-47; 48-79 is A3, 80-127 A4, and neither is classified here.
    expect(isA2Kind(16)).toBe(true);
    expect(isA2Kind(47)).toBe(true);
    expect(isA2Kind(15)).toBe(false);
    expect(isA2Kind(48)).toBe(false);
    expect(isA2Kind(98)).toBe(false);
  });
});

describe('checkGroundKinds', () => {
  it('passes an opaque ground material', () => {
    const result = checkGroundKinds(
      [{ kind: 17, label: 'floorKind', layer: 0, coversMap: true }],
      sheet,
      'Outside'
    );

    expect(result.refusal).toBeNull();
    expect(result.notes).toHaveLength(0);
  });

  it('refuses an overlay on layer 0, naming the kind, the argument and the tileset', () => {
    const result = checkGroundKinds(
      [{ kind: 22, label: 'floorKind', layer: 0 }],
      sheet,
      'Outside'
    );

    expect(result.refusal).toContain('A2 kind 22');
    expect(result.refusal).toContain('floorKind');
    expect(result.refusal).toContain('"Outside"');
    expect(result.refusal).toContain('overlay material');
    expect(result.refusal).toContain('draws as black');
  });

  it('calls an empty sheet slot what it is rather than an overlay', () => {
    const result = checkGroundKinds([{ kind: 23, label: 'floorKind' }], sheet, 'Outside');

    expect(result.refusal).toContain('empty slot');
  });

  it('defaults the layer to 0, which is the one with nothing beneath it', () => {
    expect(checkGroundKinds([{ kind: 22, label: 'floorKind' }], sheet, 'Outside').refusal)
      .not.toBeNull();
  });

  it('allows an overlay above layer 0, where there is a ground material under it', () => {
    const result = checkGroundKinds(
      [{ kind: 22, label: 'propKind', layer: 1 }],
      sheet,
      'Outside'
    );

    expect(result.refusal).toBeNull();
  });

  it('names every bad argument at once, not just the first', () => {
    const result = checkGroundKinds(
      [
        { kind: 22, label: 'floorKind', layer: 0 },
        { kind: 23, label: 'surroundKind', layer: 0 },
      ],
      sheet,
      'Outside'
    );

    expect(result.refusal).toContain('floorKind');
    expect(result.refusal).toContain('surroundKind');
  });

  it('lets a deliberate caller through with allowOverlayOnGround', () => {
    const result = checkGroundKinds(
      [{ kind: 22, label: 'floorKind', layer: 0 }],
      sheet,
      'Outside',
      { allowOverlayOnGround: true }
    );

    expect(result.refusal).toBeNull();
  });

  it('skips a wall kind, which is opaque by construction and not classified', () => {
    // surroundKind takes an A4 wall top as often as an A2 ground material.
    const result = checkGroundKinds(
      [{ kind: 98, label: 'surroundKind', layer: 0 }],
      sheet,
      'Outside'
    );

    expect(result.refusal).toBeNull();
    expect(result.notes).toHaveLength(0);
  });

  it('says nothing about a kind the sheet does not classify', () => {
    // A kind inside the A2 range that the classifier did not return: no claim
    // either way is better than guessing at one.
    expect(checkGroundKinds([{ kind: 40, label: 'floorKind' }], sheet, 'Outside').refusal)
      .toBeNull();
  });
});

describe('checkGroundKinds when the sheet cannot be read', () => {
  it('does not refuse — a missing PNG should not fail a paint', () => {
    const result = checkGroundKinds([{ kind: 22, label: 'floorKind' }], null, 'Outside');

    expect(result.refusal).toBeNull();
  });

  it('stays quiet by default but says so when asked', () => {
    expect(checkGroundKinds([{ kind: 22, label: 'floorKind' }], null, 'Outside').notes)
      .toHaveLength(0);

    const loud = checkGroundKinds([{ kind: 22, label: 'floorKind' }], null, 'Outside', {
      reportUncheckable: true,
    });
    expect(loud.notes[0]).toContain('could not be read');
    expect(loud.notes[0]).toContain('floorKind');
  });

  it('stays quiet when nothing was going on layer 0 anyway', () => {
    const result = checkGroundKinds([{ kind: 22, label: 'propKind', layer: 2 }], null, 'Outside', {
      reportUncheckable: true,
    });

    expect(result.notes).toHaveLength(0);
  });
});

describe('the seamless note', () => {
  it('fires for a patch, where a seamless material has no visible boundary', () => {
    const result = checkGroundKinds(
      [{ kind: 16, label: 'roadKind', layer: 0, coversMap: false }],
      sheet,
      'Outside'
    );

    expect(result.refusal).toBeNull();
    expect(result.notes[0]).toContain('seamless fill');
    expect(result.notes[0]).toContain('roadKind');
  });

  it('stays quiet for a whole-map fill, which is what seamless is for', () => {
    const result = checkGroundKinds(
      [{ kind: 16, label: 'groundKind', layer: 0, coversMap: true }],
      sheet,
      'Outside'
    );

    expect(result.notes).toHaveLength(0);
  });

  it('does not fire for an outlined material', () => {
    const result = checkGroundKinds(
      [{ kind: 17, label: 'roadKind', layer: 0, coversMap: false }],
      sheet,
      'Outside'
    );

    expect(result.notes).toHaveLength(0);
  });

  it('is not reached when the same call is already being refused', () => {
    // A refusal means nothing is written, so advice about how it would look is
    // noise on top of it.
    const result = checkGroundKinds(
      [
        { kind: 22, label: 'floorKind', layer: 0 },
        { kind: 16, label: 'roadKind', layer: 0, coversMap: false },
      ],
      sheet,
      'Outside'
    );

    expect(result.refusal).not.toBeNull();
    expect(result.notes).toHaveLength(0);
  });
});

describe('overlayKindsAmong', () => {
  it('returns the kinds that must not go on layer 0, in order', () => {
    expect(overlayKindsAmong([23, 17, 22, 16], sheet)).toEqual([22, 23]);
  });

  it('ignores wall kinds and kinds the sheet does not classify', () => {
    expect(overlayKindsAmong([98, 40, 17], sheet)).toEqual([]);
  });

  it('claims nothing when the sheet could not be read', () => {
    expect(overlayKindsAmong([22, 23], null)).toEqual([]);
  });
});
