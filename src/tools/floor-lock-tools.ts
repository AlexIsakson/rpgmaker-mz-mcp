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
import { buildLootTable, dealLoot, withoutEntries, lootText, LootError } from '../core/loot.js';
import { stockCandidates, type GoodsKind } from '../core/shop.js';
import {
  THEME_COPY,
  VAULT_THEMES,
  defaultTheme,
  hintText,
  signEvent,
  type VaultTheme,
} from '../core/vault.js';
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

const REWARD_DATABASE: Record<GoodsKind, string> = {
  item: 'Items.json',
  weapon: 'Weapons.json',
  armor: 'Armors.json',
};

/** Which database each Change command draws from. */
const GAIN_COMMANDS: Record<number, GoodsKind> = { 126: 'item', 127: 'weapon', 128: 'armor' };

/**
 * What this map already hands the player.
 *
 * Only *gains* count — `operateValue` negates when the operation is 1, so a
 * Change Items that takes something away (a door consuming its key) is not a
 * reward and must not stop the same entry being used as one.
 */
function rewardsAlreadyOnMap(mapData: MapData): { kind: GoodsKind; dataId: number }[] {
  const found: { kind: GoodsKind; dataId: number }[] = [];
  for (const event of mapData.events.filter((e): e is Event => e !== null)) {
    for (const page of event.pages) {
      for (const command of page.list) {
        const kind = GAIN_COMMANDS[command.code];
        if (!kind) continue;
        const dataId = command.parameters[0];
        if (typeof dataId !== 'number') continue;
        if (command.parameters[1] !== 0) continue;
        found.push({ kind, dataId });
      }
    }
  }
  return found;
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
      theme: z.enum(VAULT_THEMES).optional()
        .describe(
          'What the locked room is: treasury, armoury, storeroom, cell or crypt. Decides ' +
          'the key name, what the door says, what the inscription says, and which ' +
          'databases the reward is drawn from. Rotates per lock when omitted, so two ' +
          'rooms on one floor are two different rooms with two different keys.'
        ),
      hint: z.boolean().default(true)
        .describe(
          'Put an inscription near the door naming the direction the key actually went. ' +
          'Without one a player has no reason to think a key exists at all, and the lock ' +
          'is a wall they wander away from.'
        ),
      hintOnTouch: z.boolean().default(false)
        .describe(
          'Fire the inscription by walking onto it rather than pressing. Action Button is ' +
          'what 37 of 39 measured text events use, but a hint nobody presses is a hint ' +
          'that does not exist.'
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
      rewardCount: z.number().int().min(0).max(10).default(1)
        .describe(
          'Chests to put behind the door. A locked door with nothing behind it is a ' +
          'lock the player resents. 0 leaves the far side alone.'
        ),
      rewardBand: z.array(z.number().min(0).max(1)).length(2).optional()
        .describe(
          'Slice of the tradeable price range the reward is drawn from, as two fractions. ' +
          'Defaults to [0.75, 1] — the top quarter, against the [0.25, 0.75] an ordinary ' +
          'chest uses. That the reward should beat the corridor is a judgement, not a ' +
          'measurement: nothing in a project says what belongs behind a lock.'
        ),
      rewardChestIndex: z.number().int().min(0).max(7).default(1)
        .describe(
          'Slot of the chest sheet for the reward. The eight slots are colour variants ' +
          'rather than tiers — 0-3 and 7 ornate, 4-6 plain wood and steel — so this only ' +
          'has to differ from the 0 decorate_dungeon uses to read as not-one-of-the-others.'
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

        // --- what the room is for ---
        const theme: VaultTheme = args.theme ?? defaultTheme(existingLocks.length);
        const copy = THEME_COPY[theme];

        // --- the lock ---
        const defaultName =
          args.keyName ??
          (args.lockKind === 'item'
            ? copy.keyName
            : `${copy.keyName.replace(/ Key$/, '')} mechanism`);

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
            lockedText: args.lockedText ?? copy.lockedText,
            name: `${copy.doorName}${id}`,
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

        // --- a reason the door is there, and a lead to its key ---
        //
        // The inscription goes on the near side of the door, as close to it as
        // the floor allows: the player has to be standing in front of the lock
        // to wonder about it. It is priority 0 and blocks nothing, which is
        // what makes it safe this near a chokepoint.
        let hintEvent: Event | null = null;
        if (args.hint) {
          const nearKeys = new Set(plan.near.map((s) => `${s.x},${s.y}`));
          const used = new Set([
            ...taken.map((s) => `${s.x},${s.y}`),
            `${plan.opener.x},${plan.opener.y}`,
          ]);
          const spot = plan.near
            .filter((s) => nearKeys.has(`${s.x},${s.y}`) && !used.has(`${s.x},${s.y}`))
            .sort(
              (a, b) =>
                Math.abs(a.x - plan.door.x) + Math.abs(a.y - plan.door.y) -
                (Math.abs(b.x - plan.door.x) + Math.abs(b.y - plan.door.y))
            )[0];

          if (spot) {
            hintEvent = addEvent(mapData, (id) =>
              signEvent(
                id,
                spot.x,
                spot.y,
                hintText(theme, args.lockKind === 'item' ? 'key' : 'lever', plan.door, plan.opener),
                { trigger: args.hintOnTouch ? 1 : 0, name: `Inscription${id}` }
              )
            );
          }
        }

        // --- something worth finding behind it ---
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

          // The key itself was just added to the database with price 0, so
          // isTradeable already keeps it out of its own vault.
          const table = withoutEntries(
            buildLootTable(
              { items: pools.item, weapons: pools.weapon, armors: pools.armor },
              {
                priceBand: (args.rewardBand as [number, number] | undefined) ?? [0.75, 1],
                kinds: copy.rewardKinds,
              }
            ),
            rewardsAlreadyOnMap(mapData)
          );

          if (table.length === 0) {
            rewardNote =
              'Nothing was put behind the door: every tradeable entry in that price band is ' +
              'already handed out somewhere on this map, or the databases hold nothing priced ' +
              'above zero. Widen rewardBand, or add entries.';
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
              chest.name = `Reward${chest.id}`;
              rewardLines.push(
                `  event ${chest.id} at (${spots[i].x}, ${spots[i].y}): ` +
                `${loot.kind} ${loot.dataId} "${loot.name}" (${loot.price})`
              );
            }

            if (spots.length < args.rewardCount) {
              rewardNote =
                `Only ${spots.length} of ${args.rewardCount} chest(s) fit: the far side has ` +
                `${plan.rewardSpots.length} spot(s) that can hold one without blocking a way ` +
                'through.';
            }
          }
        }

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(
          `Locked map ${args.mapId}: door ${door.id} at (${plan.door.x}, ${plan.door.y}), ` +
          `opener ${opener.id} at (${plan.opener.x}, ${plan.opener.y})`
        );

        const total = plan.door.nearSize + plan.door.farSize + 1;
        const lines = [
          `Map ${args.mapId} now has ${copy.room} on it.`,
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

        if (hintEvent) {
          lines.push(
            '',
            `Inscription: event ${hintEvent.id} at (${hintEvent.x}, ${hintEvent.y}), beside the door.`,
            `  "${hintEvent.pages[0].list
              .filter((c) => c.code === 401)
              .map((c) => c.parameters[0])
              .join(' ')}"`,
            '',
            'The second sentence is derived from where the key actually went, not written in ' +
            'advance — it is the only claim on the map a player could catch out, and it cannot ' +
            'be wrong. Without it a locked door is a wall: nothing else in the game says a key ' +
            'exists at all.'
          );
        } else if (args.hint) {
          lines.push(
            '',
            'No room beside the door for an inscription — every near tile next to it is taken.'
          );
        }

        if (rewardLines.length > 0) {
          lines.push(
            '',
            `Behind the door, in the deepest dead end(s) of the ${plan.door.farSize} tiles it ` +
            'guards:',
            ...rewardLines,
            '',
            'Drawn from the top quarter of the tradeable price range, against the middle half ' +
            'an ordinary chest uses, and excluding anything this map already hands out — a ' +
            'reward that duplicates a chest in the corridor outside is worse than a small one.'
          );
        }
        if (rewardNote) lines.push('', rewardNote);

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
