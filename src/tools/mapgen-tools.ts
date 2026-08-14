import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { readLayer, writeLayer, TILE_LAYERS } from '../core/map-layers.js';
import {
  generateDungeon,
  generateCave,
  layoutToGrid,
  renderLayoutAscii,
  layoutStats,
  type GeneratedLayout,
} from '../core/mapgen.js';
import { getAutotileKind, TILE_ID_A2, TILE_ID_A3, TILE_ID_MAX } from '../core/autotile.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';
import { logger } from '../logger.js';

const A2_KIND_MIN = getAutotileKind(TILE_ID_A2);
const A2_KIND_MAX = getAutotileKind(TILE_ID_A3) - 1;
const AUTOTILE_KIND_MAX = getAutotileKind(TILE_ID_MAX) - 1;

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
        .describe(
          `A2 material for walkable floor (${A2_KIND_MIN}-${A2_KIND_MAX}). It is painted on ` +
          'the given layer, so it wants an opaque *ground* material — an overlay has ' +
          'transparent edge pieces that render black. Which kinds are which cannot be read ' +
          'off the sheet column; call describe_tileset_materials.'
        ),
      surroundKind: z.number().int().min(A2_KIND_MIN).max(AUTOTILE_KIND_MAX)
        .describe(
          `Material for everything that is not floor. ${A2_KIND_MIN}-${A2_KIND_MAX} is A2 ground, ` +
          `48-79 A3 walls, 80-${AUTOTILE_KIND_MAX} A4 walls and wall tops — an A4 wall top makes ` +
          'a dungeon read as rooms with raised walls instead of two kinds of floor. Shapes are ' +
          'computed with the right table either way. If you pass an A2 kind here it covers most ' +
          'of the map, so the same warning as floorKind applies: check it is a ground material.'
        ),
      wallFaceKind: z.number().int().min(A2_KIND_MIN).max(AUTOTILE_KIND_MAX).optional()
        .describe(
          'Material for the south edge of a wall mass — the face you see where wall meets floor. ' +
          'Defaults to surroundKind + 8 when the surround is an A4 wall top, which is the ' +
          'pairing the sample maps use. Without a face the map has no height.'
        ),
      seed: z.number().int().default(1).describe('Same seed reproduces the same layout'),
      layer: z.number().int().min(0).max(TILE_LAYERS - 1).default(0).describe('Tile layer 0-3'),
      roomAttempts: z.number().int().positive().default(40)
        .describe('dungeon: how many times to try placing a room; higher is denser'),
      minRoomSize: z.number().int().positive().default(3).describe('dungeon: smallest room side'),
      maxRoomSize: z.number().int().positive().default(8).describe('dungeon: largest room side'),
      irregularRoomChance: z.number().min(0).max(1).default(0.35)
        .describe('dungeon: share of rooms carved as two overlapping rectangles, so L- or T-shaped'),
      deadEndAttempts: z.number().int().min(0).optional()
        .describe(
          'dungeon: tries at cutting a passage that leads nowhere. Defaults to 0.4 per map tile, ' +
          'which lands near the 5.2 dead ends per 100 floor tiles the hand-made maps carry. ' +
          '0 makes every passage arrive somewhere.'
        ),
      fillProbability: z.number().min(0).max(1).default(0.57)
        .describe('cave: starting solid density; lower opens the cave out into one cavern'),
      structureSteps: z.number().int().min(0).max(10).default(2)
        .describe('cave: passes that keep walls ragged and irregular'),
      smoothingSteps: z.number().int().min(0).max(10).default(2)
        .describe('cave: passes that only smooth; higher is rounder and emptier'),
      pillarDensity: z.number().min(0).max(0.2).default(0.035)
        .describe(
          'cave: solid clumps dropped inside open space, as a fraction of floor tiles. 0 leaves ' +
          'the cave hollow with nothing to walk around. None is ever placed where it would seal ' +
          'part of the cave off.'
        ),
    },
    async ({
      mapId, style, floorKind, surroundKind, wallFaceKind, seed, layer,
      roomAttempts, minRoomSize, maxRoomSize, irregularRoomChance, deadEndAttempts,
      fillProbability, structureSteps, smoothingSteps, pillarDensity,
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
            ? generateDungeon({
                width, height, seed, roomAttempts, minRoomSize, maxRoomSize,
                irregularRoomChance, deadEndAttempts,
              })
            : generateCave({
                width, height, seed, fillProbability,
                structureSteps, smoothingSteps, pillarDensity,
              });

        const stats = layoutStats(layout);

        // Only the chosen layer is replaced, so anything on the others — props,
        // torches, chests — is still sitting where the *previous* layout put it.
        // Regenerating over a decorated map leaves that stranded, which reads as
        // treasure floating in solid rock.
        const staleEvents = mapData.events.filter((e) => e !== null).length;
        let staleTiles = 0;
        for (let z = 0; z < TILE_LAYERS; z++) {
          if (z === layer) continue;
          for (const row of readLayer(mapData, z)) {
            for (const tile of row) if (tile !== 0) staleTiles++;
          }
        }

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
        const grid = layoutToGrid(layout, floorKind, surroundKind, { wallFaceKind });
        writeLayer(mapData, layer, grid);

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        const lines = [
          `Generated a ${style} layout on map ${mapId} (${width}x${height}), layer ${layer}, seed ${seed}.`,
          `Floor material: A2 kind ${floorKind}   Surround: ` +
            `${surroundKind <= A2_KIND_MAX ? 'A2 ground' : surroundKind < 80 ? 'A3 wall' : 'A4 wall'} ` +
            `kind ${surroundKind}`,
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

        if (staleEvents > 0 || staleTiles > 0) {
          lines.push(
            '',
            `This map still carries ${staleEvents} event(s) and ${staleTiles} tile(s) on the other ` +
            'layers, placed against the layout that was here before. They have not moved, so ' +
            'anything decorative is now in the wrong place — a chest in solid rock, a torch in ' +
            'mid-air. Clear them, or generate into a fresh map and decorate after.'
          );
        }

        lines.push(
          '',
          'Note: this paints materials only. Whether the player can actually walk on them ' +
            'comes from the tileset passage settings, not from the layout — use get_map_grid ' +
            'to check the result is walkable as intended. decorate_dungeon adds torches, ' +
            'treasure and clutter; give it the same floorKind.'
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
