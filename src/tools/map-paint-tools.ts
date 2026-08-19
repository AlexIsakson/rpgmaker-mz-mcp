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
import { applyPlacements, type Placement } from '../core/tile-batch.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { loadA2Materials } from '../core/tileset-image.js';
import { checkGroundKinds, overlayKindsAmong } from '../core/ground-material.js';
import { checkSheetsPresent, type SheetRequest } from '../core/tileset-sheets.js';
import { applyWallShadows } from '../core/shadows.js';
import type { MapData } from '../schemas/map.js';
import { logger } from '../logger.js';

/** A2 ground autotiles occupy kinds 16-47 (an 8-wide by 4-tall sheet). */
const A2_KIND_MIN = getAutotileKind(TILE_ID_A2);
const A2_KIND_MAX = getAutotileKind(TILE_ID_A3) - 1;
/** A3 walls and roofs are 48-79, A4 walls and wall tops 80-127. */
const AUTOTILE_KIND_MAX = getAutotileKind(TILE_ID_MAX) - 1;

/**
 * Cap on one paint_tiles call. A decoration pass over a 40x30 town runs to a few
 * hundred tiles, so this is well clear of real use while keeping a runaway list
 * from producing a response nothing can read.
 */
const BATCH_LIMIT = 4096;

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

        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);

        // A tileset slot is allowed to be empty, and a tile that addresses an
        // empty one draws nothing while the map data insists it is there. This
        // is cheaper to detect than the overlay check below — it needs the
        // tileset's names, not its image — so it goes first.
        const sheetRefusal = checkSheetsPresent(
          autotileKind !== undefined
            ? [{ kind: autotileKind, label: 'autotileKind' }]
            : [{ tileId: tileId!, label: 'tileId' }],
          tileset.tilesetNames,
          tileset.name
        );
        if (sheetRefusal !== null) {
          return {
            content: [{ type: 'text' as const, text: sheetRefusal }],
            isError: true,
          };
        }

        // Whether a material can go on layer 0, and whether it will show a
        // boundary, are properties of the tileset image — check them before
        // painting rather than leaving the caller to discover it in a render.
        // Shared with the generators, which paint far more in one call than
        // this does; see src/core/ground-material.ts.
        if (autotileKind !== undefined && isTileA2(resolvedTileId)) {
          const check = checkGroundKinds(
            [{
              kind: autotileKind,
              label: 'autotileKind',
              layer,
              coversMap: clippedWidth >= mapData.width && clippedHeight >= mapData.height,
            }],
            await loadA2Materials(project.path, tileset.tilesetNames),
            tileset.name,
            { allowOverlayOnGround }
          );
          if (check.refusal !== null) {
            return {
              content: [{ type: 'text' as const, text: check.refusal }],
              isError: true,
            };
          }
          advice.push(...check.notes);
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
    'paint_tiles',
    'Write many individual tiles in one call — the counterpart to ' +
      'fill_map_region, for the scattered work: props, windows, signs, the ' +
      'quadrants of a tree, a decoration pass. Each entry names its own tile and ' +
      'layer, so one call can cover several layers at once. The result is exactly ' +
      'what painting the same tiles one at a time would produce — it just takes ' +
      'one file write and one shape refresh instead of hundreds.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      tiles: z.array(
        z.object({
          x: z.number().int().describe('X position in tiles'),
          y: z.number().int().describe('Y position in tiles'),
          tileId: z.number().int().min(0).optional()
            .describe(
              'Raw tile id. This is the usual choice here — B/C/D/E object tiles have no ' +
              'shapes and are correct as written. 0 clears the cell.'
            ),
          autotileKind: z.number().int().min(A2_KIND_MIN).max(AUTOTILE_KIND_MAX).optional()
            .describe(
              'Autotile material, as an alternative to tileId, when a cell should take part ' +
              'in shape computation with its neighbours. An A2 kind on layer 0 is checked ' +
              'against the tileset image the same way fill_map_region checks it.'
            ),
          layer: z.number().int().min(0).max(TILE_LAYERS - 1).optional()
            .describe('Tile layer 0-3. Defaults to 0.'),
        })
      ).min(1).max(BATCH_LIMIT)
        .describe(`Tiles to write, up to ${BATCH_LIMIT}. Later entries win over earlier ones.`),
      skipOccupied: z.boolean().default(false)
        .describe(
          'Only write cells that are currently empty, so a later object cannot silently ' +
          'overwrite an earlier one. Applies within the batch as well as to what was already ' +
          'on the map.'
        ),
      computeShapes: z.boolean().default(true)
        .describe(
          'Recompute autotile shapes over the affected area. Turn it off when the batch ' +
          'carries raw autotile ids whose shapes were worked out elsewhere and must be ' +
          'written exactly as given.'
        ),
      allowOverlayOnGround: z.boolean().default(false)
        .describe(
          'Permit an A2 overlay material (one with transparent edge pieces) on layer 0. ' +
          'Normally refused, because its edges show the map background as black in game.'
        ),
    },
    async ({ mapId, tiles, skipOccupied, computeShapes, allowOverlayOnGround }) => {
      try {
        const badEntry = tiles.findIndex(
          (t) => (t.tileId === undefined) === (t.autotileKind === undefined)
        );
        if (badEntry !== -1) {
          const t = tiles[badEntry];
          return {
            content: [{
              type: 'text' as const,
              text:
                `Entry ${badEntry} at (${t.x}, ${t.y}) must give exactly one of tileId or ` +
                'autotileKind.',
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

        const resolved = tiles.map((t) => ({
          x: t.x,
          y: t.y,
          layer: t.layer ?? 0,
          tileId: t.autotileKind !== undefined ? makeAutotileId(t.autotileKind, 0) : t.tileId!,
        }));

        // The whole batch is checked before any of it is written. A partial
        // application would be worse than a refusal: you could not tell from the
        // result which tiles had landed.
        const tilesetForBatch = await TilesetReader.get(project.dataPath, mapData.tilesetId);

        // A batch can name the same missing sheet hundreds of times — a prop
        // pass is one tile id repeated — so each distinct value is reported
        // once, labelled with the first entry that used it and with the
        // argument that entry actually gave.
        const firstUse = new Map<string, { request: SheetRequest }>();
        tiles.forEach((t, index) => {
          const key = t.autotileKind !== undefined ? `k${t.autotileKind}` : `t${t.tileId}`;
          if (firstUse.has(key)) return;
          firstUse.set(key, {
            request: {
              kind: t.autotileKind,
              tileId: t.tileId,
              label: `entry ${index} at (${t.x}, ${t.y})`,
            },
          });
        });
        const sheetRefusal = checkSheetsPresent(
          [...firstUse.values()].map((e) => e.request),
          tilesetForBatch.tilesetNames,
          tilesetForBatch.name
        );
        if (sheetRefusal !== null) {
          return {
            content: [{ type: 'text' as const, text: sheetRefusal }],
            isError: true,
          };
        }

        const groundKinds = new Set(
          resolved
            .filter((t) => t.layer === 0 && isTileA2(t.tileId))
            .map((t) => getAutotileKind(t.tileId))
        );
        if (groundKinds.size > 0 && !allowOverlayOnGround) {
          // The judgement is shared (src/core/ground-material.ts); the remedy is
          // not. Here the fix is to move entries of the batch to another layer,
          // rather than to pick a different material.
          const overlayKinds = overlayKindsAmong(
            groundKinds,
            await loadA2Materials(project.path, tilesetForBatch.tilesetNames)
          );
          if (overlayKinds.length > 0) {
            return {
              content: [{
                type: 'text' as const,
                text:
                  `A2 kind(s) ${overlayKinds.join(', ')} in "${tilesetForBatch.name}" are overlay ` +
                  'materials or empty slots: their edge pieces are transparent, so on layer 0 ' +
                  'they show the map background, which renders black in game. Nothing was ' +
                  'written.\n\n' +
                  'Move those entries to layer 1 or above over a ground material, use ' +
                  'describe_tileset_materials to see which kinds are ground, or pass ' +
                  'allowOverlayOnGround if this is deliberate.',
              }],
              isError: true,
            };
          }
        }

        const byLayer = new Map<number, Placement[]>();
        for (const t of resolved) {
          const list = byLayer.get(t.layer) ?? [];
          list.push({ x: t.x, y: t.y, tileId: t.tileId });
          byLayer.set(t.layer, list);
        }

        let painted = 0;
        let skipped = 0;
        let duplicates = 0;
        let overwritten = 0;
        const outOfBounds: string[] = [];
        const perLayer: string[] = [];

        for (const layer of [...byLayer.keys()].sort((a, b) => a - b)) {
          const result = applyPlacements(readLayer(mapData, layer), byLayer.get(layer)!, {
            skipOccupied,
            computeShapes,
          });
          writeLayer(mapData, layer, result.grid);

          painted += result.painted;
          skipped += result.skipped;
          duplicates += result.duplicates;
          overwritten += result.overwritten;
          outOfBounds.push(...result.outOfBounds.map((p) => `(${p.x}, ${p.y})`));
          perLayer.push(`  layer ${layer}: ${result.painted} tile(s)`);
        }

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(`Painted ${painted} tile(s) on map ${mapId} across ${byLayer.size} layer(s)`);

        const lines = [
          `Wrote ${painted} of ${tiles.length} tile(s) to map ${mapId}.`,
          ...perLayer,
        ];
        if (outOfBounds.length > 0) {
          lines.push(
            `Discarded ${outOfBounds.length} placement(s) outside the ${mapData.width}x${mapData.height} ` +
            `map: ${outOfBounds.slice(0, 8).join(' ')}${outOfBounds.length > 8 ? ' ...' : ''}`
          );
        }
        if (skipped > 0) {
          lines.push(`Left ${skipped} already-occupied cell(s) untouched (skipOccupied).`);
        }
        if (duplicates > 0) {
          lines.push(
            `${duplicates} cell(s) were written more than once by this batch and kept the last ` +
            'value. That is usually a mistake in the list rather than an intention.'
          );
        }
        if (overwritten > 0) {
          lines.push(
            `Replaced ${overwritten} tile(s) that were already on the map. Pass skipOccupied to ` +
            'paint only empty cells.'
          );
        }
        lines.push(
          computeShapes
            ? 'Autotile shapes were computed once over the affected area, after every tile ' +
              'landed. Both the ground and wall tables were run, so a batch touching each ' +
              'family comes out right; A1 water follows a third table and passed through ' +
              'untouched.'
            : 'Shapes were not computed — every tile was written exactly as given.'
        );
        lines.push('Use get_map_grid to see the result as a text grid.');

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
