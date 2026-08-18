import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { standableGrid } from '../core/walkability.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { addEvent } from '../core/building-placement.js';
import { rejectSealingSlots } from '../core/dungeon-dressing.js';
import { buildMapGraph, type LoadedMap, type CommonEventLike } from '../core/map-graph.js';
import { readLock } from '../core/locked-door.js';
import { leverEvent, LeverError } from '../core/lever.js';
import { checkOpenerPlacement } from '../core/quest.js';
import {
  allocateFlag,
  findFlag,
  highestUsableId,
  isUsableId,
  SwitchError,
} from '../core/switches.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import { MapRefError } from '../core/map-refs.js';
import { requireProjectSheets } from './map-ref-loaders.js';
import type { MapData, MapInfo } from '../schemas/map.js';
import type { Event } from '../schemas/event.js';
import { logger } from '../logger.js';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

interface SystemFile {
  switches: string[];
  variables: string[];
  [key: string]: unknown;
}

/** A door somewhere in the project that this switch opens. */
interface GatedDoor {
  mapId: number;
  mapName: string;
  eventId: number;
  eventName: string;
}

export function registerLeverTools(server: McpServer): void {
  server.tool(
    'place_lever',
    'Put a lever on a map that turns a switch on — the thing that opens a ' +
      'switch-locked door, which has no key to find. Reports which doors it ' +
      'opens, and refuses when the lever can only be reached through one of ' +
      'them, since a lever behind its own gate can never be thrown.',
    {
      mapId: z.number().int().positive().describe('Map to put the lever on'),
      x: z.number().int().min(0).describe('X of the lever'),
      y: z.number().int().min(0).describe('Y of the lever'),
      switchName: z.string().optional()
        .describe(
          'Name the flag it throws. An existing switch of that name is reused; ' +
          'otherwise one is allocated, exactly as allocate_switch would.'
        ),
      switchId: z.number().int().positive().optional()
        .describe('Or give the switch id directly'),
      text: z.string().optional()
        .describe('Said when it is thrown, e.g. "Something heavy shifts below."'),
      toggle: z.boolean().default(false)
        .describe(
          'Whether it can be pulled back off. Off by default — a lever that opens ' +
          'a gate should not close it again by accident.'
        ),
      offText: z.string().optional().describe('Said when pulled back. Needs toggle.'),
      characterName: z.string().default('!Switch1')
        .describe(
          'Sprite sheet. !Switch1 slot 0 is a lever and slot 4 a floor button; ' +
          '!Switch2 slot 0 is a wall lever. Each slot lays its four states out ' +
          'along the direction axis, the way !Chest does.'
        ),
      characterIndex: z.number().int().min(0).max(7).default(0),
      se: z.string().default('Switch1').describe('SE played when it is thrown'),
      name: z.string().optional().describe('Event name. Defaults to "Lever<id>".'),
      allowBehindDoor: z.boolean().default(false)
        .describe('Place it even where it can only be reached through a door it opens'),
    },
    async (args) => {
      try {
        const project = requireProject();
        await requireProjectSheets(project.path, [[args.characterName, 'characterName']]);
        const dataPath = project.dataPath;

        const mapPath = path.join(dataPath, mapFilename(args.mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return errorResult(`Map ID ${args.mapId} not found.`);
        }
        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;
        if (args.x >= mapData.width || args.y >= mapData.height) {
          return errorResult(
            `(${args.x}, ${args.y}) is outside map ${args.mapId}, which is ` +
            `${mapData.width}x${mapData.height}.`
          );
        }

        // --- the flag it throws ---
        if (args.switchName === undefined && args.switchId === undefined) {
          return errorResult('A lever needs either switchName or switchId — it has to throw something.');
        }

        const systemPath = path.join(dataPath, 'System.json');
        const system = (await FileHandler.readJsonRaw(systemPath)) as SystemFile;
        if (!Array.isArray(system.switches)) {
          return errorResult('System.json has no switches array. Refusing to guess at one.');
        }

        let switchId: number;
        let switchLabel: string | undefined;
        let allocationNote: string | null = null;

        if (args.switchName !== undefined) {
          const existing = findFlag(system.switches, args.switchName);
          if (existing !== null && (args.switchId === undefined || args.switchId === existing)) {
            switchId = existing;
            switchLabel = system.switches[existing];
          } else {
            let allocated;
            try {
              allocated = allocateFlag(
                system.switches,
                args.switchName,
                args.switchId === undefined ? {} : { id: args.switchId }
              );
            } catch (error) {
              if (error instanceof SwitchError) return errorResult(error.message);
              throw error;
            }
            system.switches = allocated.names;
            await FileHandler.writeJson(systemPath, system);
            switchId = allocated.id;
            switchLabel = args.switchName;
            allocationNote =
              `Switch ${allocated.id} was allocated as "${args.switchName}"` +
              (allocated.grew
                ? `, extending the switches array to ${allocated.names.length} slots so the id ` +
                  'is one the engine will actually write to.'
                : '.');
          }
        } else {
          if (!isUsableId(system.switches, args.switchId!)) {
            return errorResult(
              `Switch ${args.switchId} is past the end of System.json's switches array, which ` +
              `reaches ${highestUsableId(system.switches)}. setValue is guarded by ` +
              '`switchId < $dataSystem.switches.length`, so throwing this lever would do ' +
              'nothing at all. Allocate it first with allocate_switch.'
            );
          }
          switchId = args.switchId!;
          const stored = system.switches[args.switchId!];
          switchLabel = stored && stored.trim() !== '' ? stored : undefined;
        }

        // --- what does this switch actually open? ---
        const mapInfos = (await FileHandler.readJsonRaw(
          path.join(dataPath, 'MapInfos.json')
        )) as (MapInfo | null)[];

        const maps: LoadedMap[] = [];
        for (let id = 0; id < mapInfos.length; id++) {
          if (!mapInfos[id]) continue;
          const other = path.join(dataPath, mapFilename(id));
          if (!(await FileHandler.exists(other))) continue;
          maps.push({
            id,
            data:
              id === args.mapId
                ? mapData
                : ((await FileHandler.readJsonRaw(other)) as MapData),
          });
        }

        const gated: GatedDoor[] = [];
        for (const map of maps) {
          for (const event of map.data.events.filter((e): e is Event => e !== null)) {
            const lock = readLock(event.pages);
            if (lock?.kind === 'switch' && lock.dataId === switchId) {
              gated.push({
                mapId: map.id,
                mapName: mapInfos[map.id]?.name ?? `Map${map.id}`,
                eventId: event.id,
                eventName: event.name || '(unnamed)',
              });
            }
          }
        }

        // --- a lever behind a door it opens can never be thrown ---
        const rawCommonEvents = (await FileHandler.readJsonRaw(
          path.join(dataPath, 'CommonEvents.json')
        )) as (CommonEventLike | null)[];
        const commonEvents = rawCommonEvents.filter((ce): ce is CommonEventLike => ce !== null);
        const startMapId =
          ((await FileHandler.readJsonRaw(systemPath)) as { startMapId?: number }).startMapId ?? 1;
        const graph = buildMapGraph({ startMapId, maps, mapInfos, commonEvents });

        const unreachableBehind: { door: GatedDoor; message: string; certain: boolean }[] = [];
        for (const door of gated) {
          const verdict = checkOpenerPlacement({
            edges: graph.edges,
            startMapId,
            door: { mapId: door.mapId, eventId: door.eventId },
            placedOnMapId: args.mapId,
            hasDynamicTransfers: graph.dynamicTransfers.length > 0,
            opener: 'lever',
          });
          if (!verdict.reachable) {
            unreachableBehind.push({ door, message: verdict.message, certain: verdict.certain });
          }
        }

        if (unreachableBehind.length > 0 && !args.allowBehindDoor) {
          const first = unreachableBehind[0];
          return errorResult(
            `${first.message}\n\n` +
            `The door is event ${first.door.eventId} "${first.door.eventName}" on map ` +
            `${first.door.mapId} "${first.door.mapName}". Put the lever somewhere reachable ` +
            'without it, or pass allowBehindDoor if another lever opens that door too.'
          );
        }

        // --- it blocks its tile, and has to be reachable on this map ---
        const tileset = await TilesetReader.get(dataPath, mapData.tilesetId);
        const standable = standableGrid(mapData, tileset.flags);

        const sealing = rejectSealingSlots(standable, [{ x: args.x, y: args.y }], [true]);
        if (sealing.sealed.length > 0) {
          return errorResult(
            `A lever at (${args.x}, ${args.y}) would wall part of map ${args.mapId} off — it is ` +
            'priority "same as characters" and blocks its own tile.'
          );
        }

        const approaches = [[0, 1], [0, -1], [1, 0], [-1, 0]].filter(([dx, dy]) => {
          const ax = args.x + dx;
          const ay = args.y + dy;
          return (
            ax >= 0 && ay >= 0 && ax < mapData.width && ay < mapData.height && standable[ay][ax]
          );
        });

        // --- write it ---
        let event;
        try {
          event = leverEvent(0, args.x, args.y, {
            switchId,
            characterName: args.characterName,
            characterIndex: args.characterIndex,
            se: args.se,
            text: args.text,
            toggle: args.toggle,
            offText: args.offText,
            name: args.name,
          });
        } catch (error) {
          if (error instanceof LeverError) return errorResult(error.message);
          throw error;
        }

        const placed = addEvent(mapData, (id) => ({
          ...event,
          id,
          name: args.name ?? `Lever${id}`,
        }));

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(
          `Placed lever ${placed.id} on map ${args.mapId} at (${args.x}, ${args.y}) ` +
          `for switch ${switchId}`
        );

        const flagLabel = switchLabel ? `switch ${switchId} ("${switchLabel}")` : `switch ${switchId}`;
        const lines = [
          `Lever event ${placed.id} on map ${args.mapId} at (${args.x}, ${args.y}) turns ` +
          `${flagLabel} on.`,
        ];

        if (allocationNote) lines.push('', allocationNote);

        lines.push('');
        if (gated.length === 0) {
          lines.push(
            'Nothing in the project is locked behind that switch yet, so the lever throws a flag ' +
            'nobody reads. Lock a door with place_locked_door lockKind=switch ' +
            `switchId=${switchId}.`
          );
        } else {
          lines.push('It opens:');
          for (const door of gated) {
            lines.push(`  map ${door.mapId} "${door.mapName}", event ${door.eventId} "${door.eventName}"`);
          }
        }

        if (unreachableBehind.length > 0) {
          lines.push(
            '',
            'Placed anyway because allowBehindDoor was set. ' + unreachableBehind[0].message
          );
        }

        lines.push(
          '',
          args.toggle
            ? 'It can be pulled back: the thrown page turns the switch off again.'
            : 'One way only — the thrown page has no commands, and Game_Event.start needs a list ' +
              'longer than its terminator before an event will run at all.',
          'The thrown page is conditioned on the switch itself rather than a self switch, so if ' +
          'anything else turns that flag off the lever springs back to resting. A chest uses a ' +
          'self switch because "already looted" is a fact about the chest; this is a fact about ' +
          'the world.'
        );

        if (approaches.length === 0) {
          lines.push(
            '',
            'Nothing next to this tile is standable, so the player can never reach the lever. It ' +
            'is an Action Button event, which needs someone standing beside it.'
          );
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        if (error instanceof MapRefError) return errorResult(error.message);
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
