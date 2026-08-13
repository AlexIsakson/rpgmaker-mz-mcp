import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { DatabaseManager } from '../core/database-manager.js';
import { defaultItem } from '../templates/defaults.js';
import { standableGrid } from '../core/walkability.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { addEvent } from '../core/building-placement.js';
import { buildMapGraph, type LoadedMap, type CommonEventLike, type MapGraph } from '../core/map-graph.js';
import { readLock, describeLock } from '../core/locked-door.js';
import { treasureEvent, rejectSealingSlots } from '../core/dungeon-dressing.js';
import { keyItemFields, checkKeyPlacement, QuestError } from '../core/quest.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData, MapInfo } from '../schemas/map.js';
import type { Item } from '../schemas/database.js';
import type { Event } from '../schemas/event.js';
import { logger } from '../logger.js';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

const KEY_DATABASE = {
  item: 'Items.json',
  weapon: 'Weapons.json',
  armor: 'Armors.json',
} as const;

/** The world graph, built from every map with a data file. */
async function loadWorldGraph(dataPath: string): Promise<{
  graph: MapGraph;
  startMapId: number;
  hasDynamicTransfers: boolean;
}> {
  const mapInfos = (await FileHandler.readJsonRaw(
    path.join(dataPath, 'MapInfos.json')
  )) as (MapInfo | null)[];

  const maps: LoadedMap[] = [];
  for (let id = 0; id < mapInfos.length; id++) {
    if (!mapInfos[id]) continue;
    const mapPath = path.join(dataPath, mapFilename(id));
    if (!(await FileHandler.exists(mapPath))) continue;
    maps.push({ id, data: (await FileHandler.readJsonRaw(mapPath)) as MapData });
  }

  const rawCommonEvents = (await FileHandler.readJsonRaw(
    path.join(dataPath, 'CommonEvents.json')
  )) as (CommonEventLike | null)[];
  const commonEvents = rawCommonEvents.filter((ce): ce is CommonEventLike => ce !== null);

  const system = (await FileHandler.readJsonRaw(path.join(dataPath, 'System.json'))) as {
    startMapId?: number;
  };

  const graph = buildMapGraph({
    startMapId: system.startMapId ?? 1,
    maps,
    mapInfos,
    commonEvents,
  });

  return {
    graph,
    startMapId: system.startMapId ?? 1,
    hasDynamicTransfers: graph.dynamicTransfers.length > 0,
  };
}

export function registerQuestTools(server: McpServer): void {
  server.tool(
    'create_key_item',
    'Add a key item to the database — one that cannot be sold, used or eaten. ' +
      'A key made with create_entity keeps the default item settings, which make ' +
      'it usable from the menu and consumable, so the player can destroy it and ' +
      'lock themselves out of the game permanently.',
    {
      name: z.string().min(1).describe('What the key is called, e.g. "Cellar Key"'),
      description: z.string().optional().describe('Shown in the item window'),
      iconIndex: z.number().int().min(0).default(195)
        .describe('Icon in the shipped IconSet. 195 is a key.'),
      note: z.string().optional().describe('Note box contents'),
    },
    async (args) => {
      try {
        const project = requireProject();

        let fields;
        try {
          fields = keyItemFields(args);
        } catch (error) {
          if (error instanceof QuestError) return errorResult(error.message);
          throw error;
        }

        const items = new DatabaseManager<Item>(
          project.path,
          'Items.json',
          defaultItem,
          project.getVersionSync()
        );

        const existing = (await items.list()).find(
          (e) => e.name.trim().toLowerCase() === args.name.trim().toLowerCase()
        );
        if (existing) {
          return errorResult(
            `Item ${existing.id} is already called "${existing.name}". Two keys with the same ` +
            'name are indistinguishable in the item window and in every finding this server ' +
            'reports — rename one, or use the existing id.'
          );
        }

        const { id, entity } = await items.create(fields as Partial<Item>);

        logger.info(`Created key item ${id}: ${entity.name}`);

        return {
          content: [{
            type: 'text' as const,
            text: [
              `Item ${id} "${entity.name}" created as a key item.`,
              '',
              'itypeId 2 files it under Key Items (Window_ItemList splits the category on ' +
              'exactly this field).',
              'occasion 3 is "never": isOccasionOk returns false both in battle and out, so the ' +
              'key cannot be used — and consumable false means using it could not spend it ' +
              'either. An ordinary item is occasion 0 and consumable, which is a key the player ' +
              'can destroy.',
              'price 0 keeps it out of shops and chests: isTradeable requires a price above ' +
              'zero, and place_shop and the loot table both use it.',
              '',
              `Lock a door with it: place_locked_door lockKind=item keyId=${id}`,
            ].join('\n'),
          }],
        };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'place_key_for_door',
    'Put the key to a particular locked door in a chest, and refuse if that ' +
      'would make the game unwinnable. A key placed behind the door it opens ' +
      'cannot be fetched, and nothing in the engine or the editor reports it — ' +
      'the world graph is walked with the door removed to prove otherwise.',
    {
      doorMapId: z.number().int().positive().describe('Map the locked door is on'),
      doorEventId: z.number().int().positive().describe('Event id of the locked door'),
      mapId: z.number().int().positive().describe('Map to put the key on'),
      x: z.number().int().min(0).describe('X of the chest'),
      y: z.number().int().min(0).describe('Y of the chest'),
      text: z.string().optional()
        .describe('What the chest says. Defaults to naming the key the way a pickup does.'),
      characterName: z.string().default('!Chest').describe('Chest sprite sheet'),
      characterIndex: z.number().int().min(0).max(7).default(0),
      name: z.string().optional().describe('Event name. Defaults to "Key to <door>".'),
      allowBehindDoor: z.boolean().default(false)
        .describe(
          'Place the key even if it can only be reached through the door it opens. ' +
          'Only correct for a door meant to be opened from the far side, as a shortcut back.'
        ),
    },
    async (args) => {
      try {
        const project = requireProject();
        const dataPath = project.dataPath;

        // --- the door, and what it asks for ---
        const doorPath = path.join(dataPath, mapFilename(args.doorMapId));
        if (!(await FileHandler.exists(doorPath))) {
          return errorResult(`Map ID ${args.doorMapId} not found.`);
        }
        const doorMap = (await FileHandler.readJsonRaw(doorPath)) as MapData;
        const door = doorMap.events.find((e): e is Event => e !== null && e.id === args.doorEventId);
        if (!door) {
          return errorResult(`Map ${args.doorMapId} has no event ${args.doorEventId}.`);
        }

        const lock = readLock(door.pages);
        if (!lock) {
          return errorResult(
            `Event ${args.doorEventId} "${door.name}" does not test for anything — no page ` +
            'branches on a switch or on the party holding an item. Lock it first with ' +
            'place_locked_door.'
          );
        }
        if (lock.kind === 'switch') {
          return errorResult(
            `Event ${args.doorEventId} "${door.name}" is locked behind ${describeLock(lock)}, ` +
            'not behind a key. A switch is opened by something that sets it — a lever, an NPC, ' +
            'the end of a quest — and there is no item to put in a chest. Use ' +
            'place_locked_door with lockKind=item if this door should take a key.'
          );
        }

        // --- the key has to exist, or the chest hands over nothing ---
        const keyFile = path.join(dataPath, KEY_DATABASE[lock.kind]);
        const rawKeys = (await FileHandler.exists(keyFile))
          ? await FileHandler.readJsonRaw(keyFile)
          : null;
        const keyRow = Array.isArray(rawKeys)
          ? (rawKeys[lock.dataId] as { name?: unknown; price?: unknown } | null | undefined)
          : null;
        if (!keyRow || typeof keyRow.name !== 'string' || keyRow.name.trim() === '') {
          return errorResult(
            `The door asks for ${lock.kind} ${lock.dataId}, which is not in ` +
            `${KEY_DATABASE[lock.kind]}. check_project reports this as ` +
            'branch-checks-missing-entry: hasItem is false for an entry that is not there, so ' +
            'the door can never open however the key is placed.'
          );
        }
        const keyName = keyRow.name;

        // --- the map the key is going on ---
        const keyMapPath = path.join(dataPath, mapFilename(args.mapId));
        if (!(await FileHandler.exists(keyMapPath))) {
          return errorResult(`Map ID ${args.mapId} not found.`);
        }
        const keyMap = (await FileHandler.readJsonRaw(keyMapPath)) as MapData;
        if (args.x >= keyMap.width || args.y >= keyMap.height) {
          return errorResult(
            `(${args.x}, ${args.y}) is outside map ${args.mapId}, which is ` +
            `${keyMap.width}x${keyMap.height}.`
          );
        }

        // --- is the key behind its own door? ---
        const world = await loadWorldGraph(dataPath);
        const verdict = checkKeyPlacement({
          edges: world.graph.edges,
          startMapId: world.startMapId,
          door: { mapId: args.doorMapId, eventId: args.doorEventId },
          keyMapId: args.mapId,
          hasDynamicTransfers: world.hasDynamicTransfers,
        });

        if (!verdict.reachable && !args.allowBehindDoor) {
          return errorResult(
            `${verdict.message}\n\n` +
            (verdict.certain
              ? 'Put the key on one of the maps reachable without the door — ' +
                `${[...verdict.reachableMaps].sort((a, b) => a - b).join(', ')} — or pass ` +
                'allowBehindDoor if the door is meant to be opened from the far side.'
              : 'Pass allowBehindDoor to place it anyway, or check the variable-driven ' +
                'transfers with get_map_graph first.')
          );
        }

        // --- and can the player stand next to it, without it sealing anything ---
        const tileset = await TilesetReader.get(dataPath, keyMap.tilesetId);
        const standable = standableGrid(keyMap, tileset.flags);
        if (standable[args.y]?.[args.x] !== true) {
          return errorResult(
            `(${args.x}, ${args.y}) on map ${args.mapId} is not a tile anything can stand on, ` +
            'so the chest would sit inside a wall. Pick a floor tile.'
          );
        }

        // A chest is priority 1 and blocks its tile, so the same connectivity
        // test decorate_dungeon uses applies: it may not cut anything off.
        const sealing = rejectSealingSlots(standable, [{ x: args.x, y: args.y }], [true]);
        if (sealing.sealed.length > 0) {
          return errorResult(
            `A chest at (${args.x}, ${args.y}) would wall part of map ${args.mapId} off — it is ` +
            'priority "same as characters" and blocks its own tile. Move it off the corridor.'
          );
        }

        // --- write it ---
        const chest = treasureEvent(0, args.x, args.y, {
          characterName: args.characterName,
          characterIndex: args.characterIndex,
          loot: { kind: lock.kind, dataId: lock.dataId, name: keyName, price: 0, amount: 1 },
          text: args.text,
        });

        const placed = addEvent(keyMap, (id) => ({
          ...chest,
          id,
          name: args.name ?? `Key to ${door.name || `event ${door.id}`}`,
        }));

        await FileHandler.writeJson(keyMapPath, keyMap);
        await project.getVersionSync().bump();

        logger.info(
          `Placed key ${lock.kind} ${lock.dataId} for door ${args.doorMapId}/${args.doorEventId} ` +
          `as event ${placed.id} on map ${args.mapId}`
        );

        const lines = [
          `Chest event ${placed.id} on map ${args.mapId} at (${args.x}, ${args.y}) holds ` +
          `${lock.kind} ${lock.dataId} "${keyName}".`,
          `It opens event ${args.doorEventId} "${door.name}" on map ${args.doorMapId}.`,
          '',
          verdict.message,
        ];

        if (!verdict.reachable) {
          lines.push(
            '',
            'Placed anyway because allowBehindDoor was set. Unless this door is meant to be ' +
            'opened from the far side, the game is now unwinnable and nothing at runtime will ' +
            'say so.'
          );
        } else if (!verdict.certain) {
          lines.push('', 'The route could not be proved statically — see the note above.');
        }

        lines.push(
          '',
          'The chest is the measured pickup shape: play the sound, say what was found, hand it ' +
          'over, flip self switch A. The second page leaves it standing open and does nothing.'
        );

        if (typeof keyRow.price === 'number' && keyRow.price > 0) {
          lines.push(
            '',
            `Warning: "${keyName}" has a price of ${keyRow.price}, so it is tradeable — ` +
            'place_shop and the loot table can both offer it, and the player can sell it. ' +
            'A key wants price 0, which is what create_key_item writes.'
          );
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
