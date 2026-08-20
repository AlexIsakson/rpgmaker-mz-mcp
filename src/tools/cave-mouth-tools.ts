import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { readLayer, writeLayer, TILE_LAYERS } from '../core/map-layers.js';
import {
  refreshAutotileShapes,
  makeAutotileId,
  getAutotileKind,
  TILE_ID_A4,
  TILE_ID_MAX,
  isTileA4WallTop,
} from '../core/autotile.js';
import { refreshWallShapes } from '../core/wall-autotile.js';
import { applyPlacements, type Placement } from '../core/tile-batch.js';
import { propCells } from '../core/props.js';
import { standableGrid } from '../core/walkability.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { checkSheetsPresent } from '../core/tileset-sheets.js';
import { planCaveMouth, CaveMouthError, type CliffCell } from '../core/cave-mouth.js';
import { resolveStairProp } from './stairs-tools.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';
import { logger } from '../logger.js';

const A4_KIND_MIN = getAutotileKind(TILE_ID_A4);
const A4_KIND_MAX = getAutotileKind(TILE_ID_MAX) - 1;

/** The entrance 75 of the corpus's transfer events actually use, and the one already
 * measured standable — see "Cave Entrance" in ROADMAP.md. */
const DEFAULT_ENTRANCE_TILE = 'Entrance A';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export function registerCaveMouthTools(server: McpServer): void {
  server.tool(
    'place_cave_mouth',
    'Paint a cliff for a cave mouth or mine entrance to sit in, on an outdoor ' +
      'map. The RTP entrance objects are dark doorway art drawn to be set into ' +
      'rock — placed alone on grass they render as a black shape floating in a ' +
      'field, because nothing paints the rock behind them. This does: a capped ' +
      'wall-face block, sized to the entrance, with the entrance object on top. ' +
      'Purely visual — it writes no event, so pair it with place_stairs or ' +
      'link_dungeon_floors (with the entrance tile already painted, so pass ' +
      'nothing for its own tile argument) to lead somewhere.',
    {
      mapId: z.number().int().positive().describe('Map to paint on'),
      x: z.number().int().min(0).describe('X of the entrance\'s own top-left tile'),
      y: z.number().int().min(0).describe('Y of the entrance\'s own top-left tile'),
      entranceTile: z.string().default(DEFAULT_ENTRANCE_TILE)
        .describe(
          `Entrance object name — see list_tileset_props. Defaults to "${DEFAULT_ENTRANCE_TILE}", ` +
          'the one 75 of the shipped transfer events use and the one already found standable; ' +
          '"Cave Entrance" and "Mine Entrance" are taller (1x2) alternatives.'
        ),
      cliffKind: z.number().int().min(A4_KIND_MIN).max(A4_KIND_MAX)
        .describe(
          'A4 material for the cliff. Must be a wall *top* — an even block row of the A4 sheet ' +
          '(80-87, 96-103, 112-119). The face beneath it defaults to this kind plus 8. Which kind ' +
          'reads as rock is not predictable from the sheet column and varies per tileset — ' +
          'render a map and look.'
        ),
      cliffFaceKind: z.number().int().min(A4_KIND_MIN).max(A4_KIND_MAX).optional()
        .describe('A4 wall face. Defaults to cliffKind + 8, the pairing the sample maps use.'),
      margin: z.number().int().min(0).default(1).describe('Cliff either side of the entrance, in tiles'),
      headroom: z.number().int().min(0).default(1)
        .describe('Rows of rock face above the entrance before the capping row of wall top'),
      layer: z.number().int().min(0).max(TILE_LAYERS - 1).default(0).describe('Layer for the cliff'),
      propLayer: z.number().int().min(1).max(TILE_LAYERS - 1).default(1)
        .describe('Layer for the entrance object'),
    },
    async (args) => {
      try {
        const { mapId, x, y } = args;
        const project = requireProject();
        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return errorResult(`Map ID ${mapId} not found.`);
        }
        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;

        if (!isTileA4WallTop(makeAutotileId(args.cliffKind, 0))) {
          return errorResult(
            `A4 kind ${args.cliffKind} is a wall *face*, not a wall top. The A4 sheet alternates ` +
            'top row / face row, so wall tops are 80-87, 96-103 and 112-119. The cliff is capped ' +
            'with the top and the face is drawn beneath it.'
          );
        }
        const cliffFaceKind = args.cliffFaceKind ?? args.cliffKind + 8;

        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);

        const sheetRefusal = checkSheetsPresent(
          [
            { kind: args.cliffKind, label: 'cliffKind' },
            { kind: cliffFaceKind, label: 'cliffFaceKind' },
          ],
          tileset.tilesetNames,
          tileset.name
        );
        if (sheetRefusal !== null) return errorResult(sheetRefusal);

        const entranceProp = resolveStairProp(tileset.tilesetNames, args.entranceTile);
        if (!entranceProp) {
          return errorResult(
            `"${args.entranceTile}" is not in tileset ${mapData.tilesetId} "${tileset.name}". ` +
            'Use list_tileset_props to see what it has.'
          );
        }

        let plan;
        try {
          plan = planCaveMouth({
            entranceWidth: entranceProp.width,
            entranceHeight: entranceProp.height,
            margin: args.margin,
            headroom: args.headroom,
          });
        } catch (error) {
          if (error instanceof CaveMouthError) return errorResult(error.message);
          throw error;
        }

        const originX = x - plan.entranceOffset.x;
        const originY = y - plan.entranceOffset.y;
        if (
          originX < 0 || originY < 0 ||
          originX + plan.width > mapData.width || originY + plan.height > mapData.height
        ) {
          return errorResult(
            `The cliff needs a ${plan.width}x${plan.height} area anchored at (${originX}, ` +
            `${originY}), which runs off the edge of the ${mapData.width}x${mapData.height} map. ` +
            'Move the entrance, or lower margin/headroom.'
          );
        }

        // --- paint the cliff ---
        const tileFor: Record<CliffCell, number> = {
          wallTop: makeAutotileId(args.cliffKind, 0),
          wallFace: makeAutotileId(cliffFaceKind, 0),
        };
        let ground = readLayer(mapData, args.layer);
        for (let dy = 0; dy < plan.height; dy++) {
          for (let dx = 0; dx < plan.width; dx++) {
            ground[originY + dy][originX + dx] = tileFor[plan.cells[dy][dx]];
          }
        }
        // Only tiles within one step of the change can need a new shape — the
        // same regional scoping fill_map_region uses — and both tables run,
        // because a wall top is shaped by the floor table and its face by the
        // wall table (layoutToGrid's reasoning, ported here for the same
        // two-material band).
        const region = { x: originX - 1, y: originY - 1, width: plan.width + 2, height: plan.height + 2 };
        ground = refreshWallShapes(refreshAutotileShapes(ground, { region }), { region });
        writeLayer(mapData, args.layer, ground);

        // --- paint the entrance object on top ---
        const placements: Placement[] = propCells(entranceProp).map((cell) => ({
          x: x + cell.dx,
          y: y + cell.dy,
          tileId: cell.tileId,
        }));
        const painted = applyPlacements(readLayer(mapData, args.propLayer), placements, {
          computeShapes: false,
        });
        writeLayer(mapData, args.propLayer, painted.grid);

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(`Placed cave mouth on map ${mapId} at (${x}, ${y})`);

        // Checked after painting, on the real tiles: an entrance object is not
        // reliably standable on its own — "Cave Entrance" is impassable in the
        // Outside tileset, which is why the default here is "Entrance A", the
        // one already measured standable — and it is checked rather than
        // assumed regardless of which name was given.
        const notes: string[] = [];
        const standable = standableGrid(mapData, tileset.flags);
        if (!standable[y]?.[x]) {
          notes.push(
            `The entrance's own tile at (${x}, ${y}) is not standable in this tileset, so nothing ` +
            `walking onto it will ever trigger. Pass a different entranceTile, or check with ` +
            'check_map_walkability.'
          );
        }

        const lines = [
          `Painted a cave mouth on map ${mapId} at (${x}, ${y}): "${entranceProp.name}" ` +
          `(${entranceProp.width}x${entranceProp.height}) set into a ${plan.width}x${plan.height} ` +
          `cliff (A4 top kind ${args.cliffKind} over face kind ${cliffFaceKind}).`,
          'No event was written — pair this with place_stairs or link_dungeon_floors, entrance ' +
          'tile argument omitted since the art is already here, to lead somewhere.',
          'The capping row of wall top is passable along itself but not from the ground around ' +
          'it — the same reason generate_interior tells a caller to start check_map_walkability ' +
          'from the room\'s own floor rather than its wall tops. check_map_walkability will name ' +
          'those tiles a small cut-off area; that is this row, not a mistake.',
        ];
        if (painted.overwritten > 0) {
          lines.push(`Overwrote ${painted.overwritten} tile(s) already on layer ${args.propLayer}.`);
        }
        lines.push(...notes.map((n) => `Note: ${n}`));

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
