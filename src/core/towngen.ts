import { makeRng } from './mapgen.js';
import type { Rect } from './autotile.js';

/**
 * Town layout.
 *
 * This plans and nothing else: it decides where the roads, the buildings, the
 * doors and the decoration go, and hands back a description. Turning that into
 * tiles is the tool's job, and it does it with the primitives that already
 * exist — `fill_map_region` for ground and roads, `placeBuildingOnMap` for each
 * house, `place_prop` for the props. Keeping the two apart is what makes the
 * layout testable: every property below is asserted against the plan, with no
 * map file involved.
 *
 * **The layout is built around a constraint of the building primitive.** A
 * door sits on the bottom wall row and is approached from the tile below it, so
 * a building only works if there is a road immediately beneath it. The whole
 * town therefore reads as horizontal bands, each one a row of buildings sitting
 * on the street it faces:
 *
 *     ~~~~~~~~~~~~~~~~   frame
 *     ###  ###   ####    band  — buildings, bottom-aligned
 *     ================   road  — full width, so it reaches both map edges
 *     ####  ###  ###     band
 *     ================   road
 *     ~~~~~~~~~~~~~~~~   frame
 *
 * Cross streets run the full height and intersect every road, which is what
 * makes the network connected **by construction** rather than by luck — the
 * same reasoning the dungeon generator uses for its corridors. They also cut
 * the frame at four points, so the town has entrances instead of being sealed
 * inside its own tree line.
 */

export interface TownOptions {
  width: number;
  height: number;
  seed: number;
  /** Tiles reserved around the edge for framing. */
  border: number;
  /** Thickness of every street. */
  roadWidth: number;
  /** Height of a building band, including the gap above the buildings. */
  bandHeight: number;
  minBuildingWidth: number;
  maxBuildingWidth: number;
  minBuildingHeight: number;
  maxBuildingHeight: number;
  /** Rows of wall at the bottom of each building; the rest is roof. */
  wallHeight: number;
  /** Vertical streets. At least one, or the horizontal roads never meet. */
  crossStreets: number;
  /** Fraction of the free ground that gets a prop, 0-1. */
  decorDensity: number;
  /** Height of the props used to frame the map edge. */
  framePropHeight: number;
}

export const TOWN_DEFAULTS: Omit<TownOptions, 'width' | 'height' | 'seed'> = {
  border: 3,
  roadWidth: 2,
  bandHeight: 7,
  minBuildingWidth: 4,
  maxBuildingWidth: 7,
  minBuildingHeight: 4,
  maxBuildingHeight: 6,
  wallHeight: 2,
  crossStreets: 2,
  decorDensity: 0.08,
  framePropHeight: 2,
};

export interface TownBuilding {
  rect: Rect;
  wallHeight: number;
  /** Door column within the footprint. */
  doorOffsetX: number;
  /** Absolute door tile, and the tile the player stands on to use it. */
  door: { x: number; y: number; approach: { x: number; y: number } };
  /** Pick a roof with `variant % choices.length`. */
  variant: number;
}

export interface Slot {
  x: number;
  y: number;
}

export interface TownPlan {
  width: number;
  height: number;
  roads: Rect[];
  bands: Rect[];
  buildings: TownBuilding[];
  /** Free ground inside the town, chosen for props. */
  decorSlots: Slot[];
  /** Top-left cells for the framing props around the edge. */
  frameSlots: Slot[];
  warnings: string[];
}

export class TownError extends Error {}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

/** Fisher-Yates, driven by the seeded RNG so a seed reproduces the whole plan. */
function shuffle<T>(rng: () => number, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function planTown(options: TownOptions): TownPlan {
  const {
    width, height, seed, border, roadWidth, bandHeight,
    minBuildingWidth, maxBuildingWidth, minBuildingHeight, maxBuildingHeight,
    wallHeight, crossStreets, decorDensity, framePropHeight,
  } = options;

  if (crossStreets < 1) {
    throw new TownError(
      'A town needs at least one cross street: the horizontal roads run parallel and only meet ' +
        'where a vertical one crosses them, so with none the streets would be disconnected.'
    );
  }
  // A nine-slice roof needs two rows, so a building is never shorter than
  // wallHeight + 2 — and the band has to hold one with a row to spare above it.
  const minHeight = Math.max(minBuildingHeight, wallHeight + 2);
  if (minHeight > maxBuildingHeight) {
    throw new TownError(
      `maxBuildingHeight ${maxBuildingHeight} is below the minimum a building can be ` +
        `(${minHeight} = wallHeight ${wallHeight} plus two roof rows).`
    );
  }
  if (bandHeight <= minHeight) {
    throw new TownError(
      `bandHeight ${bandHeight} leaves no gap above a ${minHeight}-tall building. Give the band ` +
        'at least one row more than the shortest building.'
    );
  }
  if (minBuildingWidth < 2) {
    throw new TownError('minBuildingWidth must be at least 2 — a nine-slice roof has no 1-wide form.');
  }

  const warnings: string[] = [];
  const rng = makeRng(seed);

  const usable: Rect = {
    x: border,
    y: border,
    width: width - border * 2,
    height: height - border * 2,
  };
  if (usable.width < minBuildingWidth + 2 || usable.height < bandHeight + roadWidth) {
    throw new TownError(
      `A ${width}x${height} map with a ${border}-tile border leaves ${usable.width}x${usable.height} ` +
        `to build in, which is not enough for one band (${bandHeight} rows) and its road ` +
        `(${roadWidth} rows). Make the map bigger or the border, band or buildings smaller.`
    );
  }

  // --- streets ---
  const roads: Rect[] = [];
  const bands: Rect[] = [];
  for (let y = usable.y; y + bandHeight + roadWidth <= usable.y + usable.height; ) {
    bands.push({ x: usable.x, y, width: usable.width, height: bandHeight });
    // Roads span the full map so they reach the edge and become entrances.
    roads.push({ x: 0, y: y + bandHeight, width, height: roadWidth });
    y += bandHeight + roadWidth;
  }
  if (bands.length === 0) {
    throw new TownError('The map is too short to hold a single band of buildings and its road.');
  }

  // Cross streets: spread across the usable width, jittered, never touching.
  const verticals: Rect[] = [];
  const slotWidth = Math.floor(usable.width / crossStreets);
  if (slotWidth < roadWidth + minBuildingWidth + 2) {
    throw new TownError(
      `${crossStreets} cross streets leave only ${slotWidth} tiles between them, which cannot ` +
        `hold a road (${roadWidth}) and a ${minBuildingWidth}-wide building. Use fewer.`
    );
  }
  for (let i = 0; i < crossStreets; i++) {
    const lo = usable.x + i * slotWidth + 1;
    const hi = usable.x + (i + 1) * slotWidth - roadWidth - 1;
    const x = hi > lo ? randInt(rng, lo, hi) : lo;
    verticals.push({ x, y: 0, width: roadWidth, height });
  }
  roads.push(...verticals);

  const onRoad = (x: number, y: number): boolean => roads.some((r) => inRect(r, x, y));

  // --- buildings ---
  const buildings: TownBuilding[] = [];
  for (const band of bands) {
    // A band is cut into segments by the cross streets.
    const cuts = verticals
      .map((v) => ({ from: v.x, to: v.x + v.width }))
      .sort((a, b) => a.from - b.from);

    const segments: { x: number; width: number }[] = [];
    let cursor = band.x;
    for (const cut of cuts) {
      if (cut.from > cursor) segments.push({ x: cursor, width: cut.from - cursor });
      cursor = Math.max(cursor, cut.to);
    }
    if (cursor < band.x + band.width) {
      segments.push({ x: cursor, width: band.x + band.width - cursor });
    }

    for (const segment of segments) {
      // One tile of clearance at each end so a wall never sits flush against a
      // cross street.
      let x = segment.x + 1;
      const limit = segment.x + segment.width - 1;

      while (x + minBuildingWidth <= limit) {
        const maxW = Math.min(maxBuildingWidth, limit - x);
        const w = randInt(rng, minBuildingWidth, maxW);
        const h = randInt(rng, minHeight, Math.min(maxBuildingHeight, bandHeight - 1));

        const rect: Rect = { x, y: band.y + band.height - h, width: w, height: h };
        const doorOffsetX = w >= 3 ? randInt(rng, 1, w - 2) : 0;
        const doorX = rect.x + doorOffsetX;
        const doorY = rect.y + rect.height - 1;

        buildings.push({
          rect,
          wallHeight,
          doorOffsetX,
          door: { x: doorX, y: doorY, approach: { x: doorX, y: doorY + 1 } },
          variant: randInt(rng, 0, 1023),
        });

        x += w + randInt(rng, 1, 3);
      }
    }
  }

  if (buildings.length === 0) {
    warnings.push(
      'No building fitted: every band segment was narrower than minBuildingWidth plus its ' +
        'clearance. The town is streets and scenery only.'
    );
  }

  // --- what is taken ---
  const taken: boolean[][] = Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
  for (const road of roads) {
    for (let y = road.y; y < road.y + road.height; y++) {
      for (let x = road.x; x < road.x + road.width; x++) taken[y][x] = true;
    }
  }
  for (const building of buildings) {
    const r = building.rect;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) taken[y][x] = true;
    }
  }

  // --- decoration ---
  // Only free ground inside the town, so nothing lands on a roof or in the
  // street — the placement audit finding, applied before anything is written
  // rather than reported after.
  //
  // Props are drawn from the tiles beside a wall or a street before the open
  // middle of a block. Scattering uniformly instead puts a lone crate in the
  // centre of a field, which is what the first render of this generator looked
  // like: things people leave outside belong against the things they belong to.
  const near: Slot[] = [];
  const far: Slot[] = [];
  const nextTo = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (taken[ny][nx]) return true;
      }
    }
    return false;
  };
  for (let y = usable.y; y < usable.y + usable.height; y++) {
    for (let x = usable.x; x < usable.x + usable.width; x++) {
      if (taken[y][x]) continue;
      (nextTo(x, y) ? near : far).push({ x, y });
    }
  }
  const wanted = Math.floor((near.length + far.length) * decorDensity);
  const decorSlots = [...shuffle(rng, near), ...shuffle(rng, far)].slice(0, wanted);

  // --- frame ---
  // The outermost ring is left clear so the strip outside the trees stays
  // joined to the roads that cut through them; framing props fill the rest of
  // the border band.
  const frameSlots: Slot[] = [];
  const used: boolean[][] = Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
  const inFrame = (x: number, y: number): boolean =>
    x >= 1 && y >= 1 && x < width - 1 && y < height - 1 && !inRect(usable, x, y);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (!inFrame(x, y) || used[y][x]) continue;
      let fits = true;
      for (let dy = 0; dy < framePropHeight; dy++) {
        if (!inFrame(x, y + dy) || used[y + dy][x] || onRoad(x, y + dy)) fits = false;
      }
      if (!fits) continue;
      for (let dy = 0; dy < framePropHeight; dy++) used[y + dy][x] = true;
      frameSlots.push({ x, y });
    }
  }

  return { width, height, roads, bands, buildings, decorSlots, frameSlots, warnings };
}

/**
 * The plan as text: `#` building, `+` door, `=` road, `T` frame prop, `o` decor,
 * `.` open ground.
 */
export function renderTownAscii(plan: TownPlan): string {
  const grid: string[][] = Array.from({ length: plan.height }, () =>
    new Array<string>(plan.width).fill('.')
  );

  for (const road of plan.roads) {
    for (let y = road.y; y < road.y + road.height; y++) {
      for (let x = road.x; x < road.x + road.width; x++) grid[y][x] = '=';
    }
  }
  for (const slot of plan.frameSlots) grid[slot.y][slot.x] = 'T';
  for (const slot of plan.decorSlots) grid[slot.y][slot.x] = 'o';
  for (const building of plan.buildings) {
    const r = building.rect;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) grid[y][x] = '#';
    }
    grid[building.door.y][building.door.x] = '+';
  }

  return grid.map((row) => row.join('')).join('\n');
}
