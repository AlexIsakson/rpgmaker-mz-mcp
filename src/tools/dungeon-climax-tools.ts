import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { DatabaseManager } from '../core/database-manager.js';
import { defaultItem } from '../templates/defaults.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { addEvent } from '../core/building-placement.js';
import { getAutotileKind, TILE_ID_A2, TILE_ID_A3 } from '../core/autotile.js';
import { planStairEnds, StairError } from '../core/stairs.js';
import { findChokepoints, planClimaxLock, type Slot } from '../core/chokepoint.js';
import { rejectSealingSlots, treasureEvent } from '../core/dungeon-dressing.js';
import { climaxGuardEvent, ClimaxError, DEFAULT_GUARD_SHEET } from '../core/dungeon-climax.js';
import { lockedDoorEvent, readLock } from '../core/locked-door.js';
import { leverEvent } from '../core/lever.js';
import { keyItemFields } from '../core/quest.js';
import { buildLootTable, dealLoot, withoutEntries, lootText, LootError } from '../core/loot.js';
import { stockCandidates, type GoodsKind } from '../core/shop.js';
import { signEvent, describeDirection, describeDistance } from '../core/vault.js';
import { allocateFlag, findFlag, SwitchError } from '../core/switches.js';
import {
  checkDatabaseRefs,
  DatabaseRefError,
  type DatabaseRow,
} from '../core/database-refs.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import { requireProjectSheets } from './map-ref-loaders.js';
import { findEntrance, REWARD_DATABASE, rewardsAlreadyOnMap } from './floor-lock-tools.js';
import { floorMask, eventSlots } from './stairs-tools.js';
import type { MapData } from '../schemas/map.js';
import type { Event } from '../schemas/event.js';
import type { Item } from '../schemas/database.js';
import { logger } from '../logger.js';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export function registerDungeonClimaxTools(server: McpServer): void {
  server.tool(
    'place_dungeon_climax',
    "Put something at a dungeon floor's far end — the tile link_dungeon_floors " +
      'finds and deliberately leaves clear. Finds the tightest chokepoint that ' +
      'still isolates that tile (the same reasoning lock_dungeon_floor uses, ' +
      'biased toward that one spot rather than the fairest split) and puts a ' +
      'guard, a lock, or both, in front of a reward behind it.',
    {
      mapId: z.number().int().positive().describe('The deepest floor'),
      entranceX: z.number().int().min(0).optional()
        .describe('Where the player arrives. Taken from a transfer event on the map if omitted.'),
      entranceY: z.number().int().min(0).optional(),
      floorKind: z.number().int()
        .min(getAutotileKind(TILE_ID_A2)).max(getAutotileKind(TILE_ID_A3) - 1).optional()
        .describe(
          'A2 material that counts as floor — pass the same one generate_map_layout and ' +
          'link_dungeon_floors were given. Without it floor and wall are told apart by the ' +
          'passage flags, and an A4 wall top is walkable in the RTP tilesets.'
        ),
      guardKind: z.enum(['boss', 'item', 'switch']).optional()
        .describe(
          'boss fights past the chokepoint; item puts a key in a chest on the near side; ' +
          'switch puts a lever there. Defaults to boss when troopId/troopName is given, item ' +
          'otherwise.'
        ),
      troopId: z.number().int().positive().optional().describe('Troop the guard fights'),
      troopName: z.string().optional().describe('Name of the troop, matched against Troops.json'),
      canEscape: z.boolean().default(false)
        .describe(
          'Off by default: fleeing leaves the guard standing exactly as losing does, which ' +
          'undersells a climax fight for the risk of nothing. See src/core/dungeon-climax.ts.'
        ),
      canLose: z.boolean().default(false)
        .describe('On sends a defeat to Scene_Gameover rather than resuming — off by default.'),
      challengeText: z.string().default('')
        .describe('Said once, Action Button, before the fight starts'),
      guardSprite: z.string().default(DEFAULT_GUARD_SHEET).describe('The guard\'s sprite sheet'),
      keyName: z.string().optional()
        .describe('Name of the key item (guardKind=item) or switch (guardKind=switch)'),
      keyId: z.number().int().positive().optional().describe('Use this existing item id as the key'),
      doorSprite: z.string().default('!Door1').describe('Door sprite sheet, for guardKind=item/switch'),
      leverSprite: z.string().default('!Switch1').describe('Lever sprite sheet, for guardKind=switch'),
      minChamberFraction: z.number().min(0.005).max(0.49).default(0.02)
        .describe(
          'Smallest the far chamber may be, as a fraction of the floor. Low by default: this ' +
          'looks for the tightest room around the far end, not an even split — lock_dungeon_floor ' +
          'is what wants a generous one.'
        ),
      hint: z.boolean().default(true)
        .describe('Put a sign near the chokepoint. Without one nothing tells the player anything is here.'),
      hintOnTouch: z.boolean().default(false).describe('Fire the sign by walking onto it rather than pressing'),
      rewardCount: z.number().int().min(0).max(10).default(2)
        .describe('Chests behind the chokepoint. A climax with nothing behind it is an anticlimax.'),
      rewardBand: z.array(z.number().min(0).max(1)).length(2).optional()
        .describe(
          'Slice of the tradeable price range the reward is drawn from. Defaults to [0.85, 1] — ' +
          'tighter than lock_dungeon_floor\'s [0.75, 1], since this is the floor\'s best reward, ' +
          'not one of several. A judgement, not a measurement — nothing in a project says what a ' +
          'dungeon\'s climax is worth.'
        ),
      rewardChestIndex: z.number().int().min(0).max(7).default(2)
        .describe('Slot of the chest sheet for the reward'),
      lockedText: z.string().optional().describe('What the door says when refused (guardKind=item/switch)'),
    },
    async (args) => {
      try {
        const project = requireProject();
        const dataPath = project.dataPath;

        const guardKind = args.guardKind ?? (args.troopId || args.troopName ? 'boss' : 'item');
        if (guardKind === 'boss' && !args.troopId && !args.troopName) {
          return errorResult('guardKind=boss needs troopId or troopName to say what the guard fights.');
        }
        if (guardKind === 'boss' && args.troopId !== undefined && args.troopName !== undefined) {
          return errorResult('Give troopId or troopName, not both — the one not read would be silent.');
        }
        if (guardKind !== 'boss' && (args.troopId || args.troopName)) {
          return errorResult(
            `troopId/troopName was given but guardKind is "${guardKind}" — pass guardKind=boss, ` +
            'or drop the troop.'
          );
        }

        await requireProjectSheets(project.path, [
          [guardKind === 'boss' ? args.guardSprite : undefined, 'guardSprite'],
          [guardKind === 'item' || guardKind === 'switch' ? args.doorSprite : undefined, 'doorSprite'],
          [guardKind === 'switch' ? args.leverSprite : undefined, 'leverSprite'],
        ]);

        const mapPath = path.join(dataPath, mapFilename(args.mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return errorResult(`Map ID ${args.mapId} not found.`);
        }
        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;
        const tileset = await TilesetReader.get(dataPath, mapData.tilesetId);
        const { floor, basis, note: floorNote } = floorMask(
          { data: mapData, flags: tileset.flags },
          args.floorKind
        );

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
              'way to tell which end is the near one. Pass entranceX/entranceY, or link the ' +
              'floor first with link_dungeon_floors.'
            );
          }
          entrance = found.slot;
          entranceFrom = found.from;
        }
        if (floor[entrance.y]?.[entrance.x] !== true) {
          return errorResult(
            `The entrance (${entrance.x}, ${entrance.y}) is not a tile the player can stand on.`
          );
        }

        // Existing events keep their tiles, and an existing lock is a wall for
        // this analysis — the same reasoning lock_dungeon_floor uses, so a
        // second climax call does not gate the same region twice.
        const taken: Slot[] = mapData.events.filter((e): e is Event => e !== null).map((e) => ({ x: e.x, y: e.y }));
        for (const event of mapData.events.filter((e): e is Event => e !== null)) {
          if (readLock(event.pages) === null) continue;
          if (floor[event.y]?.[event.x]) floor[event.y][event.x] = false;
        }

        // --- the far end link_dungeon_floors would have found ---
        let farEnd: Slot;
        try {
          farEnd = planStairEnds(floor, { blocked: eventSlots(mapData) }).exit;
        } catch (error) {
          if (error instanceof StairError) return errorResult(error.message);
          throw error;
        }

        // --- the tightest chamber that still contains it ---
        const plan = planClimaxLock(floor, {
          entrance,
          target: farEnd,
          blocked: taken,
          minSideFraction: args.minChamberFraction,
        });

        if (!plan) {
          const anySplit = findChokepoints(floor, { entrance, blocked: taken, minSideFraction: 0.005 });
          return errorResult(
            anySplit.length > 0
              ? `No chokepoint separates the far end (${farEnd.x}, ${farEnd.y}) from the ` +
                `entrance while staying under minChamberFraction=${args.minChamberFraction} — the ` +
                'floor loops back around it. Lower minChamberFraction, or this floor\'s far room ' +
                'is open enough that nothing short of the whole floor guards it.'
              : floorNote ??
                'No tile on this floor divides it at all: every part can be reached another way ' +
                'round, so a guard anywhere would be decoration.'
          );
        }

        // --- who or what stands there ---
        const notes: string[] = [];
        if (floorNote) notes.push(floorNote);

        let guard: Event;
        let openerNote: string | null = null;
        let resolvedTroopName: string | null = null;
        let resolvedTroopId: number | null = null;
        let lockKindLabel: string | null = null;
        let lockDataId: number | null = null;

        if (guardKind === 'boss') {
          const troopsRaw = (await FileHandler.readJsonRaw(
            path.join(dataPath, 'Troops.json')
          )) as (DatabaseRow | null)[];

          let checked;
          try {
            checked = checkDatabaseRefs(
              [
                {
                  type: 'battle_processing',
                  troopId: args.troopId,
                  troopName: args.troopName,
                  canEscape: args.canEscape,
                  canLose: args.canLose,
                },
              ],
              { troops: Array.isArray(troopsRaw) ? troopsRaw : undefined }
            );
          } catch (error) {
            if (error instanceof DatabaseRefError) return errorResult(error.message);
            throw error;
          }
          notes.push(...checked.notes);
          if (checked.troops.length > 0) resolvedTroopName = checked.troops[0].name;
          resolvedTroopId = checked.commands[0].troopId as number;

          guard = addEvent(mapData, (id) =>
            climaxGuardEvent(id, plan.door.x, plan.door.y, {
              troopId: resolvedTroopId!,
              canEscape: args.canEscape,
              canLose: args.canLose,
              characterName: args.guardSprite,
              challengeText: args.challengeText,
              name: `Guardian${id}`,
            })
          );
        } else {
          const defaultName = args.keyName ?? `Dungeon's End ${guardKind === 'item' ? 'Key' : 'Lever'}`;
          let dataId: number;
          let lockLabel: string;

          if (guardKind === 'item') {
            if (args.keyId !== undefined) {
              const items = (await FileHandler.readJsonRaw(
                path.join(dataPath, 'Items.json')
              )) as ({ name?: unknown } | null)[];
              const row = items[args.keyId];
              if (!row || typeof row.name !== 'string' || row.name.trim() === '') {
                return errorResult(`Item ${args.keyId} is not in Items.json, or has no name.`);
              }
              dataId = args.keyId;
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
                dataId = existing.id;
                lockLabel = existing.name;
              } else {
                const { id, entity } = await manager.create(keyItemFields({ name: defaultName }));
                dataId = id;
                lockLabel = entity.name;
                notes.push(`Key item ${id} "${entity.name}" was created.`);
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
              dataId = existing;
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
              dataId = allocated.id;
              lockLabel = defaultName;
              notes.push(`Switch ${allocated.id} was allocated as "${defaultName}".`);
            }
          }

          const sealing = rejectSealingSlots(floor, [plan.opener, plan.door], [true, true]);
          if (sealing.sealed.includes(0)) {
            return errorResult(
              `The best spot for the ${guardKind === 'item' ? 'key' : 'lever'}, ` +
              `(${plan.opener.x}, ${plan.opener.y}), would wall part of the near side off. Place ` +
              'it by hand with place_locked_door.'
            );
          }

          guard = addEvent(mapData, (id) =>
            lockedDoorEvent(id, plan.door.x, plan.door.y, {
              lock: { kind: guardKind, dataId },
              characterName: args.doorSprite,
              lockedText: args.lockedText ?? 'This is as far as the path goes without it.',
              name: `DungeonEnd${id}`,
            })
          );

          const opener =
            guardKind === 'item'
              ? addEvent(mapData, (id) =>
                  treasureEvent(id, plan.opener.x, plan.opener.y, {
                    loot: { kind: 'item', dataId, name: lockLabel, price: 0, amount: 1 },
                    text: `You found \\c[6]${lockLabel}\\c[0]!`,
                  })
                )
              : addEvent(mapData, (id) =>
                  leverEvent(id, plan.opener.x, plan.opener.y, {
                    switchId: dataId,
                    characterName: args.leverSprite,
                    name: `Lever${id}`,
                  })
                );
          if (guardKind === 'item') opener.name = `Key to ${guard.name}`;
          openerNote =
            `${guardKind === 'item' ? 'Key' : 'Lever'}: event ${opener.id} at ` +
            `(${plan.opener.x}, ${plan.opener.y}), on the near side.`;
          lockDataId = dataId;
          lockKindLabel = lockLabel;
        }

        // --- a reason to notice it ---
        let hintEvent: Event | null = null;
        if (args.hint) {
          const nearKeys = new Set(plan.near.map((s) => `${s.x},${s.y}`));
          const used = new Set(taken.map((s) => `${s.x},${s.y}`));
          if (guardKind !== 'boss') used.add(`${plan.opener.x},${plan.opener.y}`);
          const spot = plan.near
            .filter((s) => nearKeys.has(`${s.x},${s.y}`) && !used.has(`${s.x},${s.y}`))
            .sort(
              (a, b) =>
                Math.abs(a.x - plan.door.x) + Math.abs(a.y - plan.door.y) -
                (Math.abs(b.x - plan.door.x) + Math.abs(b.y - plan.door.y))
            )[0];

          if (spot) {
            const text =
              guardKind === 'boss'
                ? 'The corridor goes quiet here. Whatever this floor was built around is close.'
                : (() => {
                    const direction = describeDirection(plan.door, plan.opener);
                    const distance = describeDistance(plan.door, plan.opener);
                    const lead = guardKind === 'item'
                      ? `The last key lies ${distance} to the ${direction}.`
                      : `The mechanism stands ${distance} to the ${direction}.`;
                    return direction === 'right here'
                      ? 'This is the end of the path — almost.'
                      : `This is the end of the path — almost. ${lead}`;
                  })();
            hintEvent = addEvent(mapData, (id) =>
              signEvent(id, spot.x, spot.y, text, { trigger: args.hintOnTouch ? 1 : 0, name: `Inscription${id}` })
            );
          }
        }

        // --- the climax reward ---
        const rewardLines: string[] = [];
        let rewardNote: string | null = null;

        if (args.rewardCount > 0) {
          const pools: Record<string, ReturnType<typeof stockCandidates>> = {};
          for (const kind of ['item', 'weapon', 'armor'] as GoodsKind[]) {
            const file = path.join(dataPath, REWARD_DATABASE[kind]);
            if (!(await FileHandler.exists(file))) continue;
            const raw = await FileHandler.readJsonRaw(file);
            pools[kind] = Array.isArray(raw) ? stockCandidates(raw) : [];
          }

          const table = withoutEntries(
            buildLootTable(
              { items: pools.item, weapons: pools.weapon, armors: pools.armor },
              { priceBand: (args.rewardBand as [number, number] | undefined) ?? [0.85, 1] }
            ),
            rewardsAlreadyOnMap(mapData)
          );

          if (table.length === 0) {
            rewardNote =
              'Nothing was put behind it: every tradeable entry in that price band is already ' +
              'handed out somewhere on this map, or the databases hold nothing priced above zero.';
          } else {
            let dealt;
            try {
              dealt = dealLoot(table, args.rewardCount, args.mapId);
            } catch (error) {
              if (error instanceof LootError) return errorResult(error.message);
              throw error;
            }

            const spots = plan.rewardSpots.slice(0, dealt.length);
            const seal = rejectSealingSlots(floor, spots, spots.map(() => true));

            for (let i = 0; i < spots.length; i++) {
              if (!seal.kept.includes(i)) continue;
              const loot = dealt[i];
              const chest = addEvent(mapData, (id) =>
                treasureEvent(id, spots[i].x, spots[i].y, {
                  loot,
                  characterIndex: args.rewardChestIndex,
                  text: lootText(loot),
                })
              );
              chest.name = `Climax${chest.id}`;
              rewardLines.push(
                `  event ${chest.id} at (${spots[i].x}, ${spots[i].y}): ` +
                `${loot.kind} ${loot.dataId} "${loot.name}" (${loot.price})`
              );
            }
            if (spots.length < args.rewardCount) {
              rewardNote =
                `Only ${spots.length} of ${args.rewardCount} chest(s) fit in the chamber behind it.`;
            }
          }
        }

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(
          `Placed dungeon climax on map ${args.mapId}: ${guardKind} at (${plan.door.x}, ${plan.door.y})`
        );

        const total = plan.door.nearSize + plan.door.farSize + 1;
        const lines = [
          `Map ${args.mapId}'s climax is at (${plan.door.x}, ${plan.door.y}), guarding the far end ` +
          `(${farEnd.x}, ${farEnd.y}) link_dungeon_floors would leave clear — found by ${basis}.`,
          '',
          guardKind === 'boss'
            ? `Guard: event ${guard.id}, troop ${resolvedTroopId}` +
              (resolvedTroopName ? ` ("${resolvedTroopName}")` : '') +
              `. canEscape=${args.canEscape}, canLose=${args.canLose}.`
            : `Door: event ${guard.id}, opening on ${guardKind} ${lockDataId}` +
              (lockKindLabel ? ` ("${lockKindLabel}")` : '') + '.',
          `  ${plan.door.nearSize} of ${total} walkable tiles stay reachable; ${plan.door.farSize} ` +
          `are behind it (${(plan.door.farSize / total * 100).toFixed(1)}%).`,
          `Entrance taken from ${entranceFrom}: (${entrance.x}, ${entrance.y}).`,
        ];
        if (openerNote) lines.push('', openerNote);
        if (hintEvent) {
          lines.push(
            '',
            `Sign: event ${hintEvent.id} at (${hintEvent.x}, ${hintEvent.y}).`,
            `  "${hintEvent.pages[0].list.filter((c) => c.code === 401).map((c) => c.parameters[0]).join(' ')}"`
          );
        } else if (args.hint) {
          lines.push('', 'No room beside the chokepoint for a sign — every near tile next to it is taken.');
        }
        if (rewardLines.length > 0) {
          lines.push('', `Behind it, in the deepest reach of the ${plan.door.farSize} tiles it guards:`, ...rewardLines);
        }
        if (rewardNote) lines.push('', rewardNote);

        lines.push(
          '',
          guardKind === 'boss'
            ? 'The guard blocks the chokepoint in game until it is beaten — that is the point, ' +
              'but check_map_walkability will not show it: events standing on tiles are not ' +
              'treated as blocking there, so it reports the far side as reachable either way.'
            : 'The door tile is one whose loss would disconnect the floor, the same test ' +
              'decorate_dungeon uses to reject a prop, read the other way round.'
        );
        if (notes.length > 0) lines.push('', ...notes.map((n) => (n.startsWith('Note:') || n.startsWith('Warning:') ? n : `Note: ${n}`)));

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        if (error instanceof ClimaxError) return errorResult(error.message);
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
