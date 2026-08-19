/**
 * Reading the inventory `src/core/map-refs.ts` checks against.
 *
 * Split out of the tool files rather than duplicated in them because a
 * character sheet can be named by a dozen tools — `place_lever`,
 * `place_locked_door`, `lock_dungeon_floor`, `place_building`, `generate_town`,
 * `decorate_dungeon`, `place_shop`, `place_key_for_door`, `create_event`,
 * `update_event` — and one place has to decide, the way `ground-material.ts`
 * became the one place that decides whether a material can go on the ground.
 *
 * Every loader here **degrades to "could not tell" rather than to "empty"**: an
 * unreadable `img/characters` returns `undefined`, and `requireCharacterSheet`
 * then makes no claim. That is the same rule `loadDatabaseTables` follows, for
 * the same reason — failing every placement because a folder would not list is
 * worse than the bug being guarded against.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { FileHandler } from '../core/file-handler.js';
import { requireCharacterSheet, type MapRefInventory, type MapSize } from '../core/map-refs.js';
import { TilesetReader } from '../core/tileset-reader.js';
import type { MapData } from '../schemas/map.js';
import {
  collectTransferArrivals,
  newGameArrival,
  dedupeArrivals,
  type ArrivalPoint,
  type CommandSource,
  type RawCommand,
} from '../core/arrival.js';

const MAP_FILE = /^Map(\d{3,})\.json$/;

/** Basenames in `img/characters` without `.png`, or undefined if unreadable. */
export async function loadCharacterSheets(
  projectPath: string
): Promise<ReadonlySet<string> | undefined> {
  try {
    const files = await fs.readdir(path.join(projectPath, 'img', 'characters'));
    return new Set(files.filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)));
  } catch {
    return undefined;
  }
}

/**
 * Refuse any of these sheets that `img/characters` does not have.
 *
 * Takes pairs so a tool naming two — `lock_dungeon_floor` names a door and a
 * lever — reads the folder once. Blank names are skipped by
 * `requireCharacterSheet`, so an optional sprite argument can be passed
 * straight through.
 */
export async function requireProjectSheets(
  projectPath: string,
  named: readonly (readonly [name: string | undefined, subject: string])[]
): Promise<void> {
  if (named.every(([name]) => !name)) return;
  const sheets = await loadCharacterSheets(projectPath);
  for (const [name, subject] of named) requireCharacterSheet(name ?? '', sheets, subject);
}

/** Tilesets.json as loaded, or undefined if it is missing or will not parse. */
export async function loadTilesets(
  dataPath: string
): Promise<readonly (unknown | null)[] | undefined> {
  try {
    const raw = await FileHandler.readJsonRaw(path.join(dataPath, 'Tilesets.json'));
    return Array.isArray(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** The ids with a `MapXXX.json` on disk, or undefined if `data/` would not list. */
export async function loadMapIds(dataPath: string): Promise<ReadonlySet<number> | undefined> {
  try {
    const files = await fs.readdir(dataPath);
    const ids = new Set<number>();
    for (const file of files) {
      const match = MAP_FILE.exec(file);
      if (match) ids.add(Number(match[1]));
    }
    return ids;
  } catch {
    return undefined;
  }
}

/**
 * Sizes for the given maps, skipping any that will not read.
 *
 * Only the transfer targets a command list actually names are read — a project
 * can have hundreds of maps and the landing-square check needs two numbers from
 * each of the handful being transferred to.
 */
export async function loadMapSizes(
  dataPath: string,
  mapIds: Iterable<number>
): Promise<ReadonlyMap<number, MapSize>> {
  const sizes = new Map<number, MapSize>();
  await Promise.all(
    [...mapIds].map(async (id) => {
      try {
        const file = `Map${String(id).padStart(3, '0')}.json`;
        const map = (await FileHandler.readJsonRaw(path.join(dataPath, file))) as MapData;
        if (typeof map?.width === 'number' && typeof map?.height === 'number') {
          sizes.set(id, { width: map.width, height: map.height });
        }
      } catch {
        // left out on purpose — an unreadable target is unchecked, not invalid
      }
    })
  );
  return sizes;
}

/**
 * Full map data and tileset flags for the given targets, so the walk-out-again
 * check can flood-fill the same way `check_map_walkability` does.
 *
 * A target is left out — not defaulted — when either read fails: the map file
 * will not parse, or its `tilesetId` is not a resolvable tileset. The latter
 * is exactly `requireTileset`'s failure case, checked separately; here it just
 * means "cannot tell", the same as an unreadable map.
 */
export async function loadMapReach(
  dataPath: string,
  mapIds: Iterable<number>
): Promise<ReadonlyMap<number, { map: MapData; flags: number[] }>> {
  const out = new Map<number, { map: MapData; flags: number[] }>();
  await Promise.all(
    [...mapIds].map(async (id) => {
      try {
        const file = `Map${String(id).padStart(3, '0')}.json`;
        const map = (await FileHandler.readJsonRaw(path.join(dataPath, file))) as MapData;
        if (!Array.isArray(map?.data) || typeof map?.tilesetId !== 'number') return;
        const flags = await TilesetReader.getFlags(dataPath, map.tilesetId);
        out.set(id, { map, flags });
      } catch {
        // unreadable map or tileset — left out, not treated as broken
      }
    })
  );
  return out;
}

/**
 * The inventory for a command list: which maps exist, how big the ones it
 * transfers to are, and whether each landing tile leads anywhere.
 */
export async function loadTransferInventory(
  dataPath: string,
  targets: Iterable<number>
): Promise<MapRefInventory> {
  const mapIds = await loadMapIds(dataPath);
  const wanted = [...targets].filter((id) => mapIds === undefined || mapIds.has(id));
  const [mapSizes, mapReach] = await Promise.all([
    loadMapSizes(dataPath, wanted),
    loadMapReach(dataPath, wanted),
  ]);
  return { mapIds, mapSizes, mapReach };
}

/**
 * Every tile something on disk transfers the player to on `mapId`, plus the new
 * game start when it is there.
 *
 * Reads every map in the project, because a transfer aimed *at* a map lives on
 * whichever other map holds the door — there is no index of them. Measured
 * cost: 14 ms for `Wicked Heart`'s 64 maps, 147 ms for the 293 sample maps, so
 * this is called only where the answer changes a decision rather than on every
 * write.
 *
 * Degrades the same way the rest of this file does: a map that will not parse
 * is skipped, and an empty result means "nothing known", which
 * `surveyArrival` reports as an assumption rather than as a fact.
 */
export async function loadArrivalPoints(
  dataPath: string,
  mapId: number
): Promise<ArrivalPoint[]> {
  const sources: CommandSource[] = [];

  const ids = await loadMapIds(dataPath);
  await Promise.all(
    [...(ids ?? [])].map(async (id) => {
      try {
        const file = `Map${String(id).padStart(3, '0')}.json`;
        const map = (await FileHandler.readJsonRaw(path.join(dataPath, file))) as MapData;
        for (const event of map?.events ?? []) {
          for (const page of event?.pages ?? []) {
            sources.push({ mapId: id, list: page.list as RawCommand[] | undefined });
          }
        }
      } catch {
        // an unreadable map contributes no arrivals, rather than failing the lot
      }
    })
  );

  // Common events and troop battle pages transfer too, and neither belongs to a
  // map, so their arrivals are reported without one.
  for (const file of ['CommonEvents.json', 'Troops.json']) {
    try {
      const raw = await FileHandler.readJsonRaw(path.join(dataPath, file));
      if (!Array.isArray(raw)) continue;
      for (const row of raw) {
        if (!row) continue;
        if (Array.isArray(row.list)) sources.push({ list: row.list as RawCommand[] });
        for (const page of row.pages ?? []) {
          if (Array.isArray(page?.list)) sources.push({ list: page.list as RawCommand[] });
        }
      }
    } catch {
      // same rule
    }
  }

  const points = collectTransferArrivals(sources, mapId);

  try {
    const system = (await FileHandler.readJsonRaw(path.join(dataPath, 'System.json'))) as Record<
      string,
      unknown
    >;
    const start = newGameArrival(system, mapId);
    if (start) points.unshift(start);
  } catch {
    // same rule
  }

  return dedupeArrivals(points);
}
