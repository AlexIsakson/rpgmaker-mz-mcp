import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { writeLayer, TILE_LAYERS } from '../core/map-layers.js';
import {
  generateDungeon,
  generateCave,
  layoutToGrid,
  renderLayoutAscii,
  layoutStats,
  type GeneratedLayout,
} from '../core/mapgen.js';
import { getAutotileKind, TILE_ID_A2, TILE_ID_A3 } from '../core/autotile.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';
import { logger } from '../logger.js';

const A2_KIND_MIN = getAutotileKind(TILE_ID_A2);
const A2_KIND_MAX = getAutotileKind(TILE_ID_A3) - 1;

const PREVIEW_LIMIT = 60;

export function registerMapgenTools(server: McpServer): void {
  server.tool(
    'generate_map_layout',
    'Fill a map with a generated layout: "dungeon" places rooms joined by corridors, ' +
      '"cave" grows an organic cavern. Writes two A2 ground materials (floor and ' +
      'surround) with autotile shapes computed. Uses the map\'s existing size and ' +
      'replaces the chosen layer. Same seed always gives the same layout.',
    {
      mapId: z.number().int().positive().describe('Map ID to fill'),
      style: z.enum(['dungeon', 'cave']).describe('Layout algorithm'),
      floorKind: z.number().int().min(A2_KIND_MIN).max(A2_KIND_MAX)
        .describe(`A2 material for walkable floor (${A2_KIND_MIN}-${A2_KIND_MAX})`),
      surroundKind: z.number().int().min(A2_KIND_MIN).max(A2_KIND_MAX)
        .describe(`A2 material for everything that is not floor (${A2_KIND_MIN}-${A2_KIND_MAX})`),
      seed: z.number().int().default(1).describe('Same seed reproduces the same layout'),
      layer: z.number().int().min(0).max(TILE_LAYERS - 1).default(0).describe('Tile layer 0-3'),
      roomAttempts: z.number().int().positive().default(40)
        .describe('dungeon: how many times to try placing a room; higher is denser'),
      minRoomSize: z.number().int().positive().default(3).describe('dungeon: smallest room side'),
      maxRoomSize: z.number().int().positive().default(8).describe('dungeon: largest room side'),
      fillProbability: z.number().min(0).max(1).default(0.45)
        .describe('cave: starting solid density; around 0.45 gives typical caves'),
      smoothingSteps: z.number().int().min(0).max(10).default(4)
        .describe('cave: smoothing passes; higher is rounder'),
    },
    async ({
      mapId, style, floorKind, surroundKind, seed, layer,
      roomAttempts, minRoomSize, maxRoomSize, fillProbability, smoothingSteps,
    }) => {
      try {
        if (floorKind === surroundKind) {
          return {
            content: [{
              type: 'text' as const,
              text: 'floorKind and surroundKind must differ, or the layout will be invisible.',
            }],
            isError: true,
          };
        }

        const project = requireProject();
        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return {
            content: [{ type: 'text' as const, text: `Map ID ${mapId} not found.` }],
            isError: true,
          };
        }

        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;
        const { width, height } = mapData;

        if (width < 5 || height < 5) {
          return {
            content: [{
              type: 'text' as const,
              text: `Map is ${width}x${height}, too small to generate into. Resize it to at least 5x5 first.`,
            }],
            isError: true,
          };
        }

        const layout: GeneratedLayout =
          style === 'dungeon'
            ? generateDungeon({ width, height, seed, roomAttempts, minRoomSize, maxRoomSize })
            : generateCave({ width, height, seed, fillProbability, smoothingSteps });

        const stats = layoutStats(layout);

        if (stats.openTiles === 0) {
          return {
            content: [{
              type: 'text' as const,
              text:
                'The generator produced no open floor. Try a different seed, or for a cave ' +
                'lower fillProbability.',
            }],
            isError: true,
          };
        }

        // Only the chosen layer is rewritten; the others are left as they are.
        const grid = layoutToGrid(layout, floorKind, surroundKind);
        writeLayer(mapData, layer, grid);

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        const lines = [
          `Generated a ${style} layout on map ${mapId} (${width}x${height}), layer ${layer}, seed ${seed}.`,
          `Floor material: A2 kind ${floorKind}   Surround: A2 kind ${surroundKind}`,
          `Open tiles: ${stats.openTiles} of ${width * height}` +
            (style === 'dungeon' ? `   Rooms: ${layout.rooms.length}` : ''),
          `Suggested start position: (${layout.start.x}, ${layout.start.y})`,
          stats.fullyConnected
            ? 'All open tiles are reachable from the start position.'
            : `WARNING: only ${stats.reachableTiles} of ${stats.openTiles} open tiles are reachable from the start position.`,
        ];

        if (width <= PREVIEW_LIMIT && height <= PREVIEW_LIMIT) {
          lines.push('', 'Layout (. open, # solid, @ start):', renderLayoutAscii(layout));
        }

        lines.push(
          '',
          'Note: this paints materials only. Whether the player can actually walk on them ' +
            'comes from the tileset passage settings, not from the layout — use get_map_grid ' +
            'to check the result is walkable as intended.'
        );

        logger.info(`Generated ${style} on map ${mapId} seed ${seed}`);

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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
