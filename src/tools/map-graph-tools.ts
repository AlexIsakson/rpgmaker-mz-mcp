import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { buildMapGraph, renderMapGraph, type CommonEventLike, type LoadedMap } from '../core/map-graph.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData, MapInfo } from '../schemas/map.js';

export function registerMapGraphTools(server: McpServer): void {
  server.tool(
    'get_map_graph',
    'Build the map connection graph from Transfer Player commands: which maps link ' +
      'to which, one-way connections, maps unreachable from the start map, transfers ' +
      'to maps that no longer exist, and variable-driven transfers that cannot be ' +
      'resolved statically. Follows transfers inside called common events.',
    {},
    async () => {
      try {
        const project = requireProject();
        const dataPath = project.dataPath;

        const mapInfos = (await FileHandler.readJsonRaw(
          path.join(dataPath, 'MapInfos.json')
        )) as (MapInfo | null)[];

        const system = (await FileHandler.readJsonRaw(
          path.join(dataPath, 'System.json')
        )) as { startMapId?: number };

        // Load every map that actually has a data file.
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
        )) as (CommonEventLike | null)[];
        const commonEvents = rawCommonEvents.filter((ce): ce is CommonEventLike => ce !== null);

        const graph = buildMapGraph({
          startMapId: system.startMapId ?? 1,
          maps,
          mapInfos,
          commonEvents,
        });

        return { content: [{ type: 'text' as const, text: renderMapGraph(graph) }] };
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
