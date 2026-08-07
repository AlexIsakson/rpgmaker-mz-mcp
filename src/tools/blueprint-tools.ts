import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { readLayer, writeLayer, TILE_LAYERS } from '../core/map-layers.js';
import { fillWallRect } from '../core/wall-autotile.js';
import { applyWallShadows } from '../core/shadows.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { loadTransparentObjectTiles } from '../core/tileset-image.js';
import {
  planBuilding,
  doorEvent,
  findRoofSet,
  pairedWallKind,
  isA3Kind,
  nineSliceFits,
  BlueprintError,
  ROOF_SET_NAMES,
  OUTSIDE_C_SHEET_NAME,
  OUTSIDE_C_ROOF_SETS,
  A3_KIND_MIN,
  A3_KIND_MAX,
  A4_KIND_MAX,
  type RoofPlan,
} from '../core/blueprint.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';
import type { Event } from '../schemas/event.js';
import { logger } from '../logger.js';

/** Set number 6 of a tileset's names is the C sheet — see Tilemap._drawNormalTile. */
const C_SHEET_INDEX = 6;

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/** Append an event, reusing the first free slot the way the editor does. */
function addEvent(mapData: MapData, make: (id: number) => Event): Event {
  let slot = mapData.events.findIndex((e, i) => i > 0 && e === null);
  if (slot === -1) slot = Math.max(mapData.events.length, 1);

  while (mapData.events.length <= slot) mapData.events.push(null);
  const event = make(slot);
  mapData.events[slot] = event;
  return event;
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
          'as an ' +
          'alternative to roofSet. Cells are addressed topLeft + row * 8 + col, because those ' +
          'sheets are laid out as two 8-wide halves.'
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

        const roofChoices = [roofSet, roofTopLeftTileId, roofKind].filter((v) => v !== undefined);
        if (roofChoices.length !== 1) {
          return errorResult('Give exactly one of roofSet, roofTopLeftTileId or roofKind.');
        }

        const project = requireProject();
        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return errorResult(`Map ID ${mapId} not found.`);
        }
        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;

        if (x + width > mapData.width || y + height > mapData.height) {
          return errorResult(
            `The footprint runs off the map (map is ${mapData.width}x${mapData.height}, ` +
            `footprint is ${width}x${height} at (${x}, ${y})). A clipped building loses its ` +
            'edge pieces, so this is refused rather than trimmed.'
          );
        }

        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);

        // --- resolve the roof ---
        let roof: RoofPlan;
        let roofSheetName: string | undefined;

        if (roofKind !== undefined) {
          roof = { style: 'autotile', kind: roofKind };
        } else if (roofSet !== undefined) {
          const cSheet = tileset.tilesetNames[C_SHEET_INDEX];
          if (cSheet !== OUTSIDE_C_SHEET_NAME) {
            return errorResult(
              `roofSet names a set on ${OUTSIDE_C_SHEET_NAME}, but tileset "${tileset.name}" uses ` +
              `"${cSheet || '(none)'}" as its C sheet. Object sheets have no shared layout, so a ` +
              'set from one is meaningless on another — pass roofTopLeftTileId with the top-left ' +
              'tile of a roof block you have located on this tileset, or use roofKind for a flat ' +
              'A3 roof.'
            );
          }
          roofSheetName = cSheet;
          roof = { style: 'nineslice', topLeft: findRoofSet(roofSet)!.topLeft };
        } else {
          const topLeft = roofTopLeftTileId!;
          if (!nineSliceFits(topLeft)) {
            return errorResult(
              `Tile ${topLeft} cannot start a 3x3 block — it sits too close to the edge of its ` +
              'half of the sheet, so the block would wrap around. The object sheets are 16 tiles ' +
              'wide but addressed as two 8-wide halves.'
            );
          }
          const sheetIndex = 5 + Math.floor(topLeft / 256);
          roofSheetName = tileset.tilesetNames[sheetIndex];
          roof = { style: 'nineslice', topLeft };
        }

        const resolvedWallKind =
          wallKind ?? (roofKind !== undefined ? pairedWallKind(roofKind) : undefined);
        if (resolvedWallKind === undefined) {
          return errorResult(
            'wallKind is required with a nine-slice roof: the C-sheet sets are roof art only ' +
            'and carry no wall to stand on. A3 wall kinds are 56-63 and 72-79.'
          );
        }

        // --- plan ---
        let plan;
        try {
          plan = planBuilding({
            x, y, width, height,
            wallHeight,
            wallKind: resolvedWallKind,
            roof,
            doorOffsetX: door ? (doorOffsetX ?? Math.floor(width / 2)) : null,
          });
        } catch (error) {
          if (error instanceof BlueprintError) return errorResult(error.message);
          throw error;
        }

        const notes = [...plan.warnings];

        // --- walls, on the ground layer ---
        let ground = readLayer(mapData, 0);
        ground = fillWallRect(ground, plan.wallRect, plan.wallTileId);

        // --- roof ---
        if (plan.roofTiles) {
          // The cut-away corners of a nine-slice set show whatever is beneath
          // them, so they need ground under them and cannot go on layer 0. Only
          // the cells that are actually cut matter, so measure rather than
          // assume — see finding 1 of the visual review, same failure mode.
          const uniqueRoofTiles = [...new Set(plan.roofTiles.flat())];
          const cut = roofSheetName
            ? await loadTransparentObjectTiles(project.path, roofSheetName, uniqueRoofTiles)
            : null;

          const lower: number[][][] = [];
          for (let z = 0; z < roofLayer; z++) {
            lower.push(z === 0 ? ground : readLayer(mapData, z));
          }

          const bare: string[] = [];
          for (let j = 0; j < plan.roofRect.height; j++) {
            for (let i = 0; i < plan.roofRect.width; i++) {
              const tileId = plan.roofTiles[j][i];
              if (cut && !cut.has(tileId)) continue;
              const gx = plan.roofRect.x + i;
              const gy = plan.roofRect.y + j;
              if (!lower.some((layer) => (layer[gy]?.[gx] ?? 0) !== 0)) bare.push(`(${gx}, ${gy})`);
            }
          }

          if (bare.length > 0 && !allowRoofOverEmptyGround) {
            return errorResult(
              `${bare.length} roof tile(s) are cut away at the corners and have nothing painted ` +
              `under them: ${bare.slice(0, 8).join(' ')}${bare.length > 8 ? ' ...' : ''}\n\n` +
              'Those cut corners show the layer below, and with nothing there they render as the ' +
              'map background — black in game. Fill the ground under the footprint first ' +
              '(fill_map_region on layer 0), or pass allowRoofOverEmptyGround if the holes are ' +
              'deliberate.'
            );
          }
          if (cut === null) {
            notes.push(
              `Could not read img/tilesets/${roofSheetName}.png, so the roof's cut-away corners ` +
              'were not checked against what is beneath them. If the roof shows black wedges in ' +
              'game, that is why.'
            );
          }

          const roofGrid = readLayer(mapData, roofLayer);
          let overwritten = 0;
          for (let j = 0; j < plan.roofRect.height; j++) {
            for (let i = 0; i < plan.roofRect.width; i++) {
              const gx = plan.roofRect.x + i;
              const gy = plan.roofRect.y + j;
              if (roofGrid[gy][gx] !== 0) overwritten++;
              roofGrid[gy][gx] = plan.roofTiles[j][i];
            }
          }
          writeLayer(mapData, roofLayer, roofGrid);
          if (overwritten > 0) {
            notes.push(
              `Overwrote ${overwritten} tile(s) already on layer ${roofLayer} under the roof.`
            );
          }
        } else {
          ground = fillWallRect(ground, plan.roofRect, plan.roofTileId!);
        }

        writeLayer(mapData, 0, ground);

        // --- door ---
        let doorEventId: number | null = null;
        let doorTargetGiven = false;
        if (plan.door) {
          const target =
            interiorMapId !== undefined
              ? { mapId: interiorMapId, x: interiorX ?? 0, y: interiorY ?? 0 }
              : undefined;
          doorTargetGiven = target !== undefined;

          const placed = addEvent(mapData, (id) =>
            doorEvent(id, plan.door!.x, plan.door!.y, {
              characterName: doorSprite,
              characterIndex: doorSpriteIndex,
              target,
            })
          );
          doorEventId = placed.id;

          if (!doorTargetGiven) {
            notes.push(
              `Door event ${doorEventId} opens but leads nowhere — no interiorMapId was given. ` +
              'Add a Transfer Player command to it once the interior map exists.'
            );
          }
          if (plan.door.approach.y >= mapData.height) {
            notes.push(
              'The door is on the bottom row of the map, so there is no tile in front of it for ' +
              'the player to stand on. It cannot be reached.'
            );
          }
        }

        // --- shadows ---
        let shadowResult = { added: 0, cleared: 0 };
        if (shadows) shadowResult = applyWallShadows(mapData, { overwrite: false });

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(
          `Placed building on map ${mapId} at (${x},${y}) ${width}x${height}` +
          (doorEventId !== null ? `, door event ${doorEventId}` : '')
        );

        const lines = [
          `Placed a ${width}x${height} building at (${x}, ${y}) on map ${mapId}.`,
          plan.roofTiles
            ? `Roof: nine-slice set from tile ${(roof as { topLeft: number }).topLeft}, ` +
              `${plan.roofRect.width}x${plan.roofRect.height} on layer ${roofLayer}.`
            : `Roof: A3 kind ${(roof as { kind: number }).kind}, ` +
              `${plan.roofRect.width}x${plan.roofRect.height} on layer 0.`,
          `Walls: ${isA3Kind(resolvedWallKind) ? 'A3' : 'A4'} kind ${resolvedWallKind}, ` +
            `${plan.wallRect.width}x${plan.wallRect.height} at (${plan.wallRect.x}, ${plan.wallRect.y}) ` +
            'on layer 0, with wall autotile shapes.',
        ];

        if (plan.door && doorEventId !== null) {
          lines.push(
            `Door: event ${doorEventId} at (${plan.door.x}, ${plan.door.y}) using ${doorSprite} ` +
            `index ${doorSpriteIndex}, player-touch trigger. Approach it from ` +
            `(${plan.door.approach.x}, ${plan.door.approach.y})` +
            (doorTargetGiven ? `, leading to map ${interiorMapId}.` : '.')
          );
        }

        if (shadows) {
          lines.push(
            shadowResult.added > 0
              ? `Shadows: added ${shadowResult.added} tile(s) beside the new walls.`
              : 'Shadows: nothing to add.'
          );
        }

        lines.push(...notes.map((n) => `\nNote: ${n}`));
        lines.push(
          '\nCheck the result with get_map_grid, and check_map_walkability to confirm the door ' +
          'is reachable and nothing is standing inside a wall.'
        );

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
