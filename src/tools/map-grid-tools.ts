import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { buildGrid, renderAsciiGrid, renderRegionGrid, type GridEventMarker } from '../core/map-grid.js';
import { summariseRegions } from '../core/regions.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';

const LARGE_MAP_CELL_WARNING = 2500;

export function registerMapGridTools(server: McpServer): void {
  server.tool(
    'get_map_grid',
    'Render a map as a text grid for spatial reasoning: walls, ladders, bushes, ' +
      'counters, damage floors, and event positions. Optionally window a large map ' +
      'with x/y/width/height. Passability is computed statically from tileset flags ' +
      'and does not account for events with runtime-set passability.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      x: z.number().int().min(0).optional().describe('Left edge of the window (tiles)'),
      y: z.number().int().min(0).optional().describe('Top edge of the window (tiles)'),
      width: z.number().int().positive().optional().describe('Window width (tiles)'),
      height: z.number().int().positive().optional().describe('Window height (tiles)'),
      showRegions: z.boolean().default(false)
        .describe(
          'Also print the region plane (z=5) as a second grid. Off by default because most ' +
          'maps have no regions; when a map does have them, the output says so.'
        ),
    },
    async ({ mapId, x, y, width, height, showRegions }) => {
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
        const flags = await TilesetReader.getFlags(project.dataPath, mapData.tilesetId);
        const grid = buildGrid(mapData, flags);

        const events: GridEventMarker[] = mapData.events
          .filter((e): e is NonNullable<typeof e> => e !== null)
          .map((e) => ({ id: e.id, name: e.name, x: e.x, y: e.y }));

        const bounds =
          x !== undefined || y !== undefined || width !== undefined || height !== undefined
            ? {
                x: x ?? 0,
                y: y ?? 0,
                width: width ?? mapData.width - (x ?? 0),
                height: height ?? mapData.height - (y ?? 0),
              }
            : undefined;

        const { text, legend, truncatedEvents } = renderAsciiGrid(grid, events, bounds);

        const cellCount = (bounds?.width ?? mapData.width) * (bounds?.height ?? mapData.height);
        const notes: string[] = [];
        if (!bounds && cellCount > LARGE_MAP_CELL_WARNING) {
          notes.push(
            `Note: this map is ${mapData.width}x${mapData.height} (${cellCount} tiles). ` +
              `Pass x/y/width/height to window it if the output is hard to read.`
          );
        }
        if (truncatedEvents) {
          notes.push(`Note: more than ${legend.length} events in view — some were not labeled. Narrow the window to see them all.`);
        }

        const parts = [
          `Map ${mapId} (${mapData.width}x${mapData.height}, tileset ${mapData.tilesetId})`,
          '',
          '# = wall   . = floor   ~ = damage floor   = = ladder   " = bush   + = counter',
          '',
          text,
        ];
        if (legend.length > 0) {
          parts.push('', 'Events:', ...legend);
        }

        const areas = summariseRegions(mapData, flags);
        if (showRegions) {
          const region = renderRegionGrid(grid, bounds);
          parts.push(
            '',
            `Region plane (z=5) — . = no region${areas.length > 0 ? '' : ', and there are none'}`,
            '',
            region.text
          );
          if (region.legend.length > 0) parts.push('', ...region.legend);
          if (region.truncatedEvents) {
            parts.push('', 'Note: more distinct region ids in view than there are symbols; some print as ?.');
          }
          for (const area of areas) {
            parts.push(
              `region ${area.regionId}: ${area.tiles} tile(s) in ${area.areas} area(s)` +
              (area.impassable > 0 ? `, ${area.impassable} of them impassable` : '')
            );
          }
        } else if (areas.length > 0) {
          notes.push(
            `Note: this map uses the region plane (${areas.map((a) => `region ${a.regionId}: ${a.tiles} tiles`).join(', ')}). ` +
            'Pass showRegions to see where.'
          );
        }

        if (notes.length > 0) {
          parts.push('', ...notes);
        }

        return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
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
