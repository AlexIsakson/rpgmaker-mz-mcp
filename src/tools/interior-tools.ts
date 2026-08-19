import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { readLayer, writeLayer, TILE_LAYERS } from '../core/map-layers.js';
import {
  refreshAutotileShapes,
  makeAutotileId,
  getAutotileKind,
  TILE_ID_A2,
  TILE_ID_A3,
  TILE_ID_A4,
  TILE_ID_MAX,
  isTileA4WallTop,
} from '../core/autotile.js';
import { refreshWallShapes } from '../core/wall-autotile.js';
import { applyPlacements, type Placement } from '../core/tile-batch.js';
import { TilesetReader } from '../core/tileset-reader.js';
import {
  planInterior,
  renderInteriorAscii,
  exitEvent,
  InteriorError,
  VOID_TILE,
  type Cell,
  type InteriorPlan,
} from '../core/interiorgen.js';
import { isDoorEvent, setDoorDestination } from '../core/blueprint.js';
import { checkGroundKinds } from '../core/ground-material.js';
import { checkSheetsPresent } from '../core/tileset-sheets.js';
import { clearMap } from '../core/map-reset.js';
import { loadA2Materials } from '../core/tileset-image.js';
import { addEvent } from '../core/building-placement.js';
import { collectProps, findProps, propCells, type Prop } from '../core/props.js';
import { requireProject } from './project-tools.js';
import { mapFilename, createMapFile } from './map-tools.js';
import type { MapData } from '../schemas/map.js';
import type { Event } from '../schemas/event.js';
import { logger } from '../logger.js';

const A2_KIND_MIN = getAutotileKind(TILE_ID_A2);
const A2_KIND_MAX = getAutotileKind(TILE_ID_A3) - 1;
const A4_KIND_MIN = getAutotileKind(TILE_ID_A4);
const A4_KIND_MAX = getAutotileKind(TILE_ID_MAX) - 1;

/**
 * Defaults tuned for the RTP Inside sheets. Anything the tileset does not have
 * is skipped and reported rather than failing the run.
 */
const DEFAULT_FURNITURE = [
  'Bookshelf A', 'Cabinet', 'Chest of Drawers', 'Closet', 'Dish Cabinet',
  'Chest A', 'Pot A', 'Bed',
];

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

interface InteriorStyle {
  floorKind: number;
  wallTopKind: number;
  wallFaceKind: number;
  furniture: string[];
  furnitureCount: number;
  propLayer: number;
}

/** Paint a planned room onto a map's ground layer and shape it. */
function paintInterior(mapData: MapData, plan: InteriorPlan, style: InteriorStyle): void {
  const tileFor: Record<Cell, number> = {
    void: VOID_TILE,
    wallTop: makeAutotileId(style.wallTopKind, 0),
    wallFace: makeAutotileId(style.wallFaceKind, 0),
    floor: makeAutotileId(style.floorKind, 0),
  };

  const grid: number[][] = plan.cells.map((row) => row.map((cell) => tileFor[cell]));

  // Wall tops and the floor are drawn with FLOOR_AUTOTILE_TABLE, wall faces with
  // WALL_AUTOTILE_TABLE; running both passes shapes each family with its own
  // table and leaves the other alone.
  writeLayer(mapData, 0, refreshWallShapes(refreshAutotileShapes(grid)));
}

/** Furnish a room, leaving the doorway column clear. */
function furnish(
  mapData: MapData,
  plan: InteriorPlan,
  style: InteriorStyle,
  catalogue: Prop[]
): { placed: number; missing: string[] } {
  const missing: string[] = [];
  const chosen: Prop[] = [];
  for (const name of style.furniture) {
    const found = findProps(catalogue, name);
    // Only props that fit a single tile are scattered: a taller one placed on a
    // slot against the wall would run into the wall itself.
    const single = found.find((p) => p.width === 1 && p.height === 1);
    if (single) chosen.push(single);
    else missing.push(name);
  }
  if (chosen.length === 0) return { placed: 0, missing };

  const placements: Placement[] = [];
  const count = Math.min(style.furnitureCount, plan.furnitureSlots.length);
  for (let i = 0; i < count; i++) {
    const slot = plan.furnitureSlots[i];
    const prop = chosen[i % chosen.length];
    for (const cell of propCells(prop)) {
      placements.push({ x: slot.x + cell.dx, y: slot.y + cell.dy, tileId: cell.tileId });
    }
  }

  const result = applyPlacements(readLayer(mapData, style.propLayer), placements, {
    skipOccupied: true,
    computeShapes: false,
  });
  writeLayer(mapData, style.propLayer, result.grid);
  return { placed: count, missing };
}

/** Build one interior into an existing map and return where its exit went. */
function buildInterior(
  mapData: MapData,
  plan: InteriorPlan,
  style: InteriorStyle,
  catalogue: Prop[],
  exitTarget: { mapId: number; x: number; y: number } | null
): { furniturePlaced: number; missing: string[]; exitEventId: number | null } {
  paintInterior(mapData, plan, style);
  const { placed, missing } = furnish(mapData, plan, style, catalogue);

  let exitEventId: number | null = null;
  if (exitTarget) {
    const placedEvent = addEvent(mapData, (id) =>
      exitEvent(id, plan.exit.x, plan.exit.y, exitTarget)
    );
    exitEventId = placedEvent.id;
  }

  return { furniturePlaced: placed, missing, exitEventId };
}

function styleSchema() {
  return {
    floorKind: z.number().int().min(A2_KIND_MIN).max(A2_KIND_MAX).default(32)
      .describe(
        'A2 material for the floor. Goes on layer 0 across the whole room, so it wants an ' +
        'opaque ground material; an overlay would show the map background as black through ' +
        'its edges. describe_tileset_materials says which kinds are ground for this tileset — ' +
        'it is not predictable from the sheet column.'
      ),
    wallTopKind: z.number().int().min(A4_KIND_MIN).max(A4_KIND_MAX).default(98)
      .describe(
        'A4 material for the wall. Must be a wall *top* — an even block row of the A4 sheet ' +
        '(80-87, 96-103, 112-119). The face beneath it defaults to this kind plus 8.'
      ),
    wallFaceKind: z.number().int().min(A4_KIND_MIN).max(A4_KIND_MAX).optional()
      .describe('A4 wall face. Defaults to wallTopKind + 8, the pairing the sample maps use.'),
    furniture: z.array(z.string()).optional()
      .describe(`Prop names to place against the walls. Defaults to ${DEFAULT_FURNITURE.join(', ')}.`),
    furnitureCount: z.number().int().min(0).default(4)
      .describe('How many furniture props to place per room'),
    propLayer: z.number().int().min(1).max(TILE_LAYERS - 1).default(1)
      .describe('Layer for furniture'),
  };
}

function resolveStyle(args: {
  floorKind: number; wallTopKind: number; wallFaceKind?: number;
  furniture?: string[]; furnitureCount: number; propLayer: number;
}): InteriorStyle | string {
  if (!isTileA4WallTop(makeAutotileId(args.wallTopKind, 0))) {
    return (
      `A4 kind ${args.wallTopKind} is a wall *face*, not a wall top. The A4 sheet alternates ` +
      'top row / face row, so wall tops are 80-87, 96-103 and 112-119. The room is ringed with ' +
      'the top and the face is drawn beneath it.'
    );
  }
  return {
    floorKind: args.floorKind,
    wallTopKind: args.wallTopKind,
    wallFaceKind: args.wallFaceKind ?? args.wallTopKind + 8,
    furniture: args.furniture ?? DEFAULT_FURNITURE,
    furnitureCount: args.furnitureCount,
    propLayer: args.propLayer,
  };
}

export function registerInteriorTools(server: McpServer): void {
  server.tool(
    'generate_interior',
    'Fill a map with a room: floor, walls, furniture and a way out. The map is ' +
      'overwritten. Give linkFromMapId and linkFromEventId to wire it to a door ' +
      'on another map — the door is pointed at the room\'s doorway and the room\'s ' +
      'exit back at the tile in front of that door, so both directions work.',
    {
      mapId: z.number().int().positive().describe('Map to fill — its contents are replaced'),
      floorWidth: z.number().int().min(3).default(7).describe('Walkable floor width'),
      floorHeight: z.number().int().min(2).default(5).describe('Walkable floor height'),
      margin: z.number().int().min(0).default(1).describe('Void border around the room'),
      doorOffsetX: z.number().int().min(0).optional()
        .describe('Doorway column across the floor. Defaults to the middle.'),
      seed: z.number().int().default(1).describe('Seed for furniture placement'),
      linkFromMapId: z.number().int().positive().optional()
        .describe('Map holding the door that should lead here'),
      linkFromEventId: z.number().int().positive().optional()
        .describe('The door event on that map'),
      allowOverlayOnGround: z.boolean().default(false)
        .describe(
          'Lay an overlay A2 material as the floor anyway. Refused by default because its ' +
          'transparent edges render as black across the whole room.'
        ),
      ...styleSchema(),
    },
    async (args) => {
      try {
        const { mapId, linkFromMapId, linkFromEventId } = args;
        const style = resolveStyle(args);
        if (typeof style === 'string') return errorResult(style);

        if ((linkFromMapId === undefined) !== (linkFromEventId === undefined)) {
          return errorResult('Give both linkFromMapId and linkFromEventId, or neither.');
        }

        const project = requireProject();
        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return errorResult(`Map ID ${mapId} not found.`);
        }
        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;

        let plan: InteriorPlan;
        try {
          plan = planInterior({
            floorWidth: args.floorWidth,
            floorHeight: args.floorHeight,
            margin: args.margin,
            doorOffsetX: args.doorOffsetX ?? null,
            seed: args.seed,
          });
        } catch (error) {
          if (error instanceof InteriorError) return errorResult(error.message);
          throw error;
        }

        if (plan.width > mapData.width || plan.height > mapData.height) {
          return errorResult(
            `The room needs a ${plan.width}x${plan.height} map but map ${mapId} is ` +
            `${mapData.width}x${mapData.height}. A room is the floor plus a wall each side and ` +
            'three rows of front wall below it — resize the map, or use a smaller floor.'
          );
        }

        // --- wire the door, if one was named ---
        let outward: { mapId: number; x: number; y: number } | null = null;
        let doorMapPath = '';
        let doorMap: MapData | null = null;
        if (linkFromMapId !== undefined) {
          doorMapPath = path.join(project.dataPath, mapFilename(linkFromMapId));
          if (!(await FileHandler.exists(doorMapPath))) {
            return errorResult(`Map ID ${linkFromMapId} not found.`);
          }
          doorMap = (await FileHandler.readJsonRaw(doorMapPath)) as MapData;
          const door = doorMap.events[linkFromEventId!] as Event | null | undefined;
          if (!door) {
            return errorResult(`Event ${linkFromEventId} not found on map ${linkFromMapId}.`);
          }
          if (!isDoorEvent(door)) {
            return errorResult(
              `Event ${linkFromEventId} on map ${linkFromMapId} ("${door.name}") is not a door — ` +
              'no page carries a !Door sprite. Link an actual door, or make one with place_building.'
            );
          }
          setDoorDestination(door.pages[0], {
            mapId,
            x: plan.arrival.x,
            y: plan.arrival.y,
          });
          // The player leaves onto the tile they entered from: in front of the door.
          outward = { mapId: linkFromMapId, x: door.x, y: door.y + 1 };
        }

        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);
        const catalogue = collectProps(tileset.tilesetNames);

        // A tileset slot is allowed to be empty. The walls are A4 and the floor
        // A2; `Overworld` has no A4 at all, so an interior generated on it would
        // be a floor with no walls around it and no refusal to say why.
        const sheetRefusal = checkSheetsPresent(
          [
            { kind: style.floorKind, label: 'floorKind' },
            { kind: style.wallTopKind, label: 'wallTopKind' },
            { kind: style.wallFaceKind, label: 'wallFaceKind' },
          ],
          tileset.tilesetNames,
          tileset.name
        );
        if (sheetRefusal !== null) return errorResult(sheetRefusal);

        // The floor goes on layer 0 across the whole room, with nothing under
        // it. An overlay material here is a black room. Checked before the map
        // is wiped, so a refusal leaves the map as it was.
        const groundCheck = checkGroundKinds(
          [{ kind: style.floorKind, label: 'floorKind', layer: 0, coversMap: true }],
          await loadA2Materials(project.path, tileset.tilesetNames),
          tileset.name,
          { allowOverlayOnGround: args.allowOverlayOnGround, reportUncheckable: true }
        );
        if (groundCheck.refusal !== null) return errorResult(groundCheck.refusal);

        // A fresh room, not a room layered over whatever was there. This tool
        // got it right from the start; it goes through the shared clear so that
        // all three generators mean the same thing by it — see
        // src/core/map-reset.ts.
        clearMap(mapData, { events: true });

        const result = buildInterior(mapData, plan, style, catalogue, outward);

        await FileHandler.writeJson(mapPath, mapData);
        if (doorMap) await FileHandler.writeJson(doorMapPath, doorMap);
        await project.getVersionSync().bump();

        logger.info(`Generated interior on map ${mapId} (${plan.width}x${plan.height})`);

        const lines = [
          `Filled map ${mapId} with a ${args.floorWidth}x${args.floorHeight} room ` +
          `(${plan.width}x${plan.height} of map used).`,
          `Walls: A4 top kind ${style.wallTopKind} over face kind ${style.wallFaceKind}. ` +
          `Floor: A2 kind ${style.floorKind}.`,
          `Furniture: ${result.furniturePlaced} prop(s) against the walls, doorway left clear.`,
        ];
        if (outward) {
          lines.push(
            `Linked: door ${linkFromEventId} on map ${linkFromMapId} now leads to ` +
            `(${plan.arrival.x}, ${plan.arrival.y}) here, and exit event ${result.exitEventId} at ` +
            `(${plan.exit.x}, ${plan.exit.y}) leads back to (${outward.x}, ${outward.y}) there.`
          );
        } else {
          lines.push(
            'No exit event: nothing was linked, so the room has no way out. Pass ' +
            'linkFromMapId and linkFromEventId to wire it to a door.'
          );
        }
        if (result.missing.length > 0) {
          lines.push(`Not in this tileset, so skipped: ${result.missing.join(', ')}.`);
        }
        lines.push(...groundCheck.notes);
        lines.push(
          '',
          renderInteriorAscii(plan),
          '',
          '# wall top  % wall face  . floor  E exit',
          '',
          `Audit it with check_map_walkability mapId=${mapId} startX=${plan.arrival.x} ` +
          `startY=${plan.arrival.y}. The start matters here: a room's wall tops are passable ` +
          'along themselves, so without it the ring around the room is mistaken for the ' +
          'reachable area and the room is reported as cut off.'
        );

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'generate_interiors',
    'Give every door on a map somewhere to go: make a room for each one, and ' +
      'wire both directions. This is what turns a generated town from something ' +
      'to look at into something to walk around in.',
    {
      mapId: z.number().int().positive().describe('Map whose doors should be furnished with rooms'),
      tilesetId: z.number().int().positive()
        .describe('Tileset for the new interior maps — an indoor one, not the town\'s'),
      floorWidth: z.number().int().min(3).default(7).describe('Walkable floor width'),
      floorHeight: z.number().int().min(2).default(5).describe('Walkable floor height'),
      margin: z.number().int().min(0).default(1).describe('Void border around each room'),
      seed: z.number().int().default(1).describe('Seed for furniture placement'),
      namePrefix: z.string().default('Interior').describe('Name given to the new maps'),
      relink: z.boolean().default(false)
        .describe('Also rebuild doors that already lead somewhere. Off by default, so hand-made links survive.'),
      ...styleSchema(),
    },
    async (args) => {
      try {
        const { mapId, tilesetId } = args;
        const style = resolveStyle(args);
        if (typeof style === 'string') return errorResult(style);

        const project = requireProject();
        const townPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(townPath))) {
          return errorResult(`Map ID ${mapId} not found.`);
        }
        const townMap = (await FileHandler.readJsonRaw(townPath)) as MapData;

        const doors = townMap.events
          .map((e, id) => ({ event: e as Event | null, id }))
          .filter((d): d is { event: Event; id: number } => d.event !== null && isDoorEvent(d.event));

        if (doors.length === 0) {
          return errorResult(
            `Map ${mapId} has no door events — no page on it carries a !Door sprite. ` +
            'place_building and generate_town emit them; a door drawn as a tile is not one.'
          );
        }

        let plan: InteriorPlan;
        try {
          plan = planInterior({
            floorWidth: args.floorWidth,
            floorHeight: args.floorHeight,
            margin: args.margin,
            doorOffsetX: null,
            seed: args.seed,
          });
        } catch (error) {
          if (error instanceof InteriorError) return errorResult(error.message);
          throw error;
        }

        const tileset = await TilesetReader.get(project.dataPath, tilesetId);
        const catalogue = collectProps(tileset.tilesetNames);

        const made: string[] = [];
        const skipped: string[] = [];
        const missing = new Set<string>();

        for (const door of doors) {
          const page = door.event.pages[0];
          const alreadyLinked = page.list.some((c) => c.code === 201);
          if (alreadyLinked && !args.relink) {
            skipped.push(`event ${door.id} at (${door.event.x}, ${door.event.y})`);
            continue;
          }

          const interiorId = await createMapFile(project.dataPath, {
            name: `${args.namePrefix} ${made.length + 1}`,
            width: plan.width,
            height: plan.height,
            tilesetId,
            parentId: mapId,
          });

          const interiorPath = path.join(project.dataPath, mapFilename(interiorId));
          const interiorMap = (await FileHandler.readJsonRaw(interiorPath)) as MapData;

          // Vary the furniture per room, so a street of houses is not one room
          // repeated. The layout stays the same; only what stands in it changes.
          const roomPlan = planInterior({
            floorWidth: args.floorWidth,
            floorHeight: args.floorHeight,
            margin: args.margin,
            doorOffsetX: null,
            seed: args.seed + door.id,
          });

          const result = buildInterior(interiorMap, roomPlan, style, catalogue, {
            mapId,
            x: door.event.x,
            y: door.event.y + 1,
          });
          for (const name of result.missing) missing.add(name);

          setDoorDestination(page, {
            mapId: interiorId,
            x: roomPlan.arrival.x,
            y: roomPlan.arrival.y,
          });

          await FileHandler.writeJson(interiorPath, interiorMap);
          made.push(
            `door ${door.id} at (${door.event.x}, ${door.event.y}) -> map ${interiorId}`
          );
        }

        await FileHandler.writeJson(townPath, townMap);
        await project.getVersionSync().bump();

        logger.info(`Generated ${made.length} interiors for map ${mapId}`);

        const lines = [
          `Map ${mapId}: ${doors.length} door(s) found, ${made.length} interior(s) made.`,
          '',
          ...made.map((m) => `  ${m}`),
        ];
        if (skipped.length > 0) {
          lines.push(
            '',
            `${skipped.length} door(s) already led somewhere and were left alone ` +
            '(pass relink to rebuild them):',
            ...skipped.slice(0, 8).map((s) => `  ${s}`)
          );
        }
        if (missing.size > 0) {
          lines.push('', `Furniture not in tileset ${tilesetId}, so skipped: ${[...missing].join(', ')}.`);
        }
        lines.push(
          '',
          `Each room is ${plan.width}x${plan.height}, entered at (${plan.arrival.x}, ${plan.arrival.y}) ` +
          'and left by walking back down through the doorway. Run check_project to confirm no ' +
          'transfer points at a missing map, and get_map_graph to see the town and its rooms as ' +
          'one world. To audit a room, pass that arrival tile to check_map_walkability as ' +
          'startX/startY — without it the wall tops around the room are mistaken for the ' +
          'reachable area.'
        );

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
