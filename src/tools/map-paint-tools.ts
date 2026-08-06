import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { readLayer, writeLayer, TILE_LAYERS } from '../core/map-layers.js';
import {
  fillRect,
  makeAutotileId,
  isTileA2,
  getAutotileKind,
  TILE_ID_A2,
  TILE_ID_A3,
} from '../core/autotile.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';
import { logger } from '../logger.js';

/** A2 ground autotiles occupy kinds 16-47 (an 8-wide by 4-tall sheet). */
const A2_KIND_MIN = getAutotileKind(TILE_ID_A2);
const A2_KIND_MAX = getAutotileKind(TILE_ID_A3) - 1;

export function registerMapPaintTools(server: McpServer): void {
  server.tool(
    'fill_map_region',
    'Paint a rectangle of a map with one tile material, automatically computing ' +
      'autotile shapes so edges and corners join correctly — including fixing up ' +
      'the tiles already around the area. Give either autotileKind (for A2 ground ' +
      'materials) or a raw tileId.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      x: z.number().int().min(0).describe('Left edge of the rectangle, in tiles'),
      y: z.number().int().min(0).describe('Top edge of the rectangle, in tiles'),
      width: z.number().int().positive().describe('Width in tiles'),
      height: z.number().int().positive().describe('Height in tiles'),
      autotileKind: z.number().int().min(A2_KIND_MIN).max(A2_KIND_MAX).optional()
        .describe(
          `A2 ground material, ${A2_KIND_MIN}-${A2_KIND_MAX}. The A2 sheet is 8 wide by 4 tall, ` +
          `so kind = ${A2_KIND_MIN} + row * 8 + column. Column 0 of each row is the plain ` +
          'seamless fill; columns 1-4 are patch materials with visible outlines.'
        ),
      tileId: z.number().int().min(0).optional()
        .describe('Raw tile id, as an alternative to autotileKind. Shapes are only computed for A2 tiles.'),
      layer: z.number().int().min(0).max(TILE_LAYERS - 1).default(0)
        .describe('Tile layer 0-3 (0 is the ground layer)'),
    },
    async ({ mapId, x, y, width, height, autotileKind, tileId, layer }) => {
      try {
        if ((autotileKind === undefined) === (tileId === undefined)) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Give exactly one of autotileKind or tileId.',
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

        if (x >= mapData.width || y >= mapData.height) {
          return {
            content: [{
              type: 'text' as const,
              text: `Rectangle starts outside the map (map is ${mapData.width}x${mapData.height}).`,
            }],
            isError: true,
          };
        }

        const resolvedTileId =
          autotileKind !== undefined ? makeAutotileId(autotileKind, 0) : tileId!;

        const grid = readLayer(mapData, layer);
        const painted = fillRect(grid, { x, y, width, height }, resolvedTileId);
        writeLayer(mapData, layer, painted);

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        const clippedWidth = Math.min(width, mapData.width - x);
        const clippedHeight = Math.min(height, mapData.height - y);

        const lines = [
          `Painted ${clippedWidth}x${clippedHeight} tiles at (${x}, ${y}) on map ${mapId}, layer ${layer}.`,
        ];
        if (clippedWidth !== width || clippedHeight !== height) {
          lines.push(`Clipped to the map bounds (${mapData.width}x${mapData.height}).`);
        }
        if (isTileA2(resolvedTileId)) {
          lines.push(
            `Material: A2 kind ${getAutotileKind(resolvedTileId)}. ` +
            'Autotile shapes were computed for the area and the tiles around it.'
          );
        } else {
          lines.push(
            `Tile id ${resolvedTileId} is not an A2 ground autotile, so it was written as-is ` +
            'without shape computation. Walls (A3/A4) and waterfalls follow different rules ' +
            'and are not supported yet.'
          );
        }
        lines.push('Use get_map_grid to see the result as a text grid.');

        logger.info(`Filled map ${mapId} layer ${layer} at (${x},${y}) ${clippedWidth}x${clippedHeight}`);

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
