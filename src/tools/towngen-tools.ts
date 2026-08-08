import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { readLayer, writeLayer, TILE_LAYERS } from '../core/map-layers.js';
import { fillRect, makeAutotileId, getAutotileKind, TILE_ID_A2, TILE_ID_A3 } from '../core/autotile.js';
import { applyPlacements, type Placement } from '../core/tile-batch.js';
import { applyWallShadows } from '../core/shadows.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { loadA2Materials } from '../core/tileset-image.js';
import { placeBuildingOnMap, BuildingPlacementError } from '../core/building-placement.js';
import { planTown, renderTownAscii, TownError, TOWN_DEFAULTS } from '../core/towngen.js';
import { ROOF_SET_NAMES, A3_KIND_MIN, A4_KIND_MAX } from '../core/blueprint.js';
import { collectProps, findProps, propCells, propPart, PropError, type Prop } from '../core/props.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';
import { logger } from '../logger.js';

const A2_KIND_MIN = getAutotileKind(TILE_ID_A2);
const A2_KIND_MAX = getAutotileKind(TILE_ID_A3) - 1;

/**
 * Defaults tuned for the RTP outdoor tilesets. Any name that does not resolve
 * against the map's own tileset is skipped and reported rather than failing the
 * run, so a different tileset degrades to fewer props instead of no town.
 */
const DEFAULT_DECOR = ['Barrel', 'Crate A', 'Pot', 'Firewood', 'Flowers A', 'Flowers B', 'Bush', 'Stump'];
const DEFAULT_FRAME = 'Tree';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/**
 * Resolve a prop name to something the given footprint can hold, narrowing to
 * the top-left corner when the name bundles filler variants — the `Tree` case,
 * where stamping the whole group leaves a canopy square beside the trunk.
 */
function resolveFramingProp(props: Prop[], name: string, height: number): Prop | null {
  const found = findProps(props, name);
  if (found.length === 0) return null;
  const prop = found[0];
  try {
    return propPart(prop, {
      x: 0,
      y: 0,
      width: 1,
      height: Math.min(height, prop.height),
    });
  } catch (error) {
    if (error instanceof PropError) return null;
    throw error;
  }
}

export function registerTowngenTools(server: McpServer): void {
  server.tool(
    'generate_town',
    'Generate a whole town onto a map: ground, streets, rows of buildings with ' +
      'working door events, a tree line framing the edge, and a decoration pass. ' +
      'Buildings sit in bands facing the street below them, because a door is on ' +
      'a building\'s bottom row and is entered from the tile beneath it. Streets ' +
      'run to the map edge so the town has ways in, and cross streets guarantee ' +
      'the network is connected. Same seed, same town. The map is replaced — its ' +
      'existing tiles and events both go.',
    {
      mapId: z.number().int().positive()
        .describe('Map ID. Its tiles and its events are both replaced.'),
      seed: z.number().int().default(1).describe('Layout seed; the same seed reproduces the town'),
      groundKind: z.number().int().min(A2_KIND_MIN).max(A2_KIND_MAX).default(A2_KIND_MIN)
        .describe(
          'A2 material for the ground. Wants a seamless fill, since it covers the whole map — ' +
          'describe_tileset_materials says which are which.'
        ),
      roadKind: z.number().int().min(A2_KIND_MIN).max(A2_KIND_MAX).optional()
        .describe(
          'A2 material for the streets. Wants an outlined material so the road reads as a road ' +
          'against the ground. Omit to leave the streets as bare ground.'
        ),
      roofSets: z.array(z.enum(ROOF_SET_NAMES as [string, ...string[]])).optional()
        .describe(
          `Nine-slice roof sets to vary the buildings with (${ROOF_SET_NAMES.join(', ')}). ` +
          'Only valid on a tileset whose C sheet is Outside_C. Defaults to all of them there; ' +
          'on any other tileset pass roofKinds instead.'
        ),
      roofKinds: z.array(z.number().int().min(A3_KIND_MIN).max(A4_KIND_MAX)).optional()
        .describe(
          'A3 roof materials to vary the buildings with, as an alternative to roofSets. Each ' +
          'brings its own wall (the kind 8 below it). A3 roofs are flat texture with no edge ' +
          'art, so they read as slabs.'
        ),
      wallKind: z.number().int().min(A3_KIND_MIN).max(A4_KIND_MAX).optional()
        .describe('Wall material for nine-slice-roofed buildings. Required with roofSets.'),
      border: z.number().int().min(0).default(TOWN_DEFAULTS.border)
        .describe('Tiles reserved around the map edge for the tree line'),
      roadWidth: z.number().int().min(1).max(4).default(TOWN_DEFAULTS.roadWidth)
        .describe('Street thickness in tiles'),
      bandHeight: z.number().int().min(4).default(TOWN_DEFAULTS.bandHeight)
        .describe('Height of a row of buildings plus the gap above it'),
      crossStreets: z.number().int().min(1).max(4).default(TOWN_DEFAULTS.crossStreets)
        .describe('Vertical streets. At least one, or the horizontal roads never meet.'),
      minBuildingWidth: z.number().int().min(2).default(TOWN_DEFAULTS.minBuildingWidth),
      maxBuildingWidth: z.number().int().min(2).default(TOWN_DEFAULTS.maxBuildingWidth),
      minBuildingHeight: z.number().int().min(3).default(TOWN_DEFAULTS.minBuildingHeight),
      maxBuildingHeight: z.number().int().min(3).default(TOWN_DEFAULTS.maxBuildingHeight),
      wallHeight: z.number().int().min(1).default(TOWN_DEFAULTS.wallHeight)
        .describe('Rows of wall at the bottom of each building; the rest is roof'),
      decorDensity: z.number().min(0).max(1).default(TOWN_DEFAULTS.decorDensity)
        .describe('Fraction of the free ground that gets a prop'),
      decorProps: z.array(z.string()).optional()
        .describe(
          `Prop names to scatter. Defaults to ${DEFAULT_DECOR.join(', ')} — names that do not ` +
          'exist in this tileset are skipped and reported.'
        ),
      frameProp: z.string().default(DEFAULT_FRAME)
        .describe(
          'Prop for the tree line around the edge. Its top-left column is used, so a name that ' +
          'bundles filler variants still gives a single tree. Empty string leaves the edge bare.'
        ),
      roofLayer: z.number().int().min(1).max(TILE_LAYERS - 1).default(2)
        .describe('Layer for nine-slice roofs'),
      propLayer: z.number().int().min(1).max(TILE_LAYERS - 1).default(1)
        .describe('Layer for props and the tree line'),
    },
    async (args) => {
      try {
        const { mapId, seed, groundKind, roadKind, roofSets, roofKinds, wallKind, roofLayer, propLayer } = args;

        const project = requireProject();
        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return errorResult(`Map ID ${mapId} not found.`);
        }
        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;
        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);
        const ctx = {
          projectPath: project.path,
          tilesetNames: tileset.tilesetNames,
          tilesetName: tileset.name,
        };

        // --- roofs ---
        if (roofSets && roofKinds) {
          return errorResult('Give roofSets or roofKinds, not both.');
        }
        let roofChoices: ({ roofSet: string } | { roofKind: number })[];
        if (roofKinds && roofKinds.length > 0) {
          roofChoices = roofKinds.map((kind) => ({ roofKind: kind }));
        } else if (roofSets && roofSets.length > 0) {
          roofChoices = roofSets.map((name) => ({ roofSet: name }));
        } else if (tileset.tilesetNames[6] === 'Outside_C') {
          roofChoices = ROOF_SET_NAMES.map((name) => ({ roofSet: name }));
        } else {
          return errorResult(
            `Tileset "${tileset.name}" uses "${tileset.tilesetNames[6] || '(none)'}" as its C ` +
            'sheet, so the built-in nine-slice roof sets do not apply to it. Pass roofKinds with ' +
            'A3 roof materials from this tileset, or use a tileset built on Outside_C.'
          );
        }
        const usingSets = 'roofSet' in roofChoices[0];
        if (usingSets && wallKind === undefined) {
          return errorResult(
            'wallKind is required with nine-slice roof sets: the C-sheet sets are roof art only ' +
            'and carry no wall to stand on. A3 wall kinds are 56-63 and 72-79.'
          );
        }

        // --- plan ---
        let plan;
        try {
          plan = planTown({
            width: mapData.width,
            height: mapData.height,
            seed,
            border: args.border,
            roadWidth: args.roadWidth,
            bandHeight: args.bandHeight,
            minBuildingWidth: args.minBuildingWidth,
            maxBuildingWidth: args.maxBuildingWidth,
            minBuildingHeight: args.minBuildingHeight,
            maxBuildingHeight: args.maxBuildingHeight,
            wallHeight: args.wallHeight,
            crossStreets: args.crossStreets,
            decorDensity: args.decorDensity,
            framePropHeight: TOWN_DEFAULTS.framePropHeight,
          });
        } catch (error) {
          if (error instanceof TownError) return errorResult(error.message);
          throw error;
        }

        const notes = [...plan.warnings];

        // Every tile is about to be rewritten, so the events have to go too.
        // Leaving them behind stacks a fresh set of door events on top of the
        // last run's — thirteen buildings, thirty-six doors, and every door but
        // the newest pointing at a building that is no longer there.
        const clearedEvents = mapData.events.filter((e) => e !== null).length;
        mapData.events = [null];

        // --- ground and streets ---
        let ground = readLayer(mapData, 0);
        ground = fillRect(
          ground,
          { x: 0, y: 0, width: mapData.width, height: mapData.height },
          makeAutotileId(groundKind, 0),
          { region: { x: 0, y: 0, width: mapData.width, height: mapData.height } }
        );
        if (roadKind !== undefined) {
          for (const road of plan.roads) ground = fillRect(ground, road, makeAutotileId(roadKind, 0));
        }
        writeLayer(mapData, 0, ground);

        // Streets want a material with a visible outline or they do not read as
        // streets — the same advice fill_map_region gives, checked here because
        // nothing else will look at it.
        if (roadKind !== undefined) {
          const materials = await loadA2Materials(project.path, tileset.tilesetNames);
          const road = materials?.find((m) => m.kind === roadKind);
          if (road?.outline === 'seamless') {
            notes.push(
              `A2 kind ${roadKind} is a seamless fill, so the streets will have no visible edge ` +
              'against the ground and will not read as streets. An outlined material works better ' +
              '— describe_tileset_materials lists them.'
            );
          }
          if (road && road.opacity !== 'ground') {
            notes.push(
              `A2 kind ${roadKind} is an overlay material, so its edges are transparent and the ` +
              'streets will show the map background as black. Pick a ground material.'
            );
          }
        }

        // --- buildings ---
        let placed = 0;
        let doors = 0;
        const failures: string[] = [];
        for (const building of plan.buildings) {
          const choice = roofChoices[building.variant % roofChoices.length];
          try {
            const result = await placeBuildingOnMap(
              mapData,
              {
                x: building.rect.x,
                y: building.rect.y,
                width: building.rect.width,
                height: building.rect.height,
                wallHeight: building.wallHeight,
                wallKind: 'roofSet' in choice ? wallKind : undefined,
                roofSet: 'roofSet' in choice ? choice.roofSet : undefined,
                roofKind: 'roofKind' in choice ? choice.roofKind : undefined,
                roofLayer,
                door: true,
                doorOffsetX: building.doorOffsetX,
                doorSprite: '!Door1',
                doorSpriteIndex: 0,
                allowRoofOverEmptyGround: false,
              },
              ctx
            );
            placed++;
            if (result.doorEventId !== null) doors++;
          } catch (error) {
            if (error instanceof BuildingPlacementError) {
              failures.push(`(${building.rect.x}, ${building.rect.y}): ${error.message.split('\n')[0]}`);
            } else {
              throw error;
            }
          }
        }

        // --- props ---
        const catalogue = collectProps(tileset.tilesetNames);
        const missing: string[] = [];
        const placements: Placement[] = [];

        const decorNames = args.decorProps ?? DEFAULT_DECOR;
        const decorProps: Prop[] = [];
        for (const name of decorNames) {
          const found = findProps(catalogue, name);
          // Only single-tile props are scattered: anything bigger needs room the
          // slot list does not promise, and would land half on a wall.
          const single = found.find((p) => p.width === 1 && p.height === 1);
          if (single) decorProps.push(single);
          else missing.push(name);
        }

        if (decorProps.length > 0) {
          for (let i = 0; i < plan.decorSlots.length; i++) {
            const slot = plan.decorSlots[i];
            const prop = decorProps[i % decorProps.length];
            for (const cell of propCells(prop)) {
              placements.push({ x: slot.x + cell.dx, y: slot.y + cell.dy, tileId: cell.tileId });
            }
          }
        } else if (decorNames.length > 0) {
          notes.push(
            `None of the requested decoration props exist in "${tileset.name}", so nothing was ` +
            'scattered. Use list_tileset_props to see what it offers.'
          );
        }

        let framed = 0;
        if (args.frameProp) {
          const frame = resolveFramingProp(catalogue, args.frameProp, TOWN_DEFAULTS.framePropHeight);
          if (frame) {
            for (const slot of plan.frameSlots) {
              for (const cell of propCells(frame)) {
                placements.push({ x: slot.x + cell.dx, y: slot.y + cell.dy, tileId: cell.tileId });
              }
              framed++;
            }
          } else {
            notes.push(
              `No prop named "${args.frameProp}" in "${tileset.name}", so the map edge was left ` +
              'unframed.'
            );
          }
        }

        if (placements.length > 0) {
          const result = applyPlacements(readLayer(mapData, propLayer), placements, {
            skipOccupied: true,
            computeShapes: false,
          });
          writeLayer(mapData, propLayer, result.grid);
        }

        const shadows = applyWallShadows(mapData, { overwrite: false });

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(
          `Generated town on map ${mapId}: ${placed} buildings, ${plan.roads.length} streets, seed ${seed}`
        );

        const lines = [
          `Generated a town on map ${mapId} (${mapData.width}x${mapData.height}), seed ${seed}.`,
          '',
          `Streets: ${plan.roads.length} (${plan.bands.length} band(s) of buildings, ` +
            `${args.crossStreets} cross street(s)). They run to the map edge, so the town has ways in.`,
          `Buildings: ${placed} of ${plan.buildings.length} planned, ${doors} with door events. ` +
            'Every door faces the street below its building.',
          `Decoration: ${plan.decorSlots.length} prop(s) on free ground, ${framed} framing the edge.`,
          `Shadows: ${shadows.added} tile(s).`,
        ];
        if (clearedEvents > 0) {
          lines.push(`Cleared ${clearedEvents} event(s) that were already on the map.`);
        }

        if (failures.length > 0) {
          lines.push(
            '',
            `${failures.length} building(s) were refused:`,
            ...failures.slice(0, 5).map((f) => `  ${f}`)
          );
        }
        if (missing.length > 0) {
          lines.push(
            '',
            `Not in this tileset, so skipped: ${missing.join(', ')}. ` +
            '(Only 1x1 props are scattered; a name that resolves to a larger prop counts as missing.)'
          );
        }

        lines.push(
          '',
          'Layout:',
          '  # building  + door  = street  T tree line  o prop  . open ground',
          renderTownAscii(plan),
          '',
          ...notes.map((n) => `Note: ${n}`),
          '',
          'Run check_map_walkability to confirm every door is reachable and nothing is sealed off. ' +
          'Doors lead nowhere until you make interior maps and point them at one — the generator ' +
          'does not build interiors.'
        );

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
