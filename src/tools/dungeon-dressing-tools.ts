import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { readLayer, writeLayer, TILE_LAYERS } from '../core/map-layers.js';
import { applyPlacements, type Placement } from '../core/tile-batch.js';
import { standableGrid } from '../core/walkability.js';
import { getAutotileKind, isAutotile, TILE_ID_A2, TILE_ID_A3 } from '../core/autotile.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { addEvent } from '../core/building-placement.js';
import { collectProps, findProps, propCells, type Prop } from '../core/props.js';
import { planDressing, torchEvent, treasureEvent } from '../core/dungeon-dressing.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';
import type { Event } from '../schemas/event.js';
import { logger } from '../logger.js';

/** Defaults for the RTP Dungeon sheets; anything missing is skipped and reported. */
const DEFAULT_FLOOR_PROPS = [
  'Gravel A (Dirt Cave)', 'Gravel B (Rock Cave)', 'Small Crystals', 'Rubble',
];
const DEFAULT_WALL_PROPS = ['Wall Moss', 'Wall Fern', 'Mural A', 'Mural B'];

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/** Resolve names to single-tile props, reporting the ones this tileset lacks. */
function resolveProps(catalogue: Prop[], names: string[]): { props: Prop[]; missing: string[] } {
  const props: Prop[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const single = findProps(catalogue, name).find((p) => p.width === 1 && p.height === 1);
    if (single) props.push(single);
    else missing.push(name);
  }
  return { props, missing };
}

export function registerDungeonDressingTools(server: McpServer): void {
  server.tool(
    'decorate_dungeon',
    'Furnish a dungeon or cave: torches on the walls, treasure chests in the ' +
      'dead ends, and clutter scattered over the floor and the wall faces. Works ' +
      'on any map whose walls are actually impassable — floor and wall are told ' +
      'apart by the tileset\'s passage flags, not by which material was painted.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      seed: z.number().int().default(1).describe('Same seed, same decoration'),
      floorKind: z.number().int().min(getAutotileKind(TILE_ID_A2)).max(getAutotileKind(TILE_ID_A3) - 1)
        .optional()
        .describe(
          'A2 material that counts as floor — the same floorKind generate_map_layout was given. ' +
          'Strongly worth passing: without it floor and wall are told apart by the tileset\'s ' +
          'passage flags, and in the RTP tilesets an A4 wall *top* is walkable, so most of a ' +
          'dungeon reads as floor and the decoration lands outside it.'
        ),
      torchCount: z.number().int().min(0).default(12)
        .describe('Torches to place on wall faces — solid tiles with floor below them'),
      torchSpacing: z.number().int().min(1).max(20).default(4)
        .describe('Smallest gap between two torches, so they read as a line rather than a smear'),
      torchSprite: z.string().default('!Flame').describe('Character sheet for the torch'),
      torchSpriteIndex: z.number().int().min(0).max(7).default(0),
      treasureCount: z.number().int().min(0).default(3)
        .describe(
          'Chests to place. They only ever go in dead ends: a chest blocks its tile, and a dead ' +
          'end is the one place where blocking cannot cut anything off.'
        ),
      treasureSprite: z.string().default('!Chest').describe('Character sheet for the chest'),
      treasureSpriteIndex: z.number().int().min(0).max(7).default(0),
      itemId: z.number().int().positive().default(1)
        .describe('Item each chest hands over. The message names it from the database.'),
      itemAmount: z.number().int().positive().default(1).describe('How many'),
      floorProps: z.array(z.string()).optional()
        .describe(`Scatter props for the floor. Defaults to ${DEFAULT_FLOOR_PROPS.join(', ')}.`),
      wallProps: z.array(z.string()).optional()
        .describe(`Props for wall faces. Defaults to ${DEFAULT_WALL_PROPS.join(', ')}.`),
      floorPropDensity: z.number().min(0).max(1).default(0.04)
        .describe('Fraction of floor tiles that get a prop'),
      wallPropDensity: z.number().min(0).max(1).default(0.08)
        .describe('Fraction of wall faces that get a prop'),
      propLayer: z.number().int().min(1).max(TILE_LAYERS - 1).default(1)
        .describe('Layer for props. Never 0 — object tiles are cut out around their edges.'),
    },
    async (args) => {
      try {
        const { mapId, seed, propLayer } = args;

        const project = requireProject();
        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return errorResult(`Map ID ${mapId} not found.`);
        }
        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;
        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);

        // Two ways to tell floor from wall. The material is exact but needs the
        // caller to know it; passability works on any map but is wrong wherever
        // a walkable wall top exists, which in the RTP tilesets is everywhere.
        const total = mapData.width * mapData.height;
        let floor: boolean[][];
        let basis: string;
        if (args.floorKind !== undefined) {
          const ground = readLayer(mapData, 0);
          floor = ground.map((row) =>
            row.map((t) => isAutotile(t) && getAutotileKind(t) === args.floorKind)
          );
          basis = `A2 kind ${args.floorKind}`;
        } else {
          floor = standableGrid(mapData, tileset.flags);
          basis = 'the tileset passage flags';
        }
        const floorTiles = floor.flat().filter(Boolean).length;

        if (floorTiles === total) {
          return errorResult(
            `Every tile on map ${mapId} is walkable, so there are no walls to put torches on and ` +
            'no dead ends to hide treasure in. Either the map has no solid material painted, or ' +
            "the tileset's passage flags were never configured — check_project reports that as " +
            'tileset-passage-unconfigured.'
          );
        }
        if (floorTiles === 0) {
          return errorResult(
            args.floorKind === undefined
              ? `No walkable tile on map ${mapId}: there is nothing to decorate.`
              : `No tile on map ${mapId} uses A2 kind ${args.floorKind}, so there is no floor to ` +
                'decorate. Pass the same floorKind the map was generated with.'
          );
        }

        const notes: string[] = [];
        if (args.floorKind === undefined && floorTiles / total > 0.9) {
          notes.push(
            `${Math.round((floorTiles / total) * 100)}% of this map reads as walkable, which almost ` +
            'certainly means its walls are A4 wall tops — those are passable in the RTP tilesets, ' +
            'so the dead ends and wall faces found here are the map border rather than the ' +
            'dungeon. Pass floorKind to tell floor from wall by material instead.'
          );
        }

        const plan = planDressing(floor, {
          seed,
          torchCount: args.torchCount,
          treasureCount: args.treasureCount,
          floorPropDensity: args.floorPropDensity,
          wallPropDensity: args.wallPropDensity,
          torchSpacing: args.torchSpacing,
          blocked: mapData.events
            .filter((e): e is Event => e !== null)
            .map((e) => ({ x: e.x, y: e.y })),
        });

        // --- events ---
        for (const slot of plan.torches) {
          addEvent(mapData, (id) =>
            torchEvent(id, slot.x, slot.y, {
              characterName: args.torchSprite,
              characterIndex: args.torchSpriteIndex,
            })
          );
        }

        // Name the item from the database, so the message says what it is.
        let itemName = 'something';
        try {
          const items = (await FileHandler.readJsonRaw(
            path.join(project.dataPath, 'Items.json')
          )) as ({ id: number; name: string } | null)[];
          itemName = items[args.itemId]?.name || itemName;
        } catch {
          // no Items.json is the caller's problem to notice, not a reason to fail
        }

        for (const slot of plan.treasure) {
          addEvent(mapData, (id) =>
            treasureEvent(id, slot.x, slot.y, {
              characterName: args.treasureSprite,
              characterIndex: args.treasureSpriteIndex,
              itemId: args.itemId,
              amount: args.itemAmount,
              text: `You found \\c[6]${itemName}\\c[0] x${args.itemAmount}!`,
            })
          );
        }

        // --- props ---
        const catalogue = collectProps(tileset.tilesetNames);
        const floorSet = resolveProps(catalogue, args.floorProps ?? DEFAULT_FLOOR_PROPS);
        const wallSet = resolveProps(catalogue, args.wallProps ?? DEFAULT_WALL_PROPS);

        const placements: Placement[] = [];
        const scatter = (slots: { x: number; y: number }[], props: Prop[]) => {
          if (props.length === 0) return 0;
          slots.forEach((slot, i) => {
            for (const cell of propCells(props[i % props.length])) {
              placements.push({ x: slot.x + cell.dx, y: slot.y + cell.dy, tileId: cell.tileId });
            }
          });
          return slots.length;
        };
        const floorPlaced = scatter(plan.floorProps, floorSet.props);
        const wallPlaced = scatter(plan.wallProps, wallSet.props);

        if (placements.length > 0) {
          const result = applyPlacements(readLayer(mapData, propLayer), placements, {
            skipOccupied: true,
            computeShapes: false,
          });
          writeLayer(mapData, propLayer, result.grid);
        }

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(
          `Decorated map ${mapId}: ${plan.torches.length} torches, ${plan.treasure.length} chests`
        );

        const missing = [...new Set([...floorSet.missing, ...wallSet.missing])];
        const lines = [
          `Decorated map ${mapId}: ${floorTiles} floor of ${total} tiles, by ${basis}. Seed ${seed}.`,
          '',
          `Torches: ${plan.torches.length} of ${args.torchCount} on wall faces.`,
          `Treasure: ${plan.treasure.length} of ${args.treasureCount} chest(s), ` +
            `each giving ${args.itemAmount}x "${itemName}". ${plan.deadEnds} dead end(s) available.`,
          `Props: ${floorPlaced} on the floor, ${wallPlaced} on wall faces, layer ${propLayer}.`,
        ];

        if (plan.treasure.length < args.treasureCount) {
          lines.push(
            '',
            `Only ${plan.deadEnds} dead end(s) exist, so ${args.treasureCount - plan.treasure.length} ` +
            'chest(s) were not placed. A chest blocks its tile, and a dead end is the one place ' +
            'where that cannot cut anything off — the rest were left out rather than dropped ' +
            'somewhere they might seal a corridor. generate_map_layout cuts dead ends into a ' +
            'dungeon; raise deadEndAttempts for more.'
          );
        }
        if (plan.torches.length < args.torchCount) {
          lines.push(
            '',
            `Only ${plan.torches.length} wall face(s) were far enough apart at spacing ` +
            `${args.torchSpacing}. Lower it for more torches.`
          );
        }
        if (missing.length > 0) {
          lines.push('', `Not in "${tileset.name}", so skipped: ${missing.join(', ')}.`);
        }
        if (itemName === 'something') {
          lines.push(
            '',
            `Item ${args.itemId} has no name in the database, so the chests say "something". ` +
            'Give itemId an item that exists.'
          );
        }
        lines.push(...notes.map((n) => `
Note: ${n}`));
        lines.push(
          '',
          'Torches stand on wall tiles on purpose — 623 of the 635 in the shipped maps do. ' +
          'check_map_walkability reports each of them as event-on-wall, which is expected here ' +
          'rather than a fault.'
        );

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
