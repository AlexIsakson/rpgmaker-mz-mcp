import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { standableGrid } from '../core/walkability.js';
import { readLayer } from '../core/map-layers.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { addEvent } from '../core/building-placement.js';
import { npcEvent, NpcError } from '../core/npcgen.js';
import {
  shopCommands,
  selectStock,
  stockCandidates,
  describeGoods,
  ShopError,
  GOODS_KINDS,
  type Goods,
  type GoodsKind,
} from '../core/shop.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import { MapRefError } from '../core/map-refs.js';
import { requireProjectSheets } from './map-ref-loaders.js';
import type { MapData } from '../schemas/map.js';
import type { Event } from '../schemas/event.js';
import { logger } from '../logger.js';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

const DATABASE_FILE: Record<GoodsKind, string> = {
  item: 'Items.json',
  weapon: 'Weapons.json',
  armor: 'Armors.json',
};

const DEFAULT_GREETING: Record<string, string> = {
  general: 'Welcome! Have a look at what we have in.',
  weapon: 'Steel and edge, friend. What are you after?',
  armor: 'Nothing turns a blade like good plate. Take your pick.',
};

/** Which databases each preset draws from. */
const PRESET_KINDS: Record<string, GoodsKind[]> = {
  general: ['item'],
  weapon: ['weapon'],
  armor: ['armor'],
};

/**
 * Load a preset shop's stock from the project database.
 *
 * Shared with generate_town, which places a shop as part of the town rather
 * than leaving a caller to run place_shop against a coordinate it would have
 * to work out. Returns the refusal text instead of goods when the database has
 * nothing tradeable in it, so both callers phrase that failure the same way.
 */
export async function loadPresetStock(
  dataPath: string,
  preset: string,
  count: number,
  priceBand?: [number, number]
): Promise<{ goods: Goods[]; names: Map<string, string>; refusal: null } | { refusal: string }> {
  const names = new Map<string, string>();
  const kinds = PRESET_KINDS[preset] ?? PRESET_KINDS.general;
  const goods: Goods[] = [];

  for (const kind of kinds) {
    const file = path.join(dataPath, DATABASE_FILE[kind]);
    if (!(await FileHandler.exists(file))) continue;
    const raw = await FileHandler.readJsonRaw(file);
    const pool = Array.isArray(raw) ? stockCandidates(raw) : [];
    for (const e of pool) names.set(`${kind}:${e.id}`, e.name);
    goods.push(...selectStock(pool, kind, { count, priceBand }));
  }

  if (goods.length === 0) {
    return {
      refusal:
        `Nothing in ${kinds.map((k) => DATABASE_FILE[k]).join(' / ')} is tradeable: an entry ` +
        'needs a name and a price above zero. Window_ShopSell.isEnabled is ' +
        '`item && item.price > 0`, so a price of 0 already means "not tradeable" to the engine.',
    };
  }

  return { goods, names, refusal: null };
}

export const SHOP_GREETINGS = DEFAULT_GREETING;

export function registerShopTools(server: McpServer): void {
  server.tool(
    'place_shop',
    'Put a working shop on a map: a shopkeeper who greets the player and opens ' +
      'a buy/sell window stocked from the project\'s own database. Stock is ' +
      'chosen from what actually exists and has a price, so the shop never ' +
      'offers a separator row or an item that was deleted.',
    {
      mapId: z.number().int().positive().describe('Map to put the shop on'),
      x: z.number().int().min(0).describe('X of the shopkeeper'),
      y: z.number().int().min(0).describe('Y of the shopkeeper'),
      preset: z.enum(['general', 'weapon', 'armor']).default('general')
        .describe(
          'What the shop deals in. general sells items, weapon sells weapons, ' +
          'armor sells armour. Override with goods for an exact shelf.'
        ),
      count: z.number().int().min(1).max(40).default(6)
        .describe('How many things to stock, when the stock is chosen for you'),
      priceBand: z.array(z.number().min(0).max(1)).length(2).optional()
        .describe(
          'Slice of the price range to stock, as two fractions of the tradeable entries ' +
          'sorted by price. Defaults to [0, 0.5] — the cheaper half, a village store. ' +
          'Pass [0.5, 1] for a capital-city shop.'
        ),
      goods: z.array(z.object({
        kind: z.enum(GOODS_KINDS).describe('Which database the id is in'),
        dataId: z.number().int().positive().describe('Database id'),
        price: z.number().int().min(0).optional()
          .describe('Override the database price. Omit to charge what the item is worth.'),
      })).optional()
        .describe('Exact stock. Replaces preset/count/priceBand entirely.'),
      purchaseOnly: z.boolean().default(false)
        .describe('Buying only — the shop will not take the player\'s things off them'),
      greeting: z.string().optional()
        .describe('What the shopkeeper says before the window opens. Omit for a stock line.'),
      characterName: z.string().default('People1')
        .describe('Sprite sheet for the shopkeeper'),
      characterIndex: z.number().int().min(0).max(7).default(0),
      direction: z.number().int().refine((d) => [2, 4, 6, 8].includes(d), '2, 4, 6 or 8')
        .default(2).describe('2 down, 4 left, 6 right, 8 up'),
      name: z.string().optional().describe('Event name. Defaults to "Shop".'),
    },
    async (args) => {
      try {
        const { mapId, x, y } = args;
        const project = requireProject();
        await requireProjectSheets(project.path, [[args.characterName, 'characterName']]);

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

        // --- work out the stock ---
        const names = new Map<string, string>();
        let goods: Goods[];

        const loadCandidates = async (kind: GoodsKind) => {
          const file = path.join(project.dataPath, DATABASE_FILE[kind]);
          if (!(await FileHandler.exists(file))) return [];
          const raw = await FileHandler.readJsonRaw(file);
          const list = Array.isArray(raw) ? stockCandidates(raw) : [];
          for (const e of list) names.set(`${kind}:${e.id}`, e.name);
          return list;
        };

        if (args.goods && args.goods.length > 0) {
          // An explicit shelf still gets checked against the database: the
          // engine drops a row pointing at a missing id without a word, so a
          // typo here would show up as a shop that is quietly one item short.
          for (const kind of GOODS_KINDS) await loadCandidates(kind);
          const unknown = args.goods.filter((g) => !names.has(`${g.kind}:${g.dataId}`));
          if (unknown.length > 0) {
            return errorResult(
              `No such entries: ${unknown.map((g) => `${g.kind} ${g.dataId}`).join(', ')}. ` +
              'Window_ShopBuy.goodsToItem returns undefined for an id that is not in the ' +
              'database and makeItemList skips the row, so the shop would silently sell ' +
              'fewer things than asked for.'
            );
          }
          goods = args.goods.map((g) => ({
            kind: g.kind, dataId: g.dataId, price: g.price ?? null,
          }));
        } else {
          const kinds = PRESET_KINDS[args.preset];
          goods = [];
          for (const kind of kinds) {
            const pool = await loadCandidates(kind);
            goods.push(...selectStock(pool, kind, {
              count: args.count,
              priceBand: args.priceBand as [number, number] | undefined,
            }));
          }
          if (goods.length === 0) {
            return errorResult(
              `Nothing in ${kinds.map((k) => DATABASE_FILE[k]).join(' / ')} is tradeable: an ` +
              'entry needs a name and a price above zero. Window_ShopSell.isEnabled is ' +
              '`item.price > 0`, so a price of 0 already means "not tradeable" to the engine. ' +
              'Add priced entries, or pass goods to stock the shop by hand.'
            );
          }
        }

        // --- build the event ---
        let commands;
        try {
          commands = shopCommands(goods, args.purchaseOnly);
        } catch (error) {
          if (error instanceof ShopError) return errorResult(error.message);
          throw error;
        }

        const greeting = args.greeting ?? DEFAULT_GREETING[args.preset];
        let event: Event;
        try {
          event = npcEvent(0, x, y, args.name ?? 'Shop', {
            characterName: args.characterName,
            characterIndex: args.characterIndex,
            direction: args.direction,
            text: greeting,
            trigger: 'action',
            movement: 'fixed',
            commands,
          });
        } catch (error) {
          if (error instanceof NpcError) return errorResult(error.message);
          throw error;
        }

        const placed = addEvent(mapData, (id) => ({ ...event, id }));

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(`Placed shop event ${placed.id} on map ${mapId} at (${x}, ${y})`);

        // --- report, including whether the player can actually reach it ---
        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);
        const standable = standableGrid(mapData, tileset.flags);
        const approaches = [[0, 1], [0, -1], [1, 0], [-1, 0]].filter(([dx, dy]) => {
          const ax = x + dx;
          const ay = y + dy;
          return (
            ax >= 0 && ay >= 0 && ax < mapData.width && ay < mapData.height && standable[ay][ax]
          );
        });

        const lines = [
          `Shop event ${placed.id} on map ${mapId} at (${x}, ${y}), ${goods.length} row(s) of stock.`,
          '',
          ...describeGoods(goods, names).map((g) => `  ${g}`),
          '',
          args.purchaseOnly
            ? 'Purchase only: the shop will not buy anything off the player.'
            : 'The player can sell here as well as buy.',
          `Greeting: "${greeting}"`,
        ];

        if (approaches.length === 0) {
          lines.push(
            '',
            'Nothing next to this tile is standable, so the player can never trigger the ' +
            'shop. It is an Action Button event, which needs someone standing beside it. ' +
            'Move it against a floor tile, or check the tileset passage with check_project.'
          );
        }

        lines.push(
          '',
          'Prices with no override come from the database: Window_ShopBuy prices a row as ' +
          '`goods[2] === 0 ? item.price : goods[3]`, so the shop follows the item if you ' +
          'later reprice it.'
        );

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        if (error instanceof MapRefError) return errorResult(error.message);
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
