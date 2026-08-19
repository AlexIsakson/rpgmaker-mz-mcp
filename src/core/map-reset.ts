import { tileIndex, TILE_LAYERS, SHADOW_LAYER, REGION_LAYER, TOTAL_LAYERS } from './map-layers.js';
import type { MapData } from '../schemas/map.js';

/**
 * What a whole-map generator leaves behind, and what it should say about it.
 *
 * A generator that regenerates a map it has already written is the normal way
 * to use one — you try a seed, look at it, try another. Until this module,
 * the three generators answered that three different ways:
 *
 *  - `generate_interior` wiped all six planes and the events, silently.
 *  - `generate_map_layout` rewrote the chosen layer and *warned* about the rest.
 *  - `generate_town` cleared the events, refilled layer 0, and said in its own
 *    description that "the map is replaced — its existing tiles and events both
 *    go", which was not true of layers 1-3 or the shadow plane.
 *
 * **How much survives, measured.** A 44x34 town generated at seed 5 and then
 * regenerated at seed 9, compared cell by cell against the same seed-9 town on
 * a fresh map:
 *
 * | plane | differing cells | only on the regenerated map |
 * |---|---|---|
 * | layer 0 | 0 | 0 |
 * | layer 1 (props) | 49 | 47 |
 * | layer 2 (roofs) | 76 | 76 |
 * | layer 3 | 0 | 0 |
 * | shadow z=4 | 16 | 16 |
 * | region z=5 | 0 | 0 |
 * | **total** | **141** | **139** |
 *
 * Events came out identical, because `generate_town` already cleared those.
 *
 * The two cells that differ without being *extra* are the sharp end of it:
 * props are written with `skipOccupied`, so a stale prop does not merely
 * survive — it **wins**, and the new town silently loses the prop it planned
 * for that tile. At (12, 12) the regenerated map keeps tile 141 where the fresh
 * town put 144. So the debris is not additive; it corrupts.
 *
 * This module is pure: it counts planes and clears them, and never reads a file.
 */

/** Human names for the six planes, in `z` order. */
export const PLANE_NAMES = [
  'layer 0',
  'layer 1',
  'layer 2',
  'layer 3',
  'shadow plane',
  'region plane',
] as const;

export interface PlaneCount {
  z: number;
  name: string;
  /** Cells on this plane that are not empty. */
  filled: number;
}

export interface MapCensus {
  planes: PlaneCount[];
  events: number;
  /** Non-empty cells across every plane counted. */
  filledTotal: number;
}

/**
 * Count what is currently on a map.
 *
 * `ignore` leaves planes out of the tally — a generator about to overwrite
 * layer 0 completely should not report layer 0 as something it is going to
 * strand.
 */
export function censusMap(mapData: MapData, ignore: number[] = []): MapCensus {
  const { width, height, data } = mapData;
  const skip = new Set(ignore);
  const planes: PlaneCount[] = [];
  let filledTotal = 0;

  for (let z = 0; z < TOTAL_LAYERS; z++) {
    if (skip.has(z)) continue;
    let filled = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if ((data[tileIndex(width, height, x, y, z)] ?? 0) !== 0) filled++;
      }
    }
    planes.push({ z, name: PLANE_NAMES[z], filled });
    filledTotal += filled;
  }

  return {
    planes,
    events: mapData.events.filter((e) => e !== null).length,
    filledTotal,
  };
}

export interface ClearOptions {
  /** Planes to wipe. Defaults to all six. */
  planes?: number[];
  /** Wipe the event list too, leaving the `[null]` slot the format needs. */
  events?: boolean;
}

/**
 * Empty a map's planes in place, and report how many cells that took.
 *
 * The event list keeps its leading `null`: RPG Maker indexes events by id and
 * slot 0 is never an event, so an empty list is `[null]` rather than `[]`.
 */
export function clearMap(mapData: MapData, options: ClearOptions = {}): number {
  const { width, height } = mapData;
  const planes = options.planes ?? [...Array(TOTAL_LAYERS).keys()];
  let cleared = 0;

  for (const z of planes) {
    if (z < 0 || z >= TOTAL_LAYERS) continue;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = tileIndex(width, height, x, y, z);
        if ((mapData.data[index] ?? 0) !== 0) cleared++;
        mapData.data[index] = 0;
      }
    }
  }

  if (options.events) mapData.events = [null];

  return cleared;
}

/**
 * The line a generator prints when it was told to keep what was already there.
 *
 * Returns null when there was nothing to keep, so the caller can leave the
 * report clean rather than saying "kept 0 tiles" on every fresh map. Naming the
 * planes matters more than the total: "76 on layer 2" tells a caller their
 * roofs are stale, where "139 tiles" tells them nothing they can act on.
 */
export function describeKeptContent(census: MapCensus): string | null {
  const planes = census.planes.filter((p) => p.filled > 0);
  if (planes.length === 0 && census.events === 0) return null;

  const parts = planes.map((p) => `${p.filled} on ${p.name}`);
  if (census.events > 0) parts.push(`${census.events} event(s)`);

  return (
    `Kept what was already on this map: ${parts.join(', ')}. These were placed against ` +
    'whatever was here before and have not moved, so anything decorative is now in the wrong ' +
    'place — a roof with no building under it, a chest in solid rock. Props are written only ' +
    'onto empty cells, so an old one does not merely survive beside the new one, it displaces it.'
  );
}

export { TILE_LAYERS, SHADOW_LAYER, REGION_LAYER, TOTAL_LAYERS };
