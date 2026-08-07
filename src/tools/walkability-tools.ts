import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { analyseWalkability, renderWalkabilityReport } from '../core/walkability.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';

export function registerWalkabilityTools(server: McpServer): void {
  server.tool(
    'check_map_walkability',
    'Traverse a map and report what the player cannot reach: doors with no ' +
      'approach tile, NPCs standing in walls or sealed inside buildings, and ' +
      'areas cut off from the rest of the map. Run this after generating or ' +
      'decorating a map — a tile-by-tile view cannot show any of it.',
    {
      mapId: z.number().int().positive().describe('Map ID to analyse'),
    },
    async ({ mapId }) => {
      try {
        const project = requireProject();
        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return {
            content: [{ type: 'text' as const, text: `Map ID ${mapId} not found.` }],
            isError: true,
          };
        }

        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;
        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);
        const report = analyseWalkability(mapData, tileset.flags);

        return {
          content: [{
            type: 'text' as const,
            text: `Map ${mapId}, tileset ${mapData.tilesetId} "${tileset.name}"\n\n` +
              renderWalkabilityReport(report),
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
