import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { DatabaseManager } from '../core/database-manager.js';
import { defaultItem } from '../templates/defaults.js';
import { standableGrid } from '../core/walkability.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { addEvent } from '../core/building-placement.js';
import { rejectSealingSlots, treasureEvent } from '../core/dungeon-dressing.js';
import { planFloorLock, findChokepoints, type Slot } from '../core/chokepoint.js';
import { lockedDoorEvent, readLock } from '../core/locked-door.js';
import { leverEvent } from '../core/lever.js';
import { keyItemFields } from '../core/quest.js';
import { allocateFlag, findFlag, SwitchError } from '../core/switches.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';
import type { Item } from '../schemas/database.js';
import type { Event } from '../schemas/event.js';
import { logger } from '../logger.js';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/** Where the player comes into this map, taken from its own events. */
function findEntrance(mapData: MapData): { slot: Slot; from: string } | null {
  for (const event of mapData.events.filter((e): e is Event => e !== null)) {
    for (const page of event.pages) {
      // A stair or interior exit is a transfer page: the tile it stands on is
      // where the player walks in from the other side.
      if (page.list.some((c) => c.code === 201)) {
        return {
          slot: { x: event.x, y: event.y },
          from: `event ${event.id} "${event.name || '(unnamed)'}", which transfers`,
        };
      }
    }
  }
  return null;
}

export function registerFloorLockTools(server: McpServer): void {
  server.tool(
    'lock_dungeon_floor',
    'Divide a generated floor with a locked door and put its opener — a key in ' +
      'a chest, or a lever — on the near side. The door goes on a tile that ' +
      'genuinely splits the floor, found the same way decorate_dungeon finds ' +
      'the tiles a prop must not block.',
    {
      mapId: z.number().int().positive().describe('Map to lock'),
      lockKind: z.enum(['item', 'switch']).default('item')
        .describe(
          'item puts a key in a chest on the near side; switch puts a lever there'
        ),
      keyName: z.string().optional()
        .describe(
          'Name of the key item (lockKind=item) or of the switch (lockKind=switch). ' +
          'Created if the project does not have it. Defaults to naming it after the map.'
        ),
      keyId: z.number().int().positive().optional()
        .describe('Use this existing item id instead of creating a key'),
      entranceX: z.number().int().min(0).optional()
        .describe('Where the player arrives. Taken from a transfer event on the map if omitted.'),
      entranceY: z.number().int().min(0).optional(),
      minSideFraction: z.number().min(0.01).max(0.49).default(0.05)
        .describe(
          'How much of the floor must lie on each side of the door, as a fraction. ' +
          'Stops the door being placed onto a cupboard. The default is measured, not ' +
          'chosen: across 40 seeds the best split a generated dungeon offers is a median ' +
          '7.1% of the floor at 40x30 and 4.7% at 60x45, so anything above ~0.05 rejects ' +
          'most floors outright.'
        ),
      lockedText: z.string().optional().describe('What the door says when it refuses'),
      doorSprite: z.string().default('!Door1').describe('Door sprite sheet'),
      leverSprite: z.string().default('!Switch1').describe('Lever sprite sheet, for a switch lock'),
    },
    async (args) => {
      try {
        const project = requireProject();
        const dataPath = project.dataPath;

        const mapPath = path.join(dataPath, mapFilename(args.mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return errorResult(`Map ID ${args.mapId} not found.`);
        }
        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;
        const tileset = await TilesetReader.get(dataPath, mapData.tilesetId);
        const floor = standableGrid(mapData, tileset.flags);

        // --- where does the player come in ---
        let entrance: Slot;
        let entranceFrom: string;
        if (args.entranceX !== undefined && args.entranceY !== undefined) {
          entrance = { x: args.entranceX, y: args.entranceY };
          entranceFrom = 'the coordinates given';
        } else {
          const found = findEntrance(mapData);
          if (!found) {
            return errorResult(
              'No entrance given and nothing on this map transfers the player, so there is no ' +
              'way to tell which side of a door is the near one. Pass entranceX/entranceY, or ' +
              'link the floor first with place_stairs.'
            );
          }
          entrance = found.slot;
          entranceFrom = found.from;
        }

        if (floor[entrance.y]?.[entrance.x] !== true) {
          return errorResult(
            `The entrance (${entrance.x}, ${entrance.y}) is not a tile the player can stand on. ` +
            'A stair event sits on the floor it arrives at, so this is usually a hand-passed ' +
            'coordinate that is one tile out.'
          );
        }

        // Existing events keep their tiles.
        const taken: Slot[] = mapData.events
          .filter((e): e is Event => e !== null)
          .map((e) => ({ x: e.x, y: e.y }));

        // A door already locked here is a wall for this analysis. Without that,
        // a second lock lands beside the first and gates the same region twice:
        // the accessible part of the floor is what a new door should divide,
        // and anything past an existing lock is already behind a key.
        const existingLocks: Slot[] = [];
        for (const event of mapData.events.filter((e): e is Event => e !== null)) {
          if (readLock(event.pages) === null) continue;
          existingLocks.push({ x: event.x, y: event.y });
          if (floor[event.y]?.[event.x]) floor[event.y][event.x] = false;
        }

        // --- find the door ---
        const plan = planFloorLock(floor, {
          entrance,
          blocked: taken,
          minSideFraction: args.minSideFraction,
        });

        if (!plan) {
          const anySplit = findChokepoints(floor, { entrance, blocked: taken, minSideFraction: 0.01 });
          if (anySplit.length > 0) {
            const total = floor.reduce((n, row) => n + row.filter(Boolean).length, 0);
            const smaller = Math.min(anySplit[0].nearSize, anySplit[0].farSize);
            return errorResult(
              `The only splits available are lopsided — the best leaves ${smaller} tile(s) ` +
              `(${(smaller / total * 100).toFixed(1)}% of the floor) on the smaller side, under ` +
              `the ${args.minSideFraction} fraction asked for. Generated floors are loopier ` +
              'than they look, and the bigger they are the worse they split: pass ' +
              `minSideFraction=${Math.max(0.01, Math.floor((smaller / total) * 100) / 100)} to ` +
              'take this one.'
            );
          }

          // A floor with no chokepoint at all is usually not a shape problem.
          // Passability lives in Tilesets.json, so an unconfigured tileset makes
          // every painted wall walkable and the whole map one open room — which
          // looks identical to a cave with wide chambers from in here.
          const walkable = floor.reduce((n, row) => n + row.filter(Boolean).length, 0);
          const fraction = walkable / (mapData.width * mapData.height);
          return errorResult(
            fraction > 0.9
              ? `${Math.round(fraction * 100)}% of this map is standable, so its walls are not ` +
                'blocking anything and the floor is one open room — nothing can divide that. ' +
                'Passability lives in Tilesets.json rather than in map data, so it is one of ' +
                `two things: tileset ${mapData.tilesetId} was never configured (run ` +
                `configure_tileset_passage tilesetId=${mapData.tilesetId}; check_project reports ` +
                'this as tileset-passage-unconfigured), or the material painted around the ' +
                'layout is a walkable one — describe_tileset_materials says which are solid.'
              : 'No tile on this floor divides it: every part can be reached another way round, ' +
                'so a door anywhere would be decoration. Caves generated with wide open ' +
                'chambers often come out this way — a dungeon layout has more corridors.'
          );
        }

        // --- the lock ---
        const defaultName =
          args.keyName ??
          (args.lockKind === 'item' ? `Key to map ${args.mapId}` : `Map ${args.mapId} door open`);

        let lockDataId: number;
        let lockLabel: string;
        let created: string | null = null;

        if (args.lockKind === 'item') {
          if (args.keyId !== undefined) {
            const items = (await FileHandler.readJsonRaw(
              path.join(dataPath, 'Items.json')
            )) as ({ name?: unknown } | null)[];
            const row = items[args.keyId];
            if (!row || typeof row.name !== 'string' || row.name.trim() === '') {
              return errorResult(
                `Item ${args.keyId} is not in Items.json, or has no name. hasItem answers false ` +
                'for an entry that is not there, so the door could never open.'
              );
            }
            lockDataId = args.keyId;
            lockLabel = row.name;
          } else {
            const manager = new DatabaseManager<Item>(
              project.path,
              'Items.json',
              defaultItem,
              project.getVersionSync()
            );
            const existing = (await manager.list()).find(
              (e) => e.name.trim().toLowerCase() === defaultName.trim().toLowerCase()
            );
            if (existing) {
              lockDataId = existing.id;
              lockLabel = existing.name;
            } else {
              const { id, entity } = await manager.create(
                keyItemFields({ name: defaultName }) as Partial<Item>
              );
              lockDataId = id;
              lockLabel = entity.name;
              created = `Key item ${id} "${entity.name}" was created — unsellable, unusable and ` +
                'not consumable, so the player cannot destroy it.';
            }
          }
        } else {
          const systemPath = path.join(dataPath, 'System.json');
          const system = (await FileHandler.readJsonRaw(systemPath)) as {
            switches: string[];
            [key: string]: unknown;
          };
          if (!Array.isArray(system.switches)) {
            return errorResult('System.json has no switches array. Refusing to guess at one.');
          }
          const existing = findFlag(system.switches, defaultName);
          if (existing !== null) {
            lockDataId = existing;
            lockLabel = system.switches[existing];
          } else {
            let allocated;
            try {
              allocated = allocateFlag(system.switches, defaultName);
            } catch (error) {
              if (error instanceof SwitchError) return errorResult(error.message);
              throw error;
            }
            system.switches = allocated.names;
            await FileHandler.writeJson(systemPath, system);
            lockDataId = allocated.id;
            lockLabel = defaultName;
            created = `Switch ${allocated.id} was allocated as "${defaultName}"` +
              (allocated.grew ? ', extending the switches array to make the id usable.' : '.');
          }
        }

        // --- the opener has to be safe to stand on that tile ---
        // Both a chest and a lever are priority 1 and block their tile, so the
        // same test applies to either. The door is checked too, and is *meant*
        // to seal — that is reported rather than refused.
        const sealing = rejectSealingSlots(floor, [plan.opener, plan.door], [true, true]);
        if (sealing.sealed.includes(0)) {
          return errorResult(
            `The best spot for the opener, (${plan.opener.x}, ${plan.opener.y}), would wall part ` +
            'of the near side off. Place the door by hand with place_locked_door.'
          );
        }

        // --- write the door, then the opener ---
        const door = addEvent(mapData, (id) =>
          lockedDoorEvent(id, plan.door.x, plan.door.y, {
            lock: { kind: args.lockKind === 'item' ? 'item' : 'switch', dataId: lockDataId },
            characterName: args.doorSprite,
            lockedText: args.lockedText ?? "It's locked.",
            name: `LockedDoor${id}`,
          })
        );

        const opener =
          args.lockKind === 'item'
            ? addEvent(mapData, (id) =>
                treasureEvent(id, plan.opener.x, plan.opener.y, {
                  loot: { kind: 'item', dataId: lockDataId, name: lockLabel, price: 0, amount: 1 },
                  text: `You found \\c[6]${lockLabel}\\c[0]!`,
                })
              )
            : addEvent(mapData, (id) =>
                leverEvent(id, plan.opener.x, plan.opener.y, {
                  switchId: lockDataId,
                  characterName: args.leverSprite,
                  name: `Lever${id}`,
                })
              );

        if (args.lockKind === 'item') opener.name = `Key to ${door.name}`;

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(
          `Locked map ${args.mapId}: door ${door.id} at (${plan.door.x}, ${plan.door.y}), ` +
          `opener ${opener.id} at (${plan.opener.x}, ${plan.opener.y})`
        );

        const total = plan.door.nearSize + plan.door.farSize + 1;
        const lines = [
          `Map ${args.mapId} is now in two halves.`,
          '',
          `Door: event ${door.id} at (${plan.door.x}, ${plan.door.y}), opening on ` +
          (args.lockKind === 'item'
            ? `item ${lockDataId} ("${lockLabel}")`
            : `switch ${lockDataId} ("${lockLabel}")`),
          `  ${plan.door.nearSize} of ${total} walkable tiles stay reachable; ` +
          `${plan.door.farSize} are behind it (${(plan.door.farSize / total * 100).toFixed(1)}%).`,
          '',
          args.lockKind === 'item'
            ? `Key: chest event ${opener.id} at (${plan.opener.x}, ${plan.opener.y}), on the near side.`
            : `Lever: event ${opener.id} at (${plan.opener.x}, ${plan.opener.y}), on the near side.`,
          `Entrance taken from ${entranceFrom}: (${entrance.x}, ${entrance.y}).`,
        ];

        if (existingLocks.length > 0) {
          lines.push(
            '',
            `${existingLocks.length} door(s) on this map were already locked, and were treated ` +
            'as walls while looking for this one — so the new door divides the part of the ' +
            'floor the player can reach, rather than landing beside an existing lock and ' +
            'gating the same region twice.'
          );
        }

        if (created) lines.push('', created);

        lines.push(
          '',
          'The door tile is one whose loss would disconnect the floor — the same test ' +
          'decorate_dungeon uses to *reject* a prop, read the other way round. The opener is on ' +
          'the side the entrance can still reach, so the floor stays completable, and it is in a ' +
          'dead end where a blocking event can never cut anything off.'
        );

        if (sealing.sealed.includes(1)) {
          lines.push(
            '',
            'Note: the door tile itself is load-bearing for connectivity, which is the point — ' +
            'until it is opened, the far side is unreachable. That is the intended state, not a ' +
            'walkability bug, and check_map_walkability will report the far side as cut off.'
          );
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
