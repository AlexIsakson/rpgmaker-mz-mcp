import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { standableGrid } from '../core/walkability.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { addEvent } from '../core/building-placement.js';
import {
  lockedDoorEvent,
  describeLock,
  LockedDoorError,
  LOCK_KINDS,
  type Lock,
} from '../core/locked-door.js';
import {
  allocateFlag,
  findFlag,
  highestUsableId,
  isUsableId,
  SwitchError,
} from '../core/switches.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';
import { logger } from '../logger.js';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

const KEY_DATABASE: Record<'item' | 'weapon' | 'armor', string> = {
  item: 'Items.json',
  weapon: 'Weapons.json',
  armor: 'Armors.json',
};

interface SystemFile {
  switches: string[];
  variables: string[];
  [key: string]: unknown;
}

/** The name of a database entry, or null when the id is not there. */
async function keyEntryName(
  dataPath: string,
  kind: 'item' | 'weapon' | 'armor',
  dataId: number
): Promise<string | null> {
  const file = path.join(dataPath, KEY_DATABASE[kind]);
  if (!(await FileHandler.exists(file))) return null;
  const raw = await FileHandler.readJsonRaw(file);
  if (!Array.isArray(raw)) return null;
  const row = raw[dataId] as { name?: unknown } | null | undefined;
  if (!row || typeof row.name !== 'string' || row.name.trim() === '') return null;
  return row.name;
}

export function registerLockedDoorTools(server: McpServer): void {
  server.tool(
    'place_locked_door',
    'Put a door on a map that only opens for a key item or a switch, and says so ' +
      'when it does not. Once opened it remembers, on a self switch, and behaves ' +
      'like an ordinary door afterwards. The key is checked against the database ' +
      'and the switch against System.json first, because both failures are silent ' +
      'in game: a branch on a deleted item is false forever.',
    {
      mapId: z.number().int().positive().describe('Map to put the door on'),
      x: z.number().int().min(0).describe('X of the door tile'),
      y: z.number().int().min(0).describe('Y of the door tile'),
      lockKind: z.enum(LOCK_KINDS).default('item')
        .describe(
          'What the door asks for. item/weapon/armor test the party\'s bag; ' +
          'switch tests a global flag, for a door a quest opens.'
        ),
      keyId: z.number().int().positive().optional()
        .describe('Database id of the key, or the switch id for lockKind=switch'),
      switchName: z.string().optional()
        .describe(
          'For lockKind=switch: name the flag instead of numbering it. An existing ' +
          'switch of that name is reused; otherwise one is allocated, exactly as ' +
          'allocate_switch would.'
        ),
      includeEquip: z.boolean().default(false)
        .describe(
          'Weapon/armour keys only: whether one a party member is wearing counts. ' +
          'command111 passes this to hasItem; an item lock has no such option.'
        ),
      targetMapId: z.number().int().positive().optional()
        .describe('Map the door leads to. Omit for a door that opens onto the same map.'),
      targetX: z.number().int().min(0).optional(),
      targetY: z.number().int().min(0).optional(),
      lockedText: z.string().default("It's locked.")
        .describe('What the player is told when they cannot open it'),
      unlockText: z.string().optional()
        .describe('Said on the way through. The one measured locked door says nothing here.'),
      consumeKey: z.boolean().default(false)
        .describe('Take the key away on the way through. Off by default — a key is usually kept.'),
      remember: z.boolean().default(true)
        .describe(
          'Remember it was opened on a self switch, so the player is asked once. ' +
          'Turn off for a gate that must follow its switch forever.'
        ),
      characterName: z.string().default('!Door1').describe('Door sprite sheet'),
      characterIndex: z.number().int().min(0).max(7).default(0),
      openSe: z.string().default('Open1').describe('SE played when it opens'),
      lockedSe: z.string().optional()
        .describe('SE played when it refuses. Defaults to the same one it opens with.'),
      name: z.string().optional().describe('Event name. Defaults to "LockedDoor<id>".'),
    },
    async (args) => {
      try {
        const { mapId, x, y, lockKind } = args;
        const project = requireProject();

        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return errorResult(`Map ID ${mapId} not found.`);
        }
        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;

        if (x >= mapData.width || y >= mapData.height) {
          return errorResult(
            `(${x}, ${y}) is outside map ${mapId}, which is ${mapData.width}x${mapData.height}.`
          );
        }

        // --- the destination, if there is one ---
        const hasTarget =
          args.targetMapId !== undefined ||
          args.targetX !== undefined ||
          args.targetY !== undefined;
        if (hasTarget && (args.targetMapId === undefined || args.targetX === undefined || args.targetY === undefined)) {
          return errorResult('A destination needs all three of targetMapId, targetX and targetY.');
        }
        if (args.targetMapId !== undefined) {
          const targetPath = path.join(project.dataPath, mapFilename(args.targetMapId));
          if (!(await FileHandler.exists(targetPath))) {
            return errorResult(
              `Target map ${args.targetMapId} has no data file. The transfer would drop the ` +
              'player into nothing.'
            );
          }
          const target = (await FileHandler.readJsonRaw(targetPath)) as MapData;
          if (args.targetX! >= target.width || args.targetY! >= target.height) {
            return errorResult(
              `(${args.targetX}, ${args.targetY}) is outside map ${args.targetMapId}, which is ` +
              `${target.width}x${target.height}.`
            );
          }
        }

        // --- the lock ---
        let lock: Lock;
        let keyName: string | undefined;
        let allocationNote: string | null = null;

        if (lockKind === 'switch') {
          const systemPath = path.join(project.dataPath, 'System.json');
          const system = (await FileHandler.readJsonRaw(systemPath)) as SystemFile;
          if (!Array.isArray(system.switches)) {
            return errorResult('System.json has no switches array. Refusing to guess at one.');
          }

          if (args.switchName === undefined && args.keyId === undefined) {
            return errorResult('A switch lock needs either switchName or keyId.');
          }

          if (args.switchName !== undefined) {
            const existing = findFlag(system.switches, args.switchName);
            if (existing !== null && (args.keyId === undefined || args.keyId === existing)) {
              lock = { kind: 'switch', dataId: existing };
              keyName = system.switches[existing];
            } else {
              let allocated;
              try {
                allocated = allocateFlag(
                  system.switches,
                  args.switchName,
                  args.keyId === undefined ? {} : { id: args.keyId }
                );
              } catch (error) {
                if (error instanceof SwitchError) return errorResult(error.message);
                throw error;
              }
              system.switches = allocated.names;
              await FileHandler.writeJson(systemPath, system);
              lock = { kind: 'switch', dataId: allocated.id };
              keyName = args.switchName;
              allocationNote =
                `Switch ${allocated.id} was allocated as "${args.switchName}"` +
                (allocated.grew
                  ? `, extending the switches array to ${allocated.names.length} slots so the id ` +
                    'is one the engine will actually write to.'
                  : '.');
            }
          } else {
            if (!isUsableId(system.switches, args.keyId!)) {
              return errorResult(
                `Switch ${args.keyId} is past the end of System.json's switches array, which ` +
                `reaches ${highestUsableId(system.switches)}. setValue is guarded by ` +
                '`switchId < $dataSystem.switches.length`, so nothing could ever turn it on and ' +
                'the door would never open. Allocate it first with allocate_switch.'
              );
            }
            lock = { kind: 'switch', dataId: args.keyId! };
            const stored = system.switches[args.keyId!];
            keyName = stored && stored.trim() !== '' ? stored : undefined;
          }
        } else {
          if (args.keyId === undefined) {
            return errorResult(`A ${lockKind} lock needs keyId — the database id of the key.`);
          }
          const found = await keyEntryName(project.dataPath, lockKind, args.keyId);
          if (found === null) {
            return errorResult(
              `${lockKind} ${args.keyId} is not in ${KEY_DATABASE[lockKind]}, or has no name. ` +
              '`command111` calls `hasItem($dataItems[id])` and `numItems` answers 0 for an ' +
              'entry that is not there, so the branch would be false forever and the door could ' +
              'never open — with nothing at runtime saying why.'
            );
          }
          keyName = found;
          lock = { kind: lockKind, dataId: args.keyId, includeEquip: args.includeEquip };
        }

        // --- build and write ---
        const target =
          args.targetMapId !== undefined
            ? { mapId: args.targetMapId, x: args.targetX!, y: args.targetY! }
            : undefined;

        let event;
        try {
          event = lockedDoorEvent(0, x, y, {
            lock,
            target,
            characterName: args.characterName,
            characterIndex: args.characterIndex,
            lockedText: args.lockedText,
            unlockText: args.unlockText,
            openSe: args.openSe,
            lockedSe: args.lockedSe,
            consumeKey: args.consumeKey,
            remember: args.remember,
            name: args.name,
          });
        } catch (error) {
          if (error instanceof LockedDoorError) return errorResult(error.message);
          throw error;
        }

        const placed = addEvent(mapData, (id) => ({
          ...event,
          id,
          name: args.name ?? `LockedDoor${id}`,
        }));

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(`Placed locked door ${placed.id} on map ${mapId} at (${x}, ${y})`);

        // --- report ---
        const lines = [
          `Locked door event ${placed.id} on map ${mapId} at (${x}, ${y}).`,
          `Opens on ${describeLock(lock, keyName)}.`,
          target
            ? `Leads to map ${target.mapId} at (${target.x}, ${target.y}).`
            : 'No destination — it opens onto the same map.',
          `Refuses with: "${args.lockedText}"`,
        ];

        if (allocationNote) lines.push('', allocationNote);

        if (args.consumeKey && lock.kind !== 'switch') {
          lines.push('', 'The key is taken on the way through, so the door asks for it once.');
        }

        lines.push(
          '',
          args.remember
            ? 'Page 2 is conditioned on self switch A and is an ordinary Player Touch door, so ' +
              'once it has been opened the player walks straight through. It sits after page 1 ' +
              'because findProperPageIndex scans pages backwards and takes the first match.'
            : 'One page only: the lock is tested every time. A door that stops opening when its ' +
              'switch goes off has to work this way.'
        );

        // Action Button needs somewhere to stand.
        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);
        const standable = standableGrid(mapData, tileset.flags);
        const approaches = [[0, 1], [0, -1], [1, 0], [-1, 0]].filter(([dx, dy]) => {
          const ax = x + dx;
          const ay = y + dy;
          return (
            ax >= 0 && ay >= 0 && ax < mapData.width && ay < mapData.height && standable[ay][ax]
          );
        });
        if (approaches.length === 0) {
          lines.push(
            '',
            'Nothing next to this tile is standable, so the player can never reach the door to ' +
            'try it. The locked page is an Action Button event, which needs someone standing ' +
            'beside it.'
          );
        }

        if (lock.kind === 'switch') {
          lines.push(
            '',
            'Nothing turns that switch on yet — the door is a lock without a key until ' +
            'something sets it. check_project reports a switch that is read but never written.'
          );
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
