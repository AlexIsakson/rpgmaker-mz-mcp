import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import {
  checkProject,
  renderConsistencyReport,
  type CommonEventFull,
  type Severity,
  type TilesetLike,
} from '../core/consistency.js';
import type { LoadedMap } from '../core/map-graph.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData, MapInfo } from '../schemas/map.js';
import type { EventCommand } from '../schemas/event.js';

interface TroopLike {
  id: number;
  name: string;
  pages: { list: EventCommand[]; conditions?: { switchId?: number; switchValid?: boolean } }[];
}

/**
 * Read a data file, or return null if it is absent. Troops/Tilesets only feed
 * individual rules — a project missing one should lose that rule, not the
 * whole check.
 */
async function readOptionalJson(filePath: string): Promise<unknown | null> {
  if (!(await FileHandler.exists(filePath))) return null;
  try {
    return await FileHandler.readJsonRaw(filePath);
  } catch {
    return null;
  }
}

export function registerConsistencyTools(server: McpServer): void {
  server.tool(
    'check_project',
    'Run static consistency checks across the whole project: switches and variables ' +
      'read but never written, self-switches a page needs but nothing can set, autorun ' +
      'pages that can never stop, transfers to deleted maps, unreachable maps, missing ' +
      'common events, and unconfigured tileset passage settings.',
    {
      minSeverity: z.enum(['error', 'warning', 'info']).default('info')
        .describe('Lowest severity to report. "error" shows only game-breaking issues.'),
    },
    async ({ minSeverity }) => {
      try {
        const project = requireProject();
        const dataPath = project.dataPath;

        const mapInfos = (await FileHandler.readJsonRaw(
          path.join(dataPath, 'MapInfos.json')
        )) as (MapInfo | null)[];

        const system = (await FileHandler.readJsonRaw(
          path.join(dataPath, 'System.json')
        )) as { startMapId?: number };

        const maps: LoadedMap[] = [];
        for (let id = 0; id < mapInfos.length; id++) {
          if (!mapInfos[id]) continue;
          const mapPath = path.join(dataPath, mapFilename(id));
          if (!(await FileHandler.exists(mapPath))) continue;
          maps.push({ id, data: (await FileHandler.readJsonRaw(mapPath)) as MapData });
        }

        if (maps.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No maps found in this project.' }] };
        }

        const rawCommonEvents = (await FileHandler.readJsonRaw(
          path.join(dataPath, 'CommonEvents.json')
        )) as (CommonEventFull | null)[];
        const commonEvents = rawCommonEvents.filter((ce): ce is CommonEventFull => ce !== null);

        const rawTroops = ((await readOptionalJson(
          path.join(dataPath, 'Troops.json')
        )) ?? []) as (TroopLike | null)[];
        const troopCommandLists: EventCommand[][] = [];
        const troopConditionSwitches: number[] = [];
        for (const troop of rawTroops) {
          if (!troop?.pages) continue;
          for (const page of troop.pages) {
            if (page.list) troopCommandLists.push(page.list);
            if (page.conditions?.switchValid && page.conditions.switchId) {
              troopConditionSwitches.push(page.conditions.switchId);
            }
          }
        }

        const rawTilesets = ((await readOptionalJson(
          path.join(dataPath, 'Tilesets.json')
        )) ?? []) as (TilesetLike | null)[];
        const tilesets = rawTilesets.filter((t): t is TilesetLike => t !== null && Array.isArray(t.flags));

        const report = checkProject({
          startMapId: system.startMapId ?? 1,
          maps,
          mapInfos,
          commonEvents,
          troopCommandLists,
          troopConditionSwitches,
          tilesets,
        });

        return {
          content: [{
            type: 'text' as const,
            text: renderConsistencyReport(report, minSeverity as Severity),
          }],
        };
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
