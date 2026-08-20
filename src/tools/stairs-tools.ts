import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { readLayer, writeLayer, TILE_LAYERS, hasTileBelow } from '../core/map-layers.js';
import { applyPlacements, type Placement } from '../core/tile-batch.js';
import { standableGrid } from '../core/walkability.js';
import { getAutotileKind, isAutotile, TILE_ID_A2, TILE_ID_A3 } from '../core/autotile.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { addEvent } from '../core/building-placement.js';
import { collectProps, findProps, propCells, type Prop } from '../core/props.js';
import { planStairEnds, stairEvent, StairError, type Slot } from '../core/stairs.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';
import type { Event } from '../schemas/event.js';
import { logger } from '../logger.js';

/**
 * The RTP names for the two halves of a staircase. Every B sheet the editor
 * ships carries "Stairs A (Up)" and "Stairs A (Down)", so these resolve in any
 * default tileset; a project with its own art gets told what was missing rather
 * than a silent failure.
 */
export const DEFAULT_UP_TILE = 'Stairs A (Up)';
export const DEFAULT_DOWN_TILE = 'Stairs A (Down)';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/**
 * Maps loaded once and written once, keyed by id.
 *
 * A stair can link a map to itself, and a staircase touches each floor twice —
 * once as the way down from above and once as the way up from below. Loading
 * per side would mean the second write silently discarding the first.
 */
class MapSession {
  private readonly loaded = new Map<number, { data: MapData; flags: number[]; names: string[] }>();
  private readonly dirty = new Set<number>();

  constructor(private readonly dataPath: string) {}

  async get(mapId: number) {
    const cached = this.loaded.get(mapId);
    if (cached) return cached;

    const mapPath = path.join(this.dataPath, mapFilename(mapId));
    if (!(await FileHandler.exists(mapPath))) {
      throw new StairError(`Map ID ${mapId} not found.`);
    }
    const data = (await FileHandler.readJsonRaw(mapPath)) as MapData;
    const tileset = await TilesetReader.get(this.dataPath, data.tilesetId);
    const entry = { data, flags: tileset.flags, names: tileset.tilesetNames };
    this.loaded.set(mapId, entry);
    return entry;
  }

  touch(mapId: number): void {
    this.dirty.add(mapId);
  }

  async flush(): Promise<number[]> {
    const written: number[] = [];
    for (const mapId of [...this.dirty].sort((a, b) => a - b)) {
      const entry = this.loaded.get(mapId);
      if (!entry) continue;
      await FileHandler.writeJson(path.join(this.dataPath, mapFilename(mapId)), entry.data);
      written.push(mapId);
    }
    return written;
  }
}

/**
 * Resolve a stair tile by name against one map's tileset.
 *
 * Shared with `generate_interior`'s second-storey option, which paints the
 * same "Stairs A (Up/Down)" pair at the top and bottom of an interior
 * staircase and wants the exact-name-first preference this already has.
 */
export function resolveStairProp(names: string[], tileName: string): Prop | null {
  const matches = findProps(collectProps(names), tileName);
  // Prefer the narrowest match: "Stairs A (Up)" over a substring hit on
  // something larger, and a 1x1 stair over a 1x3 ladder when both match.
  return (
    matches.find((p) => p.name.toLowerCase() === tileName.trim().toLowerCase()) ??
    matches.sort((a, b) => a.width * a.height - b.width * b.height)[0] ??
    null
  );
}

interface SidePlan {
  mapId: number;
  x: number;
  y: number;
  tileName: string | null;
  layer: number;
  eventName: string;
}

interface SideResult {
  notes: string[];
  painted: number;
}

/**
 * Paint a stair tile and report what it did to the tile's passability.
 *
 * **A stair tile is not reliably something the player can stand on, and which
 * ones are varies per tileset.** Measured over the flags the editor ships:
 * `Dungeon` has every stair fully passable, but `Inside`'s "Stairs C (Up)" and
 * "Stairs D (Down)" and `SF Outside`'s "Stairs A (Up)" are `0x0f` — blocked from
 * all four directions. Painting one of those on an upper layer makes its own
 * tile impassable, and since passage resolves top-down and only a star tile
 * falls through, the floor underneath stops mattering. The result is a stair the
 * player can never touch: the "door that leads nowhere" failure again, one layer
 * down.
 *
 * So the check is made after painting rather than assumed, on the real map with
 * the real flags, and it is the same `standableGrid` the walkability audit uses.
 */
function paintStairTile(
  entry: { data: MapData; flags: number[]; names: string[] },
  side: SidePlan
): SideResult {
  const notes: string[] = [];
  const { data } = entry;

  if (side.tileName === null) return { notes, painted: 0 };

  const prop = resolveStairProp(entry.names, side.tileName);
  if (!prop) {
    notes.push(
      `Map ${side.mapId}: "${side.tileName}" is not in this map's tileset, so no tile was ` +
      'painted. The transfer event is still there and works — it is just invisible, which ' +
      'means nothing on screen tells the player a stair is here. Pass a tile name this ' +
      'tileset does have (list_tileset_props shows them).'
    );
    return { notes, painted: 0 };
  }

  const placements: Placement[] = propCells(prop).map((cell) => ({
    x: side.x + cell.dx,
    y: side.y + cell.dy,
    tileId: cell.tileId,
  }));

  // Object tiles are cut out around their edges, so an empty ground layer beneath
  // shows through as the map background — black in game.
  const bare = placements.filter((p) => !hasTileBelow(data, p.x, p.y, side.layer));
  if (bare.length > 0) {
    notes.push(
      `Map ${side.mapId}: nothing is painted beneath ${bare.length} of the stair's ` +
      `${placements.length} tile(s) on the layers below ${side.layer}. Stair art is cut out ` +
      'around its edges, so those cells will show the map background through them.'
    );
  }

  const result = applyPlacements(readLayer(data, side.layer), placements, {
    computeShapes: false,
  });
  writeLayer(data, side.layer, result.grid);

  if (result.outOfBounds.length > 0) {
    notes.push(
      `Map ${side.mapId}: ${result.outOfBounds.length} of the stair's tile(s) fell outside the ` +
      'map and were discarded.'
    );
  }
  if (result.overwritten > 0) {
    notes.push(
      `Map ${side.mapId}: the stair replaced ${result.overwritten} tile(s) already on ` +
      `layer ${side.layer}.`
    );
  }

  return { notes, painted: result.painted };
}

/** Whether the player can actually stand where a stair or a landing puts them. */
function checkStandable(
  entry: { data: MapData; flags: number[] },
  mapId: number,
  slot: Slot,
  what: string
): string[] {
  const { data, flags } = entry;
  if (slot.x < 0 || slot.y < 0 || slot.x >= data.width || slot.y >= data.height) {
    return [`Map ${mapId}: ${what} at ${slot.x},${slot.y} is outside the map (${data.width}x${data.height}).`];
  }
  const standable = standableGrid(data, flags);
  if (standable[slot.y][slot.x]) return [];
  return [
    `Map ${mapId}: the player cannot stand on ${what} at ${slot.x},${slot.y}, so this link is ` +
    'dead — a player-touch event never fires on a tile nobody can step onto. Either the stair ' +
    "tile itself is impassable in this tileset (Inside's \"Stairs C (Up)\" and SF Outside's " +
    '"Stairs A (Up)" are blocked from all four sides), or what is under it is a wall. ' +
    'check_map_walkability shows the whole picture.',
  ];
}

async function linkSides(
  session: MapSession,
  a: SidePlan,
  b: SidePlan,
  options: { bidirectional: boolean; aDirection: number; bDirection: number }
): Promise<{ notes: string[]; events: { mapId: number; id: number; x: number; y: number }[] }> {
  const entryA = await session.get(a.mapId);
  const entryB = await session.get(b.mapId);

  const notes: string[] = [];
  notes.push(...paintStairTile(entryA, a).notes);
  if (options.bidirectional) notes.push(...paintStairTile(entryB, b).notes);

  const events: { mapId: number; id: number; x: number; y: number }[] = [];

  const forward = addEvent(entryA.data, (id) =>
    stairEvent(id, a.x, a.y, { mapId: b.mapId, x: b.x, y: b.y, direction: options.aDirection }, a.eventName)
  );
  events.push({ mapId: a.mapId, id: forward.id, x: a.x, y: a.y });
  session.touch(a.mapId);

  if (options.bidirectional) {
    const back = addEvent(entryB.data, (id) =>
      stairEvent(id, b.x, b.y, { mapId: a.mapId, x: a.x, y: a.y, direction: options.bDirection }, b.eventName)
    );
    events.push({ mapId: b.mapId, id: back.id, x: b.x, y: b.y });
    session.touch(b.mapId);
  }

  // Both checks run after every paint on the map, so a stair and its landing on
  // the same map are judged against the finished tiles.
  notes.push(...checkStandable(entryA, a.mapId, a, 'the stair'));
  notes.push(...checkStandable(entryB, b.mapId, b, options.bidirectional ? 'the return stair' : 'the landing tile'));

  return { notes, events };
}

/**
 * The floor mask a dungeon's stair placement is chosen over.
 *
 * **Painted with the floor material is not the same as walkable**, which is why
 * the material test is intersected with the real passability rather than
 * trusted on its own. Anything on an upper layer decides the tile's passage
 * before the ground layer is ever consulted, and some scatter props are solid —
 * `Rubble` on `Dungeon_B` is `0x60f`, blocked from all four sides. A prop like
 * that dropped in a one-tile corridor cuts the tiles beyond it off.
 *
 * That is not a hypothetical: the ends this module picks are the extremes of the
 * layout, and the extreme of a dungeon sits at the end of the longest, thinnest
 * passage — the most fragile tile on the map and the likeliest one for a single
 * prop to seal. Running the two tools in the obvious order put a decorated
 * dungeon's entrance on a tile the player could not reach.
 */
function floorMask(
  entry: { data: MapData; flags: number[] },
  floorKind: number | undefined
): { floor: boolean[][]; basis: string; note: string | null } {
  if (floorKind !== undefined) {
    const ground = readLayer(entry.data, 0);
    const standable = standableGrid(entry.data, entry.flags);
    return {
      floor: ground.map((row, y) =>
        row.map((t, x) => isAutotile(t) && getAutotileKind(t) === floorKind && standable[y][x])
      ),
      basis: `A2 kind ${floorKind}, less anything an upper layer blocks`,
      note: null,
    };
  }

  const floor = standableGrid(entry.data, entry.flags);
  const open = floor.flat().filter(Boolean).length;
  const total = entry.data.width * entry.data.height;
  return {
    floor,
    basis: 'the tileset passage flags',
    note:
      open / total > 0.9
        ? `${Math.round((open / total) * 100)}% of this map reads as walkable, which almost ` +
          'certainly means its walls are A4 wall tops — those are passable in the RTP tilesets, ' +
          'so the two "ends" found here are opposite corners of the map border rather than of ' +
          'the dungeon. Pass floorKind to tell floor from wall by material instead.'
        : null,
  };
}

const eventSlots = (data: MapData): Slot[] =>
  data.events.filter((e): e is Event => e !== null).map((e) => ({ x: e.x, y: e.y }));

export function registerStairsTools(server: McpServer): void {
  server.tool(
    'place_stairs',
    'Join two maps with a stair, ladder or cave mouth: paints the tile on each ' +
      'side and writes the transfer events, by default in both directions. The ' +
      'event is the one all 157 stair pages in the shipped maps use — invisible, ' +
      'player touch, drawn below characters — so it never blocks the tile it is on.',
    {
      fromMapId: z.number().int().positive().describe('Map the stair is on'),
      fromX: z.number().int().min(0).describe('X of the stair'),
      fromY: z.number().int().min(0).describe('Y of the stair'),
      toMapId: z.number().int().positive().describe('Map it leads to. May be the same map.'),
      toX: z.number().int().min(0).describe('X the player lands on'),
      toY: z.number().int().min(0).describe('Y the player lands on'),
      fromTile: z.string().default(DEFAULT_DOWN_TILE)
        .describe(
          `Tile painted on the from side, by name — see list_tileset_props. ` +
          `Defaults to "${DEFAULT_DOWN_TILE}".`
        ),
      toTile: z.string().default(DEFAULT_UP_TILE)
        .describe(`Tile painted where the player lands. Defaults to "${DEFAULT_UP_TILE}".`),
      paintTiles: z.boolean().default(true)
        .describe('Off writes only the events, leaving whatever art is already there'),
      bidirectional: z.boolean().default(true)
        .describe(
          'Also write the return stair on the far side. Landing on it does not bounce the ' +
          'player back: player-touch events only fire after a walking step, and a transfer ' +
          'places the player with locate().'
        ),
      direction: z.number().int().min(0).max(8).default(0)
        .describe('Facing on arrival: 0 keeps the current one, or 2 down, 4 left, 6 right, 8 up'),
      returnDirection: z.number().int().min(0).max(8).default(0)
        .describe('Facing after taking the return stair'),
      layer: z.number().int().min(1).max(TILE_LAYERS - 1).default(1)
        .describe('Layer for the stair tile. Never 0 — object tiles are cut out around their edges.'),
    },
    async (args) => {
      try {
        const project = requireProject();
        const session = new MapSession(project.dataPath);

        const { notes, events } = await linkSides(
          session,
          {
            mapId: args.fromMapId, x: args.fromX, y: args.fromY,
            tileName: args.paintTiles ? args.fromTile : null,
            layer: args.layer, eventName: 'StairsDown',
          },
          {
            mapId: args.toMapId, x: args.toX, y: args.toY,
            tileName: args.paintTiles ? args.toTile : null,
            layer: args.layer, eventName: 'StairsUp',
          },
          {
            bidirectional: args.bidirectional,
            aDirection: args.direction,
            bDirection: args.returnDirection,
          }
        );

        const written = await session.flush();
        await project.getVersionSync().bump();

        logger.info(
          `Linked map ${args.fromMapId} ${args.fromX},${args.fromY} -> ` +
          `${args.toMapId} ${args.toX},${args.toY}`
        );

        const lines = [
          `Map ${args.fromMapId} ${args.fromX},${args.fromY} -> map ${args.toMapId} ` +
          `${args.toX},${args.toY}` + (args.bidirectional ? ' and back.' : ' (one way).'),
          '',
          ...events.map((e) => `  event ${e.id} on map ${e.mapId} at ${e.x},${e.y}`),
          '',
          `Wrote map(s) ${written.join(', ')}.`,
          '',
          'Both tiles were checked to be ones the player can stand on, which is not the same as ' +
          'ones they can reach: an A4 wall top is passable in the RTP tilesets, so a stair put on ' +
          'one passes this check and is still walled off. check_map_walkability with startX/startY ' +
          'set to where the player arrives is what settles that.',
        ];
        if (notes.length > 0) lines.push('', ...notes.map((n) => `Note: ${n}`));

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        if (error instanceof StairError) return errorResult(error.message);
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'link_dungeon_floors',
    'Give generated dungeons a way in and a way down. Takes the floors in order, ' +
      'picks each one\'s two furthest-apart tiles for its stairs, and wires the ' +
      'staircase up — optionally back out to a map outside the dungeon. Without ' +
      'this a generated dungeon connects to nothing and is unreachable in game.',
    {
      mapIds: z.array(z.number().int().positive()).min(1)
        .describe('The dungeon floors in order, topmost first'),
      floorKind: z.number().int()
        .min(getAutotileKind(TILE_ID_A2)).max(getAutotileKind(TILE_ID_A3) - 1).optional()
        .describe(
          'A2 material that counts as floor — the same floorKind generate_map_layout was given. ' +
          'Strongly worth passing: without it floor and wall are told apart by the passage ' +
          'flags, and an A4 wall top is walkable in the RTP tilesets, so the ends found are the ' +
          'map border rather than the dungeon.'
        ),
      entranceMapId: z.number().int().positive().optional()
        .describe('Map outside the dungeon — a world or town map. Omit to leave the top floor unlinked.'),
      entranceX: z.number().int().min(0).optional().describe('X on that map the way out returns to'),
      entranceY: z.number().int().min(0).optional().describe('Y on that map the way out returns to'),
      entranceTile: z.string().optional()
        .describe(
          'Tile painted on the outside map, by name — a cave mouth or door, e.g. "Cave Entrance". ' +
          'Omitted paints nothing there and only writes the event.'
        ),
      upTile: z.string().default(DEFAULT_UP_TILE)
        .describe(`Tile for the way back up on each floor. Defaults to "${DEFAULT_UP_TILE}".`),
      downTile: z.string().default(DEFAULT_DOWN_TILE)
        .describe(`Tile for the way down on each floor. Defaults to "${DEFAULT_DOWN_TILE}".`),
      layer: z.number().int().min(1).max(TILE_LAYERS - 1).default(1)
        .describe('Layer for the stair tiles. Never 0 — object tiles are cut out around their edges.'),
    },
    async (args) => {
      try {
        const project = requireProject();
        const session = new MapSession(project.dataPath);
        const notes: string[] = [];

        const hasEntrance =
          args.entranceMapId !== undefined &&
          args.entranceX !== undefined &&
          args.entranceY !== undefined;
        if (args.entranceMapId !== undefined && !hasEntrance) {
          return errorResult(
            'entranceMapId needs entranceX and entranceY too — the way out has to land somewhere.'
          );
        }

        // --- choose both ends of every floor before writing anything ---
        const floors: { mapId: number; entrance: Slot; exit: Slot; distance: number; reachable: number; basis: string }[] = [];
        for (const mapId of args.mapIds) {
          const entry = await session.get(mapId);
          const { floor, basis, note } = floorMask(entry, args.floorKind);
          if (note) notes.push(`Map ${mapId}: ${note}`);

          const open = floor.flat().filter(Boolean).length;
          if (open === 0) {
            return errorResult(
              args.floorKind === undefined
                ? `No walkable tile on map ${mapId}: there is nowhere to put a stair.`
                : `No tile on map ${mapId} uses A2 kind ${args.floorKind}, so there is no floor to ` +
                  'put a stair on. Pass the same floorKind the map was generated with.'
            );
          }

          const ends = planStairEnds(floor, { blocked: eventSlots(entry.data) });
          floors.push({ mapId, ...ends, basis });

          if (ends.reachable < open) {
            notes.push(
              `Map ${mapId}: ${open - ends.reachable} floor tile(s) are cut off from the rest, so ` +
              'the stairs were placed within the largest area. generate_map_layout guarantees a ' +
              'connected layout, so this map has probably been painted over since.'
            );
          }
        }

        // --- wire the staircase ---
        const links: string[] = [];
        const allEvents: { mapId: number; id: number; x: number; y: number }[] = [];

        const connect = async (a: SidePlan, b: SidePlan, label: string) => {
          const { notes: n, events } = await linkSides(session, a, b, {
            bidirectional: true, aDirection: 0, bDirection: 0,
          });
          notes.push(...n);
          allEvents.push(...events);
          links.push(label);
        };

        if (hasEntrance) {
          const first = floors[0];
          await connect(
            {
              mapId: first.mapId, x: first.entrance.x, y: first.entrance.y,
              tileName: args.upTile, layer: args.layer, eventName: 'StairsOut',
            },
            {
              mapId: args.entranceMapId!, x: args.entranceX!, y: args.entranceY!,
              tileName: args.entranceTile ?? null, layer: args.layer, eventName: 'DungeonEntrance',
            },
            `map ${args.entranceMapId} ${args.entranceX},${args.entranceY} <-> ` +
            `map ${first.mapId} ${first.entrance.x},${first.entrance.y} (the way in)`
          );
        }

        for (let i = 0; i < floors.length - 1; i++) {
          const upper = floors[i];
          const lower = floors[i + 1];
          await connect(
            {
              mapId: upper.mapId, x: upper.exit.x, y: upper.exit.y,
              tileName: args.downTile, layer: args.layer, eventName: 'StairsDown',
            },
            {
              mapId: lower.mapId, x: lower.entrance.x, y: lower.entrance.y,
              tileName: args.upTile, layer: args.layer, eventName: 'StairsUp',
            },
            `map ${upper.mapId} ${upper.exit.x},${upper.exit.y} <-> ` +
            `map ${lower.mapId} ${lower.entrance.x},${lower.entrance.y}`
          );
        }

        const written = await session.flush();
        await project.getVersionSync().bump();

        logger.info(`Linked dungeon floors ${args.mapIds.join(' -> ')}`);

        const lines = [
          `Linked ${args.mapIds.length} floor(s): ${args.mapIds.join(' -> ')}.`,
          '',
          'Staircase:',
          ...links.map((l) => `  ${l}`),
          '',
          'Per floor, ends chosen as the two furthest apart along the floor:',
          ...floors.map(
            (f) =>
              `  map ${f.mapId}: in at ${f.entrance.x},${f.entrance.y}, out at ${f.exit.x},${f.exit.y} ` +
              `— ${f.distance} steps apart, ${f.reachable} floor tile(s), by ${f.basis}`
          ),
          '',
          `${allEvents.length} event(s) written across map(s) ${written.join(', ')}.`,
        ];

        if (!hasEntrance) {
          lines.push(
            '',
            `Nothing leads into map ${floors[0].mapId} from outside the dungeon, so it is still ` +
            'unreachable in game. Pass entranceMapId, entranceX and entranceY to join it to a ' +
            'world or town map, or use place_stairs afterwards.'
          );
        }
        lines.push(
          '',
          `The deepest floor (map ${floors[floors.length - 1].mapId}) has no way onward: its far ` +
          `end at ${floors[floors.length - 1].exit.x},${floors[floors.length - 1].exit.y} was left ` +
          'clear for whatever the dungeon is for.'
        );
        if (notes.length > 0) lines.push('', ...notes.map((n) => `Note: ${n}`));

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        if (error instanceof StairError) return errorResult(error.message);
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
