import { describe, it, expect } from 'vitest';
import { buildGrid, readTile, renderAsciiGrid, PASSAGE_BIT, FLAG_STAR, FLAG_LADDER, FLAG_DAMAGE_FLOOR } from '../../src/core/map-grid.js';
import { defaultMap } from '../../src/templates/defaults.js';
import type { MapData } from '../../src/schemas/map.js';

/** Sets layer-0 tile IDs across a map's `data` array from a row-major grid of numbers. */
function paintLayer0(map: MapData, tileIds: number[][]): void {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      map.data[(0 * map.height + y) * map.width + x] = tileIds[y][x];
    }
  }
}

describe('readTile passability', () => {
  it('reports fully open tile as passable in all directions and not a wall', () => {
    const map = defaultMap(3, 3, 1);
    // tile ID 1 -> flags[1] = 0 (no bits set = passable everywhere)
    const flags: number[] = [];
    flags[1] = 0x0;
    paintLayer0(map, [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]);

    const tile = readTile(map, flags, 1, 1);
    expect(tile.passable).toEqual({ up: true, down: true, left: true, right: true });
    expect(tile.isWall).toBe(false);
  });

  it('reports a tile blocked in all 4 directions as a wall', () => {
    const map = defaultMap(3, 3, 1);
    const flags: number[] = [];
    // flags[0] = star: real tilesets set this so empty upper layers (unpainted
    // z1-z3) fall through to the ground layer instead of resolving passage
    // themselves — verified against a populated Tilesets.json shipped with MZ.
    flags[0] = FLAG_STAR;
    flags[2] = PASSAGE_BIT.up | PASSAGE_BIT.down | PASSAGE_BIT.left | PASSAGE_BIT.right;
    paintLayer0(map, [
      [1, 1, 1],
      [1, 2, 1],
      [1, 1, 1],
    ]);

    const tile = readTile(map, flags, 1, 1);
    expect(tile.passable).toEqual({ up: false, down: false, left: false, right: false });
    expect(tile.isWall).toBe(true);
  });

  it('reports partial blocking correctly (e.g. a one-way ledge)', () => {
    const map = defaultMap(1, 1, 1);
    const flags: number[] = [];
    flags[0] = FLAG_STAR; // let the empty upper layers fall through to layer 0
    flags[3] = PASSAGE_BIT.down; // blocked from the south only
    paintLayer0(map, [[3]]);

    const tile = readTile(map, flags, 0, 0);
    expect(tile.passable).toEqual({ up: true, down: false, left: true, right: true });
    expect(tile.isWall).toBe(false);
  });

  it('star flag on the top layer falls through to the layer below', () => {
    const map = defaultMap(1, 1, 1);
    const flags: number[] = [];
    flags[10] = 0x0; // layer 0: fully open
    flags[20] = FLAG_STAR | PASSAGE_BIT.up | PASSAGE_BIT.down | PASSAGE_BIT.left | PASSAGE_BIT.right; // layer 3: starred wall

    map.data[(0 * map.height + 0) * map.width + 0] = 10; // z0
    map.data[(3 * map.height + 0) * map.width + 0] = 20; // z3, starred

    const tile = readTile(map, flags, 0, 0);
    // The starred layer-3 tile is skipped for passage, so layer 0's open flags apply.
    expect(tile.passable).toEqual({ up: true, down: true, left: true, right: true });
    expect(tile.isWall).toBe(false);
  });

  it('detects ladder and damage floor flags independent of passability', () => {
    const map = defaultMap(1, 1, 1);
    const flags: number[] = [];
    flags[5] = FLAG_LADDER | FLAG_DAMAGE_FLOOR;
    paintLayer0(map, [[5]]);

    const tile = readTile(map, flags, 0, 0);
    expect(tile.isLadder).toBe(true);
    expect(tile.isDamageFloor).toBe(true);
  });

  it('reads terrain tag from the top 4 bits of the topmost tagged layer', () => {
    const map = defaultMap(1, 1, 1);
    const flags: number[] = [];
    flags[7] = 3 << 12; // terrain tag 3
    paintLayer0(map, [[7]]);

    const tile = readTile(map, flags, 0, 0);
    expect(tile.terrainTag).toBe(3);
  });

  it('an unpainted map with no flags configured is passable everywhere (engine quirk)', () => {
    // If a tileset's flags[0] is never set to the star bit — e.g. a brand-new,
    // unconfigured tileset — empty upper layers resolve passage themselves
    // (as "open") instead of falling through to the ground layer. In the real
    // engine this means impassability set on ground autotiles has no effect
    // until the tileset's passage settings are actually configured.
    const map = defaultMap(1, 1, 1);
    const tile = readTile(map, [], 0, 0);
    expect(tile.passable).toEqual({ up: true, down: true, left: true, right: true });
    expect(tile.isWall).toBe(false);
  });
});

describe('buildGrid', () => {
  it('produces height rows of width columns', () => {
    const map = defaultMap(4, 3, 1);
    const grid = buildGrid(map, []);
    expect(grid).toHaveLength(3);
    expect(grid[0]).toHaveLength(4);
    expect(grid[1][2].x).toBe(2);
    expect(grid[1][2].y).toBe(1);
  });
});

describe('renderAsciiGrid', () => {
  it('renders walls, floor, and an event marker with a legend', () => {
    const map = defaultMap(3, 1, 1);
    const flags: number[] = [];
    flags[0] = FLAG_STAR; // empty upper layers fall through to layer 0
    flags[1] = 0x0; // open
    flags[2] = PASSAGE_BIT.up | PASSAGE_BIT.down | PASSAGE_BIT.left | PASSAGE_BIT.right; // wall
    paintLayer0(map, [[1, 2, 1]]);

    const grid = buildGrid(map, flags);
    const { text, legend, truncatedEvents } = renderAsciiGrid(grid, [
      { id: 1, name: 'Shopkeeper', x: 0, y: 0 },
    ]);

    expect(text).toContain('1#.'); // event marker overrides the floor glyph at (0,0), wall at (1,0)
    expect(legend).toEqual(['1 = event [1] "Shopkeeper" at (0, 0)']);
    expect(truncatedEvents).toBe(false);
  });

  it('windows the grid to the requested x/y/width/height', () => {
    const map = defaultMap(5, 5, 1);
    const grid = buildGrid(map, []); // unconfigured flags -> passable everywhere
    const { text } = renderAsciiGrid(grid, [], { x: 1, y: 1, width: 2, height: 2 });
    const rows = text.split('\n');
    const tileRows = rows.slice(-2); // last 2 lines are the tile rows for a 2x2 window
    expect(tileRows).toHaveLength(2);
    expect(tileRows.every((r) => r.trim().endsWith('..'))).toBe(true);
  });
});
