import path from 'node:path';
import fs from 'node:fs/promises';
import { PNG } from 'pngjs';
import { TILE_ID_A2, TILE_ID_A3, getAutotileKind } from './autotile.js';
import { sheetColumn, sheetRow } from './blueprint.js';

/**
 * Two properties of an A2 ground material decide whether painting it will look
 * right, and neither can be worked out from the map data — both live in the
 * tileset image:
 *
 *  - **Is it opaque?** Half the A2 sheet is overlay material whose edge pieces
 *    are transparent. Painted on layer 0 those edges show the map background,
 *    which renders black in game. They belong on layer 1 or above, over ground.
 *
 *  - **Does it have an outline?** A seamless fill draws its edge pieces
 *    identically to its middle, so a patch of it has no visible boundary and
 *    reads as a floating slab rather than a path.
 *
 * Which slots are which varies by tileset, and **no column rule survives
 * contact with the four A2 sheets the RTP ships.** Measured with
 * `scripts/measure-a2-columns.mjs` over all 128 of their kinds: the columns
 * that are opaque *and* outlined in every row of their sheet are 1-3 in
 * `Outside_A2`, 3 alone in `Inside_A2`, 2-5 in `Dungeon_A2` and 0 alone in
 * `World_A2` — an empty intersection. Column 0 is the seamless fill in 12 of
 * 16 rows, but all four exceptions are `World_A2`, where column 0 is the only
 * safe column there is. So this is measured per sheet, not tabulated.
 *
 * The A2 sheet is 8 blocks across and 4 down; each block is 2 tiles wide by 3
 * tall, addressed in half-tiles as `bx = (kind % 8) * 2`, `by = (floor(kind / 8)
 * - 2) * 3`, matching Tilemap._addAutotile in the corescript.
 */

export const A2_KIND_MIN = getAutotileKind(TILE_ID_A2);
export const A2_KIND_MAX = getAutotileKind(TILE_ID_A3) - 1;

const HALF_TILE = 24;
const OPAQUE_ALPHA = 200;

/**
 * Quadrant coordinates come straight from FLOOR_AUTOTILE_TABLE. Shape 0 (fully
 * surrounded) draws (2,4) (1,4) (2,3) (1,3), so the middle is x 1-2, y 3-4.
 * Shape 46 (isolated, edged on all four sides) draws (0,2) (3,2) (0,5) (3,5),
 * so the edges run along x 0 and 3 and y 2 and 5.
 */
const CENTRE_QUADS: [number, number][] = [[1, 3], [2, 3], [1, 4], [2, 4]];
const EDGE_QUADS: [number, number][] = [
  [0, 3], [0, 4], [3, 3], [3, 4],   // left and right edges
  [1, 2], [2, 2], [1, 5], [2, 5],   // top and bottom edges
  [0, 2], [3, 2], [0, 5], [3, 5],   // outer corners
];

export type Opacity = 'ground' | 'overlay' | 'empty';
export type Outline = 'outlined' | 'seamless';

export interface A2Material {
  kind: number;
  /**
   * Column within the A2 sheet, 0-7. Reported so a caller can see the sheet's
   * layout — not so it can predict `opacity` or `outline` from it, which the
   * measurement above shows does not work.
   */
  column: number;
  row: number;
  opacity: Opacity;
  outline: Outline;
  /** Fraction of the middle that is opaque, 0-1. */
  centreOpacity: number;
  /** Fraction of the edge pieces that are opaque, 0-1. */
  edgeOpacity: number;
  /** How different the edge pieces look from the middle, 0-1. */
  edgeContrast: number;
}

export interface Rgba {
  width: number;
  height: number;
  data: Buffer;
}

interface Quadrant {
  opaque: number;
  /** Mean colour, premultiplied against black so transparency reads as dark. */
  mean: [number, number, number];
}

function sampleQuadrant(img: Rgba, bx: number, by: number, qsx: number, qsy: number): Quadrant {
  let opaque = 0;
  let total = 0;
  const sum: [number, number, number] = [0, 0, 0];

  for (let y = 0; y < HALF_TILE; y++) {
    for (let x = 0; x < HALF_TILE; x++) {
      const px = (bx * 2 + qsx) * HALF_TILE + x;
      const py = (by * 2 + qsy) * HALF_TILE + y;
      if (px >= img.width || py >= img.height) continue;
      const i = (py * img.width + px) * 4;
      total++;
      const alpha = img.data[i + 3];
      if (alpha > OPAQUE_ALPHA) opaque++;
      const a = alpha / 255;
      sum[0] += img.data[i] * a;
      sum[1] += img.data[i + 1] * a;
      sum[2] += img.data[i + 2] * a;
    }
  }

  if (total === 0) return { opaque: 0, mean: [0, 0, 0] };
  return {
    opaque: opaque / total,
    mean: [sum[0] / total, sum[1] / total, sum[2] / total],
  };
}

/**
 * Distance between two quadrants' mean colours, 0-1.
 *
 * Comparing means rather than pixels is what makes this work on noisy
 * materials: a field of cobblestones differs from itself pixel by pixel almost
 * as much as it differs from grass, but its *average* colour is stable, so a
 * fringe of a different material moves the mean and a seamless fill does not.
 */
function meanDistance(a: Quadrant, b: Quadrant): number {
  const d =
    Math.abs(a.mean[0] - b.mean[0]) +
    Math.abs(a.mean[1] - b.mean[1]) +
    Math.abs(a.mean[2] - b.mean[2]);
  return d / (3 * 255);
}

/**
 * Classify every A2 kind in a decoded A2 sheet.
 *
 * `edgeContrast` compares each edge piece against the middle. A seamless fill
 * draws the same texture everywhere, so the difference is close to the
 * difference between two arbitrary patches of that texture — which is why the
 * threshold is calibrated against the middle's own internal variation rather
 * than against zero.
 */
export function classifyA2Sheet(img: Rgba): A2Material[] {
  const materials: A2Material[] = [];

  for (let kind = A2_KIND_MIN; kind <= A2_KIND_MAX; kind++) {
    const column = kind % 8;
    const row = Math.floor(kind / 8) - 2;
    const bx = column * 2;
    const by = row * 3;

    const centre = CENTRE_QUADS.map(([qx, qy]) => sampleQuadrant(img, bx, by, qx, qy));
    const edges = EDGE_QUADS.map(([qx, qy]) => sampleQuadrant(img, bx, by, qx, qy));

    const centreOpacity = centre.reduce((s, c) => s + c.opaque, 0) / centre.length;
    const edgeOpacity = edges.reduce((s, e) => s + e.opaque, 0) / edges.length;

    // how much the middle quadrants differ from each other — the material's own noise
    let baseline = 0;
    for (let i = 1; i < centre.length; i++) {
      baseline = Math.max(baseline, meanDistance(centre[0], centre[i]));
    }

    let edgeContrast = 0;
    for (const edge of edges) {
      edgeContrast = Math.max(edgeContrast, meanDistance(centre[0], edge));
    }

    const opacity: Opacity =
      centreOpacity < 0.5 ? 'empty' : edgeOpacity < 0.9 ? 'overlay' : 'ground';

    // an outline has to stand clear of the material's own variation
    const outline: Outline = edgeContrast > baseline + 0.02 ? 'outlined' : 'seamless';

    materials.push({
      kind, column, row, opacity, outline,
      centreOpacity: Number(centreOpacity.toFixed(3)),
      edgeOpacity: Number(edgeOpacity.toFixed(3)),
      edgeContrast: Number(edgeContrast.toFixed(3)),
    });
  }

  return materials;
}

/** Cache keyed by resolved image path — sheets never change during a session. */
const cache = new Map<string, A2Material[] | null>();

/**
 * Classify the A2 materials of a tileset. Returns null when the sheet is
 * missing or unreadable, so callers can degrade to "no advice" rather than
 * failing a paint operation over a missing image.
 */
export async function loadA2Materials(
  projectPath: string,
  tilesetNames: string[]
): Promise<A2Material[] | null> {
  const sheetName = tilesetNames[1]; // set number 1 is the A2 sheet
  if (!sheetName) return null;

  const file = path.join(projectPath, 'img', 'tilesets', `${sheetName}.png`);
  if (cache.has(file)) return cache.get(file) ?? null;

  let result: A2Material[] | null = null;
  try {
    const png = PNG.sync.read(await fs.readFile(file));
    result = classifyA2Sheet(png);
  } catch {
    result = null;
  }

  cache.set(file, result);
  return result;
}

export function clearMaterialCache(): void {
  cache.clear();
  objectSheetCache.clear();
}

// --- Object sheets (B/C/D/E) ------------------------------------------------

const TILE_SIZE = 48;

/**
 * Which of the given object tiles have transparent pixels.
 *
 * This is the same problem finding 1 raised for A2 overlays, in a different
 * place: a roof set's sloped corner pieces are cut diagonally, so wherever the
 * slope has been cut away the tile shows whatever is on the layer below. With
 * nothing below, that is the map background — black in game. Knowing *which*
 * cells of a set are cut means only those cells need ground beneath them, rather
 * than refusing to place a roof over any empty tile.
 */
export function findTransparentTiles(img: Rgba, tileIds: number[]): Set<number> {
  const transparent = new Set<number>();

  for (const tileId of tileIds) {
    const ox = sheetColumn(tileId) * TILE_SIZE;
    const oy = sheetRow(tileId) * TILE_SIZE;
    let holes = 0;

    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const px = ox + x;
        const py = oy + y;
        if (px >= img.width || py >= img.height) continue;
        if (img.data[(py * img.width + px) * 4 + 3] <= OPAQUE_ALPHA) holes++;
      }
    }

    // A handful of soft edge pixels is antialiasing; a cut corner is thousands.
    if (holes > TILE_SIZE * 2) transparent.add(tileId);
  }

  return transparent;
}

const objectSheetCache = new Map<string, PNG | null>();

async function loadSheet(projectPath: string, sheetName: string): Promise<PNG | null> {
  const file = path.join(projectPath, 'img', 'tilesets', `${sheetName}.png`);
  if (objectSheetCache.has(file)) return objectSheetCache.get(file) ?? null;

  let png: PNG | null = null;
  try {
    png = PNG.sync.read(await fs.readFile(file));
  } catch {
    png = null;
  }

  objectSheetCache.set(file, png);
  return png;
}

/**
 * Which of `tileIds` are cut away in the given sheet. Returns null when the
 * image is missing or unreadable, so a caller can degrade to "no advice" rather
 * than refuse to place a building over a missing PNG.
 */
export async function loadTransparentObjectTiles(
  projectPath: string,
  sheetName: string,
  tileIds: number[]
): Promise<Set<number> | null> {
  const png = await loadSheet(projectPath, sheetName);
  if (!png) return null;
  return findTransparentTiles(png, tileIds);
}
