import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { logger } from '../logger.js';
import {
  paintRegionRect,
  paintRegionTiles,
  clearRegion,
  summariseRegions,
  REGION_ID_MAX,
  type RegionWriteResult,
} from '../core/regions.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';

const BATCH_LIMIT = 2000;

function describeWrite(mapId: number, written: number[], result: RegionWriteResult): string[] {
  const lines: string[] = [];

  const ids = written.filter((id) => id !== 0);
  if (ids.length === 0) {
    lines.push(`Map ${mapId}: erased the region id from ${result.written} tile(s).`);
  } else if (ids.length === 1 && written.length === 1) {
    lines.push(`Map ${mapId}: wrote region ${ids[0]} to ${result.written} tile(s).`);
  } else {
    // A tile list can carry a different id per entry, so naming one of them
    // would be a lie about the other.
    lines.push(
      `Map ${mapId}: wrote ${result.written} tile(s) across region(s) ${ids.join(', ')}` +
      `${written.includes(0) ? ', and erased others' : ''}.`
    );
  }
  if (result.unchanged > 0) {
    lines.push(
      ids.length === 0
        ? `${result.unchanged} tile(s) in range already had no region.`
        : `${result.unchanged} tile(s) already carried that id and were left alone.`
    );
  }
  if (result.overwritten.size > 0) {
    const detail = [...result.overwritten.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, n]) => `region ${id}: ${n} tile(s)`)
      .join(', ');
    lines.push(
      `Took ${result.replaced} tile(s) off another region — ${detail}. The region plane holds ` +
      'one id per tile, so regions cannot overlap.'
    );
  }
  if (result.clipped) {
    lines.push(
      `The rectangle ran past the map edge and was clipped to (${result.clipped.x}, ` +
      `${result.clipped.y}) ${result.clipped.width}x${result.clipped.height}.`
    );
  }

  return lines;
}

/**
 * The note that stops a region being quietly useless: an encounter regionSet
 * over tiles the player cannot stand on will never fire, and nothing in the
 * editor or the engine complains.
 */
function passabilityNote(mapData: MapData, flags: number[], regionId: number): string | null {
  if (regionId === 0) return null;
  const area = summariseRegions(mapData, flags).find((a) => a.regionId === regionId);
  if (!area || area.impassable === 0) return null;

  if (area.impassable === area.tiles) {
    return (
      `Warning: all ${area.tiles} tile(s) of region ${regionId} are impassable, so the player ` +
      'can never stand in it. An encounter restricted to this region will never fire, and a ' +
      'Get Location Info branch on it can never be taken.'
    );
  }
  return (
    `Note: ${area.impassable} of region ${regionId}'s ${area.tiles} tile(s) are impassable. ` +
    'Those tiles cannot be stood on, so they contribute nothing to an encounter region.'
  );
}

export function registerRegionTools(server: McpServer): void {
  server.tool(
    'paint_regions',
    'Write the region plane (z=5) — the sixth map layer, and the one no other ' +
      'tool can reach. A region id is what Game_Map.regionId returns and what an ' +
      "encounterList entry's regionSet matches against, so this is how a generated " +
      'map gets encounter zones; Get Location Info reads it too, so events can ' +
      'branch on where the player is standing. Give either a rectangle or a list ' +
      'of tiles. Region ids are 1-' + REGION_ID_MAX + '; 0 erases.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      regionId: z.number().int().min(0).max(REGION_ID_MAX).optional()
        .describe(
          `Region id to write, 1-${REGION_ID_MAX} (the editor's palette). 0 erases the region ` +
          'from the tiles covered. Required with a rectangle; with a tile list each entry ' +
          'carries its own id and this is the fallback for entries that omit one.'
        ),
      x: z.number().int().optional().describe('Left edge of the rectangle, in tiles'),
      y: z.number().int().optional().describe('Top edge of the rectangle, in tiles'),
      width: z.number().int().positive().optional().describe('Rectangle width in tiles'),
      height: z.number().int().positive().optional().describe('Rectangle height in tiles'),
      tiles: z.array(
        z.object({
          x: z.number().int().describe('X position in tiles'),
          y: z.number().int().describe('Y position in tiles'),
          regionId: z.number().int().min(0).max(REGION_ID_MAX).optional()
            .describe('Region id for this tile. Defaults to the top-level regionId.'),
        })
      ).min(1).max(BATCH_LIMIT).optional()
        .describe(
          `Individual tiles to paint, up to ${BATCH_LIMIT}, as an alternative to a rectangle. ` +
          'Later entries win over earlier ones. Validated as a whole: if any tile is off the ' +
          'map, nothing is written.'
        ),
      clearFirst: z.boolean().default(false)
        .describe(
          'Erase every tile already carrying this region id across the whole map before ' +
          'writing, so the region ends up exactly where this call puts it rather than being ' +
          'added to whatever was there.'
        ),
    },
    async ({ mapId, regionId, x, y, width, height, tiles, clearFirst }) => {
      try {
        const project = requireProject();
        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return {
            content: [{ type: 'text' as const, text: `Map ID ${mapId} not found.` }],
            isError: true,
          };
        }

        const hasRect = x !== undefined || y !== undefined || width !== undefined || height !== undefined;
        if (hasRect && tiles) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Give either a rectangle (x/y/width/height) or a tiles list, not both.',
            }],
            isError: true,
          };
        }
        if (!hasRect && !tiles) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Nothing to paint. Give a rectangle (x/y/width/height) or a tiles list.',
            }],
            isError: true,
          };
        }
        if (hasRect && (x === undefined || y === undefined || width === undefined || height === undefined)) {
          return {
            content: [{
              type: 'text' as const,
              text: 'A rectangle needs all four of x, y, width and height.',
            }],
            isError: true,
          };
        }
        if (hasRect && regionId === undefined) {
          return {
            content: [{
              type: 'text' as const,
              text: `regionId is required with a rectangle. Use 1-${REGION_ID_MAX}, or 0 to erase.`,
            }],
            isError: true,
          };
        }

        const resolved = tiles?.map((t) => ({ ...t, regionId: t.regionId ?? regionId }));
        const missing = resolved?.find((t) => t.regionId === undefined);
        if (missing) {
          return {
            content: [{
              type: 'text' as const,
              text:
                `Tile (${missing.x}, ${missing.y}) has no regionId and no top-level regionId ` +
                'was given to fall back on.',
            }],
            isError: true,
          };
        }

        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;

        const cleared = clearFirst && regionId !== undefined && regionId > 0
          ? clearRegion(mapData, regionId)
          : 0;

        let result: RegionWriteResult;
        if (hasRect) {
          result = paintRegionRect(mapData, { x: x!, y: y!, width: width!, height: height! }, regionId!);
        } else {
          result = paintRegionTiles(
            mapData,
            resolved!.map((t) => ({ x: t.x, y: t.y, regionId: t.regionId as number }))
          );
        }

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(`Painted ${result.written} region tile(s) on map ${mapId}`);

        const written = new Set(
          hasRect ? [regionId!] : resolved!.map((t) => t.regionId as number)
        );
        const lines: string[] = [];
        if (cleared > 0) {
          lines.push(`Cleared region ${regionId} from ${cleared} tile(s) first.`);
        }
        lines.push(...describeWrite(mapId, [...written].sort((a, b) => a - b), result));

        const flags = await TilesetReader.getFlags(project.dataPath, mapData.tilesetId);
        for (const id of [...written].sort((a, b) => a - b)) {
          const note = passabilityNote(mapData, flags, id);
          if (note) lines.push(note);
        }

        const areas = summariseRegions(mapData, flags);
        if (areas.length > 0) {
          lines.push('', 'Region plane now holds:');
          for (const area of areas) {
            lines.push(
              `  region ${area.regionId}: ${area.tiles} tile(s) in ${area.areas} area(s), ` +
              `within (${area.bounds.x}, ${area.bounds.y}) ${area.bounds.width}x${area.bounds.height}`
            );
          }
          lines.push('', 'See it with get_map_grid showRegions.');
        } else {
          lines.push('', 'The region plane is now empty.');
        }

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
