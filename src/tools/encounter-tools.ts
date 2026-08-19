import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { logger } from '../logger.js';
import {
  planEncounters,
  renderEncounterPlan,
  surveyEncounterRegions,
  EncounterError,
  ENCOUNTER_STEP_DEFAULT,
  ENCOUNTER_STEP_MIN,
  type EncounterRowInput,
  type TroopRow,
} from '../core/encounters.js';
import { REGION_ID_MAX } from '../core/regions.js';
import {
  surveyArrival,
  describeArrival,
  type ArrivalPoint,
  type ArrivalSurvey,
} from '../core/arrival.js';
import { loadArrivalPoints } from './map-ref-loaders.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';

/** Stated, not measured: nothing on this machine has a table at all, let alone a long one. */
const ROW_LIMIT = 100;

/** Troops.json, or undefined when it cannot be read — which the core reports rather than hides. */
async function readTroops(dataPath: string): Promise<(TroopRow | null)[] | undefined> {
  try {
    const raw = await FileHandler.readJsonRaw(path.join(dataPath, 'Troops.json'));
    return Array.isArray(raw) ? (raw as (TroopRow | null)[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where the player can be on this map: the given tile if there is one,
 * otherwise every tile the project transfers them to.
 *
 * An explicit start replaces the derivation rather than adding to it — a caller
 * who names a tile is answering the question, and quietly unioning it with
 * every door in the project would make their answer weaker than it is.
 */
export async function resolveArrival(
  dataPath: string,
  mapId: number,
  mapData: MapData,
  flags: number[],
  startX?: number,
  startY?: number
): Promise<ArrivalSurvey> {
  const points: ArrivalPoint[] =
    startX !== undefined && startY !== undefined
      ? [{ x: startX, y: startY, source: 'given' }]
      : await loadArrivalPoints(dataPath, mapId);
  return surveyArrival(mapData, flags, points);
}

export function registerEncounterTools(server: McpServer): void {
  server.tool(
    'set_map_encounters',
    "Write a map's random-encounter table — encounterList and encounterStep. " +
      'This is the other half of the region plane: a row with an empty regionSet ' +
      'fires anywhere on the map, and a row naming region ids fires only where ' +
      'the player stands on one, so paint_regions is what scopes it. Every row ' +
      'is checked against the engine before anything is written: the troop must ' +
      'exist and have members, the weights must be able to produce a pick, and ' +
      'the regions must be painted somewhere the player can actually walk. ' +
      'The result reports the odds per zone, because weightSum is recomputed ' +
      "under the player's feet and a row scoped to a region competes with every " +
      'everywhere-row there too.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      encounters: z
        .array(
          z.object({
            troopId: z.number().int().positive().optional()
              .describe('Troop ID from Troops.json. Give this or troopName, not both.'),
            troopName: z.string().optional()
              .describe(
                'Troop name from Troops.json, matched case-insensitively. Every troop that has ' +
                'members carries a name in all 20 projects measured, so a name can reach any ' +
                'troop worth putting in a table.'
              ),
            weight: z.number().int().min(0).default(1)
              .describe(
                'Relative chance within whichever zone this row qualifies in. Not a percentage: ' +
                'makeEncounterTroopId sums the weights of the rows that qualify where the ' +
                'player is standing and rolls against that sum. 0 writes an inert row.'
              ),
            regionSet: z.array(z.number().int().min(0).max(REGION_ID_MAX)).optional()
              .describe(
                'Region ids this row is limited to. Omit or leave empty to fire anywhere on the ' +
                'map. 0 means unpainted ground specifically, so [0] is "only away from the ' +
                'marked areas". Ids must already be painted somewhere the player can reach — ' +
                'paint_regions writes them.'
              ),
          })
        )
        .max(ROW_LIMIT)
        .describe(
          `The rows to write, up to ${ROW_LIMIT}. Replaces the whole table. An empty list ` +
          'clears it, which also removes the source for any sameAsRandomEncounter battle on ' +
          'this map.'
        ),
      encounterStep: z.number().int().min(ENCOUNTER_STEP_MIN).optional()
        .describe(
          `Average steps between encounters; the count is Math.randomInt(n) + Math.randomInt(n) ` +
          `+ 1, so it runs 1 to 2n-1 and averages n. Bush tiles count double. Defaults to the ` +
          `map's current value, or ${ENCOUNTER_STEP_DEFAULT} — the editor default, on 1217 of ` +
          'the 1219 maps measured on this machine.'
        ),
      startX: z.number().int().min(0).optional()
        .describe(
          'X of a tile the player is known to reach — usually where they arrive. Without it the ' +
          'largest walkable area stands in, which is wrong on an interior, and a region scoped ' +
          'row could then be refused for being outside an area the player does in fact start in.'
        ),
      startY: z.number().int().min(0).optional().describe('Y of that tile'),
    },
    async ({ mapId, encounters, encounterStep, startX, startY }) => {
      try {
        const project = requireProject();
        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return {
            content: [{ type: 'text' as const, text: `Map ID ${mapId} not found.` }],
            isError: true,
          };
        }
        if ((startX === undefined) !== (startY === undefined)) {
          return {
            content: [{ type: 'text' as const, text: 'Give both startX and startY, or neither.' }],
            isError: true,
          };
        }

        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;
        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);
        const troops = await readTroops(project.dataPath);
        const arrival = await resolveArrival(
          project.dataPath,
          mapId,
          mapData,
          tileset.flags,
          startX,
          startY
        );

        const plan = planEncounters(
          mapData,
          arrival.reachable,
          encounters as EncounterRowInput[],
          {
            encounterStep: encounterStep ?? mapData.encounterStep ?? ENCOUNTER_STEP_DEFAULT,
            troops,
          }
        );

        mapData.encounterList = plan.rows;
        mapData.encounterStep = plan.encounterStep;
        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(`Wrote ${plan.rows.length} encounter row(s) to map ${mapId}`);

        const lines = [
          `Map ${mapId}, tileset ${mapData.tilesetId} "${tileset.name}"`,
          describeArrival(arrival),
          '',
          renderEncounterPlan(plan, mapId),
        ];

        // Painted but unused regions are not an error — the plane also drives
        // Get Location Info — but a caller who just painted one and expected it
        // to gate an encounter should be told it is not gating anything.
        const regions = surveyEncounterRegions(mapData, arrival.reachable);
        const scoped = new Set(plan.rows.flatMap((row) => row.regionSet));
        const unused = [...regions.keys()].filter((id) => !scoped.has(id)).sort((a, b) => a - b);
        if (unused.length > 0 && plan.rows.length > 0) {
          lines.push(
            '',
            `Note: region ${unused.join(', ')} ${unused.length === 1 ? 'is' : 'are'} painted on ` +
            'this map but named by no row, so nothing here is scoped to ' +
            `${unused.length === 1 ? 'it' : 'them'}.`
          );
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        if (error instanceof EncounterError) {
          return { content: [{ type: 'text' as const, text: error.message }], isError: true };
        }
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_map_encounters',
    "Read back a map's encounter table and say what it actually does: which " +
      'rows can be picked, the odds in each place the player can stand, and how ' +
      'often an encounter comes round. Reports rows the engine would silently ' +
      'skip rather than repeating the file back.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      startX: z.number().int().min(0).optional()
        .describe('X of a tile the player is known to reach, as in check_map_walkability'),
      startY: z.number().int().min(0).optional().describe('Y of that tile'),
    },
    async ({ mapId, startX, startY }) => {
      try {
        const project = requireProject();
        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return {
            content: [{ type: 'text' as const, text: `Map ID ${mapId} not found.` }],
            isError: true,
          };
        }
        if ((startX === undefined) !== (startY === undefined)) {
          return {
            content: [{ type: 'text' as const, text: 'Give both startX and startY, or neither.' }],
            isError: true,
          };
        }

        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;
        const list = Array.isArray(mapData.encounterList) ? mapData.encounterList : [];

        if (list.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text:
                `Map ${mapId} has no encounter rows (encounterStep ${mapData.encounterStep}). ` +
                'makeEncounterTroopId returns 0 on every roll, so no random battle can happen ' +
                'here and a sameAsRandomEncounter battle has nothing to draw from. ' +
                'set_map_encounters writes the table.',
            }],
          };
        }

        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);
        const troops = await readTroops(project.dataPath);
        const arrival = await resolveArrival(
          project.dataPath,
          mapId,
          mapData,
          tileset.flags,
          startX,
          startY
        );

        // Re-planning the stored rows is the read: the same refusals that stop
        // a bad table being written are what "this row can never fire" means
        // for one that is already there.
        try {
          const plan = planEncounters(mapData, arrival.reachable, list, {
            encounterStep: mapData.encounterStep,
            troops,
          });
          return {
            content: [{
              type: 'text' as const,
              text: `${describeArrival(arrival)}\n\n${renderEncounterPlan(plan, mapId)}`,
            }],
          };
        } catch (error) {
          if (error instanceof EncounterError) {
            return {
              content: [{
                type: 'text' as const,
                text:
                  `Map ${mapId} has ${list.length} encounter row(s), and the table is not ` +
                  `usable as it stands:\n\n${describeArrival(arrival)}\n\n${error.message}`,
              }],
            };
          }
          throw error;
        }
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );
}
