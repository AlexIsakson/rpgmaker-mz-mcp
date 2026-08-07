import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { readLayer, writeLayer, TILE_LAYERS } from '../core/map-layers.js';
import {
  fillRect,
  refreshAutotileShapes,
  makeAutotileId,
  isTileA2,
  getAutotileKind,
  TILE_ID_A2,
  TILE_ID_A3,
  TILE_ID_MAX,
} from '../core/autotile.js';
import {
  fillWallRect,
  refreshWallShapes,
  usesWallAutotileTable,
  isTileA3,
} from '../core/wall-autotile.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { loadA2Materials } from '../core/tileset-image.js';
import { applyWallShadows } from '../core/shadows.js';
import type { MapData } from '../schemas/map.js';
import { logger } from '../logger.js';

/** A2 ground autotiles occupy kinds 16-47 (an 8-wide by 4-tall sheet). */
const A2_KIND_MIN = getAutotileKind(TILE_ID_A2);
const A2_KIND_MAX = getAutotileKind(TILE_ID_A3) - 1;
/** A3 walls and roofs are 48-79, A4 walls and wall tops 80-127. */
const AUTOTILE_KIND_MAX = getAutotileKind(TILE_ID_MAX) - 1;

export function registerMapPaintTools(server: McpServer): void {
  server.tool(
    'fill_map_region',
    'Paint a rectangle of a map with one tile material, automatically computing ' +
      'autotile shapes so edges and corners join correctly — including fixing up ' +
      'the tiles already around the area. Handles the A2 ground family and the ' +
      'A3/A4 wall family, each with its own shape table. Give either autotileKind ' +
      'or a raw tileId.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      x: z.number().int().min(0).describe('Left edge of the rectangle, in tiles'),
      y: z.number().int().min(0).describe('Top edge of the rectangle, in tiles'),
      width: z.number().int().positive().describe('Width in tiles'),
      height: z.number().int().positive().describe('Height in tiles'),
      autotileKind: z.number().int().min(A2_KIND_MIN).max(AUTOTILE_KIND_MAX).optional()
        .describe(
          `Autotile material. ${A2_KIND_MIN}-${A2_KIND_MAX} is the A2 ground family, ` +
          `${A2_KIND_MAX + 1}-79 the A3 building walls and roofs, 80-${AUTOTILE_KIND_MAX} A4 ` +
          'walls and wall tops; each sheet is 8 kinds wide, so kind = base + row * 8 + column. ' +
          'Shapes are computed with the right table for the family. Which A2 kinds are opaque ' +
          'ground, which are transparent overlays and which have a visible outline differs ' +
          'between tilesets — call describe_tileset_materials rather than assuming a layout.'
        ),
      tileId: z.number().int().min(0).optional()
        .describe(
          'Raw tile id, as an alternative to autotileKind. Use it for B/C/D/E object ' +
          'tiles, which have no shapes. Autotile ids are written as given, without ' +
          'shape computation — pass autotileKind instead to get that.'
        ),
      layer: z.number().int().min(0).max(TILE_LAYERS - 1).default(0)
        .describe('Tile layer 0-3 (0 is the ground layer)'),
      skipOccupied: z.boolean().default(false)
        .describe(
          'Only paint cells that are currently empty on this layer. Use it for ' +
          'decoration passes so a later object cannot silently overwrite an earlier one.'
        ),
      allowOverlayOnGround: z.boolean().default(false)
        .describe(
          'Permit an overlay material (one with transparent edge pieces) on layer 0. ' +
          'Normally refused, because its edges show the map background as black in game.'
        ),
    },
    async ({ mapId, x, y, width, height, autotileKind, tileId, layer, skipOccupied, allowOverlayOnGround }) => {
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

        const clippedWidth = Math.min(width, mapData.width - x);
        const clippedHeight = Math.min(height, mapData.height - y);
        const advice: string[] = [];

        // Whether a material can go on layer 0, and whether it will show a
        // boundary, are properties of the tileset image — check them before
        // painting rather than leaving the caller to discover it in a render.
        // Only the A2 family is classified; walls are opaque by construction.
        if (autotileKind !== undefined && isTileA2(resolvedTileId)) {
          const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);
          const materials = await loadA2Materials(project.path, tileset.tilesetNames);
          const material = materials?.find((m) => m.kind === autotileKind);

          if (material && material.opacity !== 'ground' && layer === 0 && !allowOverlayOnGround) {
            return {
              content: [{
                type: 'text' as const,
                text:
                  `A2 kind ${autotileKind} in "${tileset.name}" is ${material.opacity === 'empty' ? 'an empty slot' : 'an overlay material'}: ` +
                  'its edge pieces are transparent, so on layer 0 they show the map ' +
                  'background, which renders black in game.\n\n' +
                  'Paint it on layer 1 or above, over a ground material on layer 0. ' +
                  'Use describe_tileset_materials to see which kinds are ground and which ' +
                  'are overlays for this tileset, or pass allowOverlayOnGround if this is ' +
                  'deliberate.',
              }],
              isError: true,
            };
          }

          const coversMap = clippedWidth >= mapData.width && clippedHeight >= mapData.height;
          if (material && material.outline === 'seamless' && !coversMap) {
            advice.push(
              `Note: A2 kind ${autotileKind} is a seamless fill — its edge pieces are drawn ` +
              'the same as its middle, so this patch will have no visible boundary and will ' +
              'read as a floating slab rather than a path. Seamless materials suit a ' +
              'whole-map base fill; for a path or patch use an outlined material ' +
              '(describe_tileset_materials lists them).'
            );
          }
        }

        const grid = readLayer(mapData, layer);

        let skippedCells = 0;
        let overwrittenCells = 0;
        for (let j = y; j < y + clippedHeight; j++) {
          for (let i = x; i < x + clippedWidth; i++) {
            if ((grid[j]?.[i] ?? 0) !== 0) {
              if (skipOccupied) skippedCells++;
              else overwrittenCells++;
            }
          }
        }

        // Walls use a different table from floors, so dispatch on the family
        // rather than treating every autotile as A2.
        const isWall = usesWallAutotileTable(resolvedTileId);
        const refresh = isWall ? refreshWallShapes : refreshAutotileShapes;
        const fill = isWall ? fillWallRect : fillRect;

        let painted: number[][];
        if (skipOccupied) {
          // paint cell by cell, then refresh, so occupied cells keep what they have
          const next = grid.map((row) => [...row]);
          for (let j = y; j < y + clippedHeight; j++) {
            for (let i = x; i < x + clippedWidth; i++) {
              if ((next[j]?.[i] ?? 0) === 0) next[j][i] = resolvedTileId;
            }
          }
          painted = refresh(next, {
            region: { x: x - 1, y: y - 1, width: clippedWidth + 2, height: clippedHeight + 2 },
          });
        } else {
          painted = fill(grid, { x, y, width, height }, resolvedTileId);
        }

        writeLayer(mapData, layer, painted);

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        const lines = [
          `Painted ${clippedWidth}x${clippedHeight} tiles at (${x}, ${y}) on map ${mapId}, layer ${layer}.`,
        ];
        if (clippedWidth !== width || clippedHeight !== height) {
          lines.push(`Clipped to the map bounds (${mapData.width}x${mapData.height}).`);
        }
        if (skippedCells > 0) {
          lines.push(`Left ${skippedCells} already-occupied cell(s) untouched (skipOccupied).`);
        }
        if (overwrittenCells > 0 && layer > 0) {
          lines.push(
            `Overwrote ${overwrittenCells} tile(s) that were already on layer ${layer}. ` +
            'On the upper layers that usually means clobbering decoration placed earlier — ' +
            'pass skipOccupied to paint only empty cells, or place whatever should appear ' +
            'on top last.'
          );
        }
        if (isTileA2(resolvedTileId)) {
          lines.push(
            `Material: A2 ground kind ${getAutotileKind(resolvedTileId)}. ` +
            'Floor autotile shapes were computed for the area and the tiles around it.'
          );
        } else if (isWall) {
          lines.push(
            `Material: ${isTileA3(resolvedTileId) ? 'A3' : 'A4'} wall kind ${getAutotileKind(resolvedTileId)}. ` +
            'Wall autotile shapes were computed for the area and the tiles around it, so the ' +
            'block has proper edges. A building is a roof block sitting on a wall block; the ' +
            'A3 sheet pairs each roof with the wall 8 kinds below it.'
          );
        } else {
          lines.push(
            `Tile id ${resolvedTileId} is not an autotile this tool computes shapes for, so it ` +
            'was written as-is. A1 water and waterfalls follow a third table and are not ' +
            'supported yet; B/C/D/E object tiles have no shapes and are correct as written.'
          );
        }
        lines.push(...advice);
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

  server.tool(
    'apply_wall_shadows',
    'Write the shadow plane the way the editor does: every tile with a wall or ' +
      'roof (A3/A4) immediately to its left gets its left half darkened. This is ' +
      'the plane fill_map_region cannot reach, and without it buildings read as ' +
      'flat cut-outs. Run it after the walls are placed.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      overwrite: z.boolean().default(false)
        .describe('Replace shadows already in the map. Off by default so hand-placed shading survives.'),
    },
    async ({ mapId, overwrite }) => {
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
        const result = applyWallShadows(mapData, { overwrite });

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(`Applied ${result.added} wall shadows to map ${mapId}`);

        const lines = [`Map ${mapId}: added ${result.added} shadow tile(s).`];
        if (result.cleared > 0) lines.push(`Cleared ${result.cleared} shadow tile(s) that no longer sit beside a wall.`);
        if (result.added === 0 && result.cleared === 0) {
          lines.push(
            'Nothing changed — either the map has no A3/A4 walls yet, or its shadows are ' +
            'already up to date.'
          );
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
