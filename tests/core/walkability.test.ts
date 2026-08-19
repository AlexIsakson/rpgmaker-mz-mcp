import { describe, it, expect } from 'vitest';
import { analyseWalkability, reachableFromLanding } from '../../src/core/walkability.js';
import type { MapData } from '../../src/schemas/map.js';

const FLOOR = 100;
const WALL = 200;
const TOTAL_LAYERS = 6;

/** flags[0] must carry the star bit or empty upper layers decide passage themselves. */
function makeFlags(): number[] {
  const flags = new Array(8192).fill(0);
  flags[0] = 0x10;
  flags[FLOOR] = 0x00; // passable from every direction
  flags[WALL] = 0x0f; // impassable from every direction
  return flags;
}

interface EventSpec {
  name: string;
  x: number;
  y: number;
  characterName?: string;
}

/** Build a map from an ASCII picture: '.' floor, '#' wall. */
function makeMap(rows: string[], events: EventSpec[] = []): MapData {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Array(width * height * TOTAL_LAYERS).fill(0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[(0 * height + y) * width + x] = rows[y][x] === '#' ? WALL : FLOOR;
    }
  }

  return {
    width,
    height,
    data,
    tilesetId: 1,
    events: events.map((e, i) => ({
      id: i + 1,
      name: e.name,
      x: e.x,
      y: e.y,
      pages: [{ image: { characterName: e.characterName ?? 'People1', characterIndex: 0 } }],
    })),
  } as unknown as MapData;
}

describe('analyseWalkability', () => {
  it('finds the whole of an open map reachable', () => {
    const report = analyseWalkability(makeMap([
      '.....',
      '.....',
      '.....',
    ]), makeFlags());

    expect(report.standableTiles).toBe(15);
    expect(report.reachableTiles).toBe(15);
    expect(report.issues).toEqual([]);
  });

  it('reports an event standing on a wall', () => {
    const report = analyseWalkability(makeMap([
      '.....',
      '..#..',
      '.....',
    ], [{ name: 'Stuck', x: 2, y: 1 }]), makeFlags());

    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].kind).toBe('event-on-wall');
    expect(report.issues[0].message).toContain('Stuck');
  });

  it('reports an event sealed inside a room', () => {
    const report = analyseWalkability(makeMap([
      '.......',
      '.#####.',
      '.#...#.',
      '.#####.',
      '.......',
    ], [{ name: 'Prisoner', x: 3, y: 2 }]), makeFlags());

    const kinds = report.issues.map((i) => i.kind);
    expect(kinds).toContain('event-unreachable');
    expect(kinds).toContain('isolated-area');
  });

  /**
   * The case that matters most for a town: the door tile itself is part of the
   * wall, so it is never "reachable". What has to be reachable is the tile the
   * player stands on to use it.
   */
  it('accepts a door whose approach tile is reachable', () => {
    const report = analyseWalkability(makeMap([
      '#####',
      '#####',
      '.....',
    ], [{ name: 'Door - Inn', x: 2, y: 1, characterName: '!Door1' }]), makeFlags());

    expect(report.issues).toEqual([]);
  });

  it('reports a door with no reachable tile in front of it', () => {
    const report = analyseWalkability(makeMap([
      '#####',
      '#####',
      '#####',
      '.....',
    ], [{ name: 'Door - Sealed', x: 2, y: 1, characterName: '!Door1' }]), makeFlags());

    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].kind).toBe('door-unreachable');
    expect(report.issues[0].message).toContain('Door - Sealed');
  });

  it('reports a door on the bottom row with no open tile on any side', () => {
    // Walled left, right and above, and the map edge below.
    const report = analyseWalkability(makeMap([
      '.....',
      '#####',
      '#####',
    ], [{ name: 'Door - Edge', x: 2, y: 2, characterName: '!Door1' }]), makeFlags());

    expect(report.issues.map((i) => i.kind)).toContain('door-unreachable');
  });

  it('accepts a door reachable only from above', () => {
    // A north-facing building: the door is on the top row of its footprint and
    // the street is above it. Checking only `y + 1` used to call this
    // unreachable, which made every north-facing door in a generated town look
    // broken when it was not.
    const report = analyseWalkability(makeMap([
      '.....',
      '#####',
    ], [{ name: 'Door - North', x: 2, y: 1, characterName: '!Door1' }]), makeFlags());

    expect(report.issues).toEqual([]);
  });

  it('treats the largest area as the main one, not whichever is scanned first', () => {
    // a two-tile pocket in the top-left corner, and a large area below it
    const report = analyseWalkability(makeMap([
      '..###',
      '#####',
      '.....',
      '.....',
      '.....',
    ]), makeFlags());

    expect(report.reachableTiles).toBe(15);
    expect(report.start?.y).toBe(2);
    expect(report.isolatedAreas[0].size).toBe(2);
  });

  it('ignores a stray pocket too small to matter', () => {
    const report = analyseWalkability(makeMap([
      '.####',
      '#####',
      '.....',
      '.....',
    ]), makeFlags());

    // one cut-off tile is tracked but not reported as an issue
    expect(report.isolatedAreas).toHaveLength(1);
    expect(report.issues).toEqual([]);
  });

  it('reports every tile walkable when the tileset has no star bit on tile 0', () => {
    const flags = makeFlags();
    flags[0] = 0; // the unconfigured-tileset case
    const report = analyseWalkability(makeMap([
      '.....',
      '.###.',
      '.....',
    ]), flags);

    // upper layers are empty and no longer fall through, so they answer "open"
    expect(report.standableTiles).toBe(15);
  });
});

describe('flooding from a known start', () => {
  /**
   * Two rooms, the left one bigger. Without a start the analysis calls the
   * bigger one "the main area" — which is the assumption that misreports an
   * interior, where the passable-but-unreachable wall tops around a room form a
   * larger area than the room itself.
   */
  const twoRooms = [
    '##########',
    '#....##..#',
    '#....##..#',
    '#....##..#',
    '#....##..#',
    '##########',
  ];

  it('calls the largest area the main one when nothing is given', () => {
    const report = analyseWalkability(makeMap(twoRooms), makeFlags());
    expect(report.startWasGiven).toBe(false);
    expect(report.reachableTiles).toBe(16); // the left room
    expect(report.isolatedAreas.map((a) => a.size)).toEqual([8]);
  });

  it('uses the area holding the start instead', () => {
    const report = analyseWalkability(makeMap(twoRooms), makeFlags(), { start: { x: 7, y: 1 } });
    expect(report.startWasGiven).toBe(true);
    expect(report.start).toEqual({ x: 7, y: 1 });
    expect(report.reachableTiles).toBe(8); // the right room, though it is smaller
    expect(report.isolatedAreas.map((a) => a.size)).toEqual([16]);
  });

  it('judges events against the area the start is in', () => {
    const events = [{ name: 'Innkeeper', x: 7, y: 2 }];
    const fromLeft = analyseWalkability(makeMap(twoRooms, events), makeFlags());
    expect(fromLeft.issues.map((i) => i.kind)).toContain('event-unreachable');

    const fromRight = analyseWalkability(makeMap(twoRooms, events), makeFlags(), {
      start: { x: 7, y: 1 },
    });
    expect(fromRight.issues.map((i) => i.kind)).not.toContain('event-unreachable');
  });

  it('falls back to the largest area when the start is inside a wall, and says so', () => {
    const report = analyseWalkability(makeMap(twoRooms), makeFlags(), { start: { x: 0, y: 0 } });
    expect(report.startUnstandable).toBe(true);
    expect(report.startWasGiven).toBe(false);
    expect(report.reachableTiles).toBe(16);
  });

  it('falls back when the start is off the map', () => {
    const report = analyseWalkability(makeMap(twoRooms), makeFlags(), { start: { x: 99, y: 99 } });
    expect(report.startUnstandable).toBe(true);
    expect(report.reachableTiles).toBe(16);
  });
});

describe('reachableFromLanding', () => {
  const twoRooms = [
    '##########',
    '#....##..#',
    '#....##..#',
    '#....##..#',
    '#....##..#',
    '##########',
  ];

  it('reports the landing area against the map\'s largest, for a landing in the big room', () => {
    const reach = reachableFromLanding(makeMap(twoRooms), makeFlags(), { x: 2, y: 2 });
    expect(reach.standable).toBe(true);
    expect(reach.reachableTiles).toBe(16);
    expect(reach.largestArea).toBe(16);
  });

  it('reports a small ratio for a landing in the smaller room, the pocket a real trap looks like', () => {
    const reach = reachableFromLanding(makeMap(twoRooms), makeFlags(), { x: 7, y: 2 });
    expect(reach.standable).toBe(true);
    expect(reach.reachableTiles).toBe(8);
    expect(reach.largestArea).toBe(16);
  });

  it('reports unstandable rather than a ratio for a wall tile', () => {
    const reach = reachableFromLanding(makeMap(twoRooms), makeFlags(), { x: 0, y: 0 });
    expect(reach.standable).toBe(false);
    expect(reach.reachableTiles).toBe(0);
  });

  it('reports unstandable for a point off the map', () => {
    const reach = reachableFromLanding(makeMap(twoRooms), makeFlags(), { x: 99, y: 99 });
    expect(reach.standable).toBe(false);
  });
});
