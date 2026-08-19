import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { TILE_LAYERS } from '../core/map-layers.js';
import { applyWallShadows } from '../core/shadows.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { checkSheetsPresent } from '../core/tileset-sheets.js';
import {
  placeBuildingOnMap,
  BuildingPlacementError,
} from '../core/building-placement.js';
import {
  isA3Kind,
  ROOF_SET_NAMES,
  OUTSIDE_C_ROOF_SETS,
  A3_KIND_MIN,
  A3_KIND_MAX,
  A4_KIND_MAX,
} from '../core/blueprint.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import { MapRefError } from '../core/map-refs.js';
import { requireProjectSheets } from './map-ref-loaders.js';
import type { MapData } from '../schemas/map.js';
import { logger } from '../logger.js';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export function registerBlueprintTools(server: McpServer): void {
  server.tool(
    'place_building',
    'Place a whole building in one call: roof, walls and a working door event. ' +
      'Takes a footprint and a roof; the wall material defaults to the A3 kind ' +
      'that pairs with the roof. Roofs can be an Outside_C nine-slice set (sloped ' +
      'sides and a shingled eave — what real RPG Maker houses use) or a plain A3 ' +
      'roof material. The door is emitted as an event carrying a !Door sprite, ' +
      'because RPG Maker doors are events and not tiles.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      x: z.number().int().min(0).describe('Left edge of the footprint, in tiles'),
      y: z.number().int().min(0).describe('Top edge of the footprint, in tiles'),
      width: z.number().int().positive().describe('Footprint width in tiles'),
      height: z.number().int().positive()
        .describe('Footprint height in tiles, roof rows plus wall rows'),
      roofSet: z.enum(ROOF_SET_NAMES as [string, ...string[]]).optional()
        .describe(
          `Nine-slice roof set from Outside_C: ${OUTSIDE_C_ROOF_SETS.map((s) => `${s.name} (${s.topLeft})`).join(', ')}. ` +
          'Only valid when the map\'s tileset uses Outside_C as its C sheet; with any other ' +
          'tileset pass roofTopLeftTileId instead.'
        ),
      roofTopLeftTileId: z.number().int().min(0).max(1023).optional()
        .describe(
          'Top-left tile id of a 3x3 nine-slice roof block on a B/C/D/E object sheet (0-1023), ' +
          'as an alternative to roofSet. Cells are addressed topLeft + row * 8 + col, because ' +
          'those sheets are laid out as two 8-wide halves.'
        ),
      roofKind: z.number().int().min(A3_KIND_MIN).max(A3_KIND_MAX).optional()
        .describe(
          `A3 autotile roof material (${A3_KIND_MIN}-${A3_KIND_MAX}), as an alternative to a ` +
          'nine-slice set. A3 roof materials are flat texture with no edge art, so the result ' +
          'reads as a slab rather than a roof — prefer a nine-slice set unless you want a ' +
          'terrace or a flat top.'
        ),
      wallKind: z.number().int().min(A3_KIND_MIN).max(A4_KIND_MAX).optional()
        .describe(
          'A3/A4 autotile wall material. Defaults to roofKind + 8 — the A3 sheet is laid out ' +
          'roof row / wall row, so the wall that belongs to a roof is the same column one block ' +
          'row down. Required when the roof is a nine-slice set, which carries no wall.'
        ),
      wallHeight: z.number().int().positive().default(2)
        .describe(
          'Rows of wall along the bottom of the footprint; the rest of the height is roof. ' +
          'Two is what the shipped sample maps use most.'
        ),
      roofLayer: z.number().int().min(1).max(TILE_LAYERS - 1).default(2)
        .describe(
          'Layer for a nine-slice roof. Never 0: the sloped corners are cut away and would ' +
          'show the map background as black. Layer 2 leaves layer 3 free for anything that ' +
          'should draw in front of the roof.'
        ),
      door: z.boolean().default(true)
        .describe('Emit a door event on the bottom wall row.'),
      doorOffsetX: z.number().int().min(0).optional()
        .describe('Door column within the footprint. Defaults to the middle.'),
      doorSprite: z.string().default('!Door1').describe('Door character sheet'),
      doorSpriteIndex: z.number().int().min(0).max(7).default(0)
        .describe('Which door on the sheet (0-7)'),
      interiorMapId: z.number().int().positive().optional()
        .describe('Map the door leads to. Without it the door animates but goes nowhere.'),
      interiorX: z.number().int().min(0).optional().describe('Arrival X inside'),
      interiorY: z.number().int().min(0).optional().describe('Arrival Y inside'),
      shadows: z.boolean().default(true)
        .describe('Refresh the map\'s wall shadow plane afterwards. Existing shadows are kept.'),
      allowRoofOverEmptyGround: z.boolean().default(false)
        .describe(
          'Place a nine-slice roof even where its cut-away corners have nothing painted ' +
          'beneath them. Normally refused, because those corners render black in game.'
        ),
    },
    async (args) => {
      try {
        const {
          mapId, x, y, width, height,
          roofSet, roofTopLeftTileId, roofKind, wallKind,
          wallHeight, roofLayer,
          door, doorOffsetX, doorSprite, doorSpriteIndex,
          interiorMapId, interiorX, interiorY,
          shadows, allowRoofOverEmptyGround,
        } = args;

        const project = requireProject();
        await requireProjectSheets(project.path, [[doorSprite, 'doorSprite']]);
        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return errorResult(`Map ID ${mapId} not found.`);
        }
        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;
        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);

        // A tileset slot is allowed to be empty, and a kind addressing an empty
        // one draws nothing. A3 — where roofKind and its paired wall live — is
        // absent from four of the six tilesets a new project ships, so a
        // building placed with an A3 roof on `Inside` or `Dungeon` used to come
        // out invisible and be reported as placed. The derived wall
        // (`roofKind + 8`) is on the same sheet as its roof, so checking the
        // roof covers it.
        const sheetRefusal = checkSheetsPresent(
          [
            { kind: roofKind, label: 'roofKind' },
            { kind: wallKind, label: 'wallKind' },
            { tileId: roofTopLeftTileId, label: 'roofTopLeftTileId' },
          ],
          tileset.tilesetNames,
          tileset.name
        );
        if (sheetRefusal !== null) return errorResult(sheetRefusal);

        let result;
        try {
          result = await placeBuildingOnMap(
            mapData,
            {
              x, y, width, height, wallHeight,
              wallKind, roofSet, roofTopLeftTileId, roofKind, roofLayer,
              door, doorOffsetX, doorSprite, doorSpriteIndex,
              doorTarget:
                interiorMapId !== undefined
                  ? { mapId: interiorMapId, x: interiorX ?? 0, y: interiorY ?? 0 }
                  : undefined,
              allowRoofOverEmptyGround,
            },
            {
              projectPath: project.path,
              tilesetNames: tileset.tilesetNames,
              tilesetName: tileset.name,
            }
          );
        } catch (error) {
          if (error instanceof BuildingPlacementError) return errorResult(error.message);
          throw error;
        }

        const { plan, roof } = result;

        let shadowResult = { added: 0, cleared: 0 };
        if (shadows) shadowResult = applyWallShadows(mapData, { overwrite: false });

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(
          `Placed building on map ${mapId} at (${x},${y}) ${width}x${height}` +
          (result.doorEventId !== null ? `, door event ${result.doorEventId}` : '')
        );

        const lines = [
          `Placed a ${width}x${height} building at (${x}, ${y}) on map ${mapId}.`,
          roof.style === 'nineslice'
            ? `Roof: nine-slice set from tile ${roof.topLeft}, ` +
              `${plan.roofRect.width}x${plan.roofRect.height} on layer ${roofLayer}.`
            : `Roof: A3 kind ${roof.kind}, ` +
              `${plan.roofRect.width}x${plan.roofRect.height} on layer 0.`,
          `Walls: ${isA3Kind(result.wallKind) ? 'A3' : 'A4'} kind ${result.wallKind}, ` +
            `${plan.wallRect.width}x${plan.wallRect.height} at (${plan.wallRect.x}, ${plan.wallRect.y}) ` +
            'on layer 0, with wall autotile shapes.',
        ];

        if (plan.door && result.doorEventId !== null) {
          lines.push(
            `Door: event ${result.doorEventId} at (${plan.door.x}, ${plan.door.y}) using ` +
            `${doorSprite} index ${doorSpriteIndex}, player-touch trigger. Approach it from ` +
            `(${plan.door.approach.x}, ${plan.door.approach.y})` +
            (interiorMapId !== undefined ? `, leading to map ${interiorMapId}.` : '.')
          );
        }

        if (shadows) {
          lines.push(
            shadowResult.added > 0
              ? `Shadows: added ${shadowResult.added} tile(s) beside the new walls.`
              : 'Shadows: nothing to add.'
          );
        }

        lines.push(...result.notes.map((n) => `\nNote: ${n}`));
        lines.push(
          '\nCheck the result with get_map_grid, and check_map_walkability to confirm the door ' +
          'is reachable and nothing is standing inside a wall.'
        );

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        if (error instanceof MapRefError) return errorResult(error.message);
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
