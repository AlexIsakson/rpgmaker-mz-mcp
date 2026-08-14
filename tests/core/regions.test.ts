import { describe, it, expect } from 'vitest';
import {
  paintRegionRect,
  paintRegionTiles,
  clearRegion,
  summariseRegions,
  readRegion,
  REGION_ID_MAX,
} from '../../src/core/regions.js';
import { tileIndex, REGION_LAYER } from '../../src/core/map-layers.js';
import { TILE_ID_A3, makeAutotileId } from '../../src/core/autotile.js';
import { renderRegionGrid, buildGrid, PASSAGE_BIT, FLAG_STAR } from '../../src/core/map-grid.js';
import type { MapData } from '../../src/schemas/map.js';

const GROUND = makeAutotileId(16, 0);
const WALL = TILE_ID_A3;
const TOTAL_LAYERS = 6;

/** '#' puts a wall on layer 1 over ground; '.' is ground only. */
function makeMap(rows: string[]): MapData {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Array(width * height * TOTAL_LAYERS).fill(0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[tileIndex(width, height, x, y, 0)] = GROUND;
      if (rows[y][x] === '#') data[tileIndex(width, height, x, y, 1)] = WALL;
    }
  }

  return { width, height, data, tilesetId: 1, events: [] } as unknown as MapData;
}

const blank = (w: number, h: number) => makeMap(Array.from({ length: h }, () => '.'.repeat(w)));

/**
 * Passage flags: ground passable from every side, the A3 wall blocked from
 * every side. `flags[0]` carries the star bit, as a configured tileset's does —
 * without it `checkPassage` lets the empty layers above a wall decide passage
 * and every tile reads as walkable.
 */
function makeFlags(): number[] {
  const flags = new Array(8192).fill(0);
  flags[0] = FLAG_STAR;
  const blocked = PASSAGE_BIT.down | PASSAGE_BIT.left | PASSAGE_BIT.right | PASSAGE_BIT.up;
  for (let i = TILE_ID_A3; i < 8192; i++) flags[i] = blocked;
  return flags;
}

const regionAt = (map: MapData, x: number, y: number) =>
  map.data[tileIndex(map.width, map.height, x, y, REGION_LAYER)];

describe('paintRegionRect', () => {
  it('writes the region plane and nothing else', () => {
    const map = blank(6, 5);
    const before = map.data.slice(0, 5 * 6 * 5);

    const result = paintRegionRect(map, { x: 1, y: 1, width: 3, height: 2 }, 7);

    expect(result.written).toBe(6);
    expect(regionAt(map, 1, 1)).toBe(7);
    expect(regionAt(map, 3, 2)).toBe(7);
    expect(regionAt(map, 4, 1)).toBe(0);
    // layers 0-4 untouched
    expect(map.data.slice(0, 5 * 6 * 5)).toEqual(before);
  });

  it('reads back what it wrote', () => {
    const map = blank(4, 4);
    paintRegionRect(map, { x: 0, y: 0, width: 2, height: 2 }, 12);

    expect(readRegion(map, 0, 0)).toBe(12);
    expect(readRegion(map, 1, 1)).toBe(12);
    expect(readRegion(map, 2, 2)).toBe(0);
  });

  it('reports tiles that already carried the id rather than counting them twice', () => {
    const map = blank(4, 4);
    paintRegionRect(map, { x: 0, y: 0, width: 2, height: 2 }, 3);
    const again = paintRegionRect(map, { x: 0, y: 0, width: 3, height: 2 }, 3);

    expect(again.unchanged).toBe(4);
    expect(again.written).toBe(2);
  });

  it('names the regions it took tiles from, because a tile has only one', () => {
    const map = blank(4, 4);
    paintRegionRect(map, { x: 0, y: 0, width: 4, height: 1 }, 1);
    const result = paintRegionRect(map, { x: 0, y: 0, width: 2, height: 2 }, 2);

    expect(result.replaced).toBe(2);
    expect(result.overwritten.get(1)).toBe(2);
    expect(regionAt(map, 0, 0)).toBe(2);
    expect(regionAt(map, 2, 0)).toBe(1);
  });

  it('clips a rectangle that runs past the edge, and says so', () => {
    const map = blank(4, 4);
    const result = paintRegionRect(map, { x: 2, y: 2, width: 10, height: 10 }, 5);

    expect(result.written).toBe(4);
    expect(result.clipped).toEqual({ x: 2, y: 2, width: 2, height: 2 });
  });

  it('refuses a rectangle entirely off the map instead of writing nothing quietly', () => {
    const map = blank(4, 4);
    expect(() => paintRegionRect(map, { x: 9, y: 9, width: 2, height: 2 }, 5))
      .toThrow(/entirely outside/);
  });

  it('erases with region 0', () => {
    const map = blank(4, 4);
    paintRegionRect(map, { x: 0, y: 0, width: 4, height: 4 }, 8);
    const result = paintRegionRect(map, { x: 1, y: 1, width: 2, height: 2 }, 0);

    expect(result.written).toBe(4);
    expect(regionAt(map, 1, 1)).toBe(0);
    expect(regionAt(map, 0, 0)).toBe(8);
  });

  it("refuses an id outside the editor's palette", () => {
    const map = blank(4, 4);
    expect(() => paintRegionRect(map, { x: 0, y: 0, width: 1, height: 1 }, 256))
      .toThrow(new RegExp(`outside 0-${REGION_ID_MAX}`));
    expect(() => paintRegionRect(map, { x: 0, y: 0, width: 1, height: 1 }, -1))
      .toThrow(/outside/);
  });

  it('accepts the whole palette', () => {
    const map = blank(4, 4);
    for (const id of [1, 128, REGION_ID_MAX]) {
      expect(() => paintRegionRect(map, { x: 0, y: 0, width: 1, height: 1 }, id)).not.toThrow();
      expect(regionAt(map, 0, 0)).toBe(id);
    }
  });
});

describe('paintRegionTiles', () => {
  it('paints individual tiles, later entries winning', () => {
    const map = blank(4, 4);
    const result = paintRegionTiles(map, [
      { x: 0, y: 0, regionId: 1 },
      { x: 1, y: 1, regionId: 2 },
      { x: 0, y: 0, regionId: 3 },
    ]);

    expect(regionAt(map, 0, 0)).toBe(3);
    expect(regionAt(map, 1, 1)).toBe(2);
    expect(result.written).toBe(3);
  });

  it('writes nothing at all when one tile is off the map', () => {
    const map = blank(4, 4);
    expect(() =>
      paintRegionTiles(map, [
        { x: 0, y: 0, regionId: 1 },
        { x: 9, y: 0, regionId: 1 },
      ])
    ).toThrow(/outside the 4x4 map/);

    expect(regionAt(map, 0, 0)).toBe(0);
  });

  it('validates every id before writing any tile', () => {
    const map = blank(4, 4);
    expect(() =>
      paintRegionTiles(map, [
        { x: 0, y: 0, regionId: 1 },
        { x: 1, y: 0, regionId: 900 },
      ])
    ).toThrow(/outside/);

    expect(regionAt(map, 0, 0)).toBe(0);
  });
});

describe('clearRegion', () => {
  it('erases one region and leaves the others', () => {
    const map = blank(5, 5);
    paintRegionRect(map, { x: 0, y: 0, width: 5, height: 1 }, 1);
    paintRegionRect(map, { x: 0, y: 1, width: 5, height: 1 }, 2);

    expect(clearRegion(map, 1)).toBe(5);
    expect(regionAt(map, 0, 0)).toBe(0);
    expect(regionAt(map, 0, 1)).toBe(2);
  });

  it('refuses to "clear region 0", which would mean clearing nothing', () => {
    expect(() => clearRegion(blank(4, 4), 0)).toThrow(/outside 1-/);
  });
});

describe('summariseRegions', () => {
  it('counts tiles, bounds and connected areas per id', () => {
    const map = blank(8, 4);
    paintRegionRect(map, { x: 0, y: 0, width: 2, height: 2 }, 4);
    paintRegionRect(map, { x: 6, y: 2, width: 2, height: 2 }, 4);
    paintRegionRect(map, { x: 3, y: 1, width: 1, height: 1 }, 9);

    const areas = summariseRegions(map);
    expect(areas.map((a) => a.regionId)).toEqual([4, 9]);

    const four = areas[0];
    expect(four.tiles).toBe(8);
    expect(four.areas).toBe(2);
    expect(four.bounds).toEqual({ x: 0, y: 0, width: 8, height: 4 });

    expect(areas[1].tiles).toBe(1);
    expect(areas[1].areas).toBe(1);
  });

  it('joins diagonally-touching blocks into separate areas, matching 4-connectivity', () => {
    const map = blank(4, 4);
    paintRegionTiles(map, [
      { x: 0, y: 0, regionId: 1 },
      { x: 1, y: 1, regionId: 1 },
    ]);

    expect(summariseRegions(map)[0].areas).toBe(2);
  });

  it('reports how much of a region the player can never stand on', () => {
    const map = makeMap([
      '....',
      '.##.',
      '....',
    ]);
    paintRegionRect(map, { x: 0, y: 1, width: 4, height: 1 }, 3);

    const [area] = summariseRegions(map, makeFlags());
    expect(area.tiles).toBe(4);
    expect(area.impassable).toBe(2);
  });

  it('reports impassable as 0 when no flags are given, rather than guessing', () => {
    const map = makeMap(['##', '##']);
    paintRegionRect(map, { x: 0, y: 0, width: 2, height: 2 }, 3);

    expect(summariseRegions(map)[0].impassable).toBe(0);
  });

  it('is empty for a map with no regions', () => {
    expect(summariseRegions(blank(4, 4))).toEqual([]);
  });
});

describe('renderRegionGrid', () => {
  it('prints single-digit ids as themselves and empty tiles as a dot', () => {
    const map = blank(4, 3);
    paintRegionRect(map, { x: 1, y: 1, width: 2, height: 1 }, 7);

    const { text, legend } = renderRegionGrid(buildGrid(map, makeFlags()));
    const rows = text.split('\n').slice(1).map((l) => l.slice(2));

    expect(rows).toEqual(['....', '.77.', '....']);
    expect(legend).toEqual([]);
  });

  it('gives ids above 9 a letter and a legend line', () => {
    const map = blank(4, 2);
    paintRegionTiles(map, [
      { x: 0, y: 0, regionId: 10 },
      { x: 1, y: 0, regionId: 200 },
      { x: 2, y: 0, regionId: 3 },
    ]);

    const { text, legend } = renderRegionGrid(buildGrid(map, makeFlags()));
    const row = text.split('\n').slice(1)[0].slice(2);

    expect(row).toBe('ab3.');
    expect(legend).toEqual(['a = region 10', 'b = region 200']);
  });

  it('windows to the given bounds', () => {
    const map = blank(6, 6);
    paintRegionRect(map, { x: 0, y: 0, width: 6, height: 6 }, 1);

    const { text } = renderRegionGrid(buildGrid(map, makeFlags()), { x: 2, y: 2, width: 2, height: 2 });
    const rows = text.split('\n').slice(1).map((l) => l.slice(2));

    expect(rows).toEqual(['11', '11']);
  });
});
