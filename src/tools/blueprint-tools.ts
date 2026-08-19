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
  NOTCH_CORNERS,
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
      'roof material. The footprint can be an L rather than a box — see ' +
      'notchCorner — in which case the roof turns the corner with the set\'s own ' +
      'inner-corner eave pieces and the wall band steps up with the short wing. ' +
      'The door is emitted as an event carrying a !Door sprite, because RPG Maker ' +
      'doors are events and not tiles.',
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
      notchCorner: z.enum(NOTCH_CORNERS as [string, ...string[]]).optional()
        .describe(
          'Bite a rectangle out of this corner of the footprint, making the building an L ' +
          'instead of a box. Needs notchWidth and notchHeight. A notch on the door side ' +
          '(bottomLeft/bottomRight with the default doorSide) shortens those columns, so their ' +
          'wall band and their door move up with them, and the roof turns a downward concave ' +
          'corner — which is the one the roof sets have a dedicated eave piece for. A notch on ' +
          'the far side bends only the roof, into an upward corner no set has a piece for; the ' +
          'plain edge piece is used there, which is what all four such corners in the 293 ' +
          'sample maps do.'
        ),
      notchWidth: z.number().int().positive().optional()
        .describe('Width of the notch in tiles. Must leave at least 2 columns of building.'),
      notchHeight: z.number().int().positive().optional()
        .describe(
          'Height of the notch in tiles. Must leave every column more rows than wallHeight, ' +
          'and at least 2 rows of roof.'
        ),
      roofInnerCornerTileIds: z.array(z.number().int().min(0).max(1023)).length(2).optional()
        .describe(
          'The two inner-corner eave pieces of a roof named by roofTopLeftTileId, as ' +
          '[down-left, down-right] — the piece for a cell whose down-LEFT diagonal is missing ' +
          'first. Only needed when a notch makes the roof turn a downward concave corner. The ' +
          'four Outside_C sets carry theirs already. They sit off the 3x3 block at no fixed ' +
          'offset, so they cannot be derived: measured across all four sets, 14 of 14 dedicated ' +
          'uses in the sample maps follow the left/right ordering above, with no counterexample.'
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
          'Rows of wall along the door\'s edge of the footprint; the rest of the height is ' +
          'roof. Two is what the shipped sample maps use most.'
        ),
      roofLayer: z.number().int().min(1).max(TILE_LAYERS - 1).default(2)
        .describe(
          'Layer for a nine-slice roof. Never 0: the sloped corners are cut away and would ' +
          'show the map background as black. Layer 2 leaves layer 3 free for anything that ' +
          'should draw in front of the roof.'
        ),
      door: z.boolean().default(true)
        .describe('Emit a door event on the wall row named by doorSide.'),
      doorOffsetX: z.number().int().min(0).optional()
        .describe('Door column within the footprint. Defaults to the middle.'),
      doorSide: z.enum(['bottom', 'top']).default('bottom')
        .describe(
          'Which edge the door is on, and so which edge carries the wall band. "bottom" is ' +
          'the shipped idiom — roof above, wall below, entered from the tile beneath. "top" ' +
          'inverts it so the building can be entered from a street above it, which is what ' +
          'lets a town use both sides of a road. Measured: of the 107 door events in the 293 ' +
          'sample maps, the 88 with an unambiguous approach are entered from below in 88 of ' +
          '88 — no shipped building is entered from the north, and the RTP roof sets are ' +
          'directional art, so a "top" building shows its roof in front of its wall. Use it ' +
          'deliberately.'
        ),
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
          notchCorner, notchWidth, notchHeight, roofInnerCornerTileIds,
          roofSet, roofTopLeftTileId, roofKind, wallKind,
          wallHeight, roofLayer,
          door, doorOffsetX, doorSide, doorSprite, doorSpriteIndex,
          interiorMapId, interiorX, interiorY,
          shadows, allowRoofOverEmptyGround,
        } = args;

        const notchGiven = [notchCorner, notchWidth, notchHeight].filter(
          (v) => v !== undefined
        ).length;
        if (notchGiven !== 0 && notchGiven !== 3) {
          return errorResult(
            'A notch needs all three of notchCorner, notchWidth and notchHeight. Two of them ' +
            'describe half a shape, and guessing the third would put the corner somewhere you ' +
            'did not ask for.'
          );
        }

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
              notch:
                notchCorner !== undefined
                  ? {
                      corner: notchCorner as 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight',
                      width: notchWidth!,
                      height: notchHeight!,
                    }
                  : undefined,
              roofInnerCorners: roofInnerCornerTileIds as [number, number] | undefined,
              wallKind, roofSet, roofTopLeftTileId, roofKind, roofLayer,
              door, doorOffsetX, doorSide, doorSprite, doorSpriteIndex,
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

        const roofCellCount = plan.roofMask.flat().filter(Boolean).length;
        const wallCellCount = plan.wallMask.flat().filter(Boolean).length;

        const lines = [
          `Placed a ${width}x${height} building at (${x}, ${y}) on map ${mapId}` +
            (notchCorner !== undefined
              ? `, with a ${notchWidth}x${notchHeight} notch out of its ${notchCorner} corner.`
              : '.'),
          roof.style === 'nineslice'
            ? `Roof: nine-slice set from tile ${roof.topLeft}, ${roofCellCount} tile(s) in a ` +
              `${plan.roofRect.width}x${plan.roofRect.height} box on layer ${roofLayer}.`
            : `Roof: A3 kind ${roof.kind}, ${roofCellCount} tile(s) in a ` +
              `${plan.roofRect.width}x${plan.roofRect.height} box on layer 0.`,
          `Walls: ${isA3Kind(result.wallKind) ? 'A3' : 'A4'} kind ${result.wallKind}, ` +
            `${wallCellCount} tile(s) in a ${plan.wallRect.width}x${plan.wallRect.height} box at ` +
            `(${plan.wallRect.x}, ${plan.wallRect.y}) on layer 0, with wall autotile shapes.`,
        ];

        if (plan.door && result.doorEventId !== null) {
          lines.push(
            `Door: event ${result.doorEventId} at (${plan.door.x}, ${plan.door.y}) on the ` +
            `${plan.door.side} edge, using ${doorSprite} index ${doorSpriteIndex}, ` +
            'player-touch trigger. Approach it from ' +
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
