import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { standableGrid, canPass, type Direction } from '../core/walkability.js';
import { addEvent } from '../core/building-placement.js';
import { isDoorEvent } from '../core/blueprint.js';
import {
  npcEvent,
  planNpcPlacement,
  charactersOnSheet,
  isBigCharacterSheet,
  isObjectCharacterSheet,
  NpcError,
  MOVE_TYPES,
  NPC_TRIGGERS,
  type MoveType,
  type NpcTrigger,
  type Slot,
  DEFAULT_NPC_SHEETS as DEFAULT_SHEETS,
  DEFAULT_NPC_DIALOGUE as DEFAULT_DIALOGUE,
} from '../core/npcgen.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';
import type { Event } from '../schemas/event.js';
import { logger } from '../logger.js';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export async function listCharacterSheets(projectPath: string): Promise<string[]> {
  try {
    const files = await fs.readdir(path.join(projectPath, 'img', 'characters'));
    return files.filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, '')).sort();
  } catch {
    return [];
  }
}

/** Tiles nothing may stand on: every event already placed, and every door's way in. */
function reservedTiles(mapData: MapData): Slot[] {
  const reserved: Slot[] = [];
  for (const event of mapData.events) {
    if (!event) continue;
    reserved.push({ x: event.x, y: event.y });
    if (isDoorEvent(event as Event)) reserved.push({ x: event.x, y: event.y + 1 });
  }
  return reserved;
}

export function registerNpcTools(server: McpServer): void {
  server.tool(
    'list_character_sheets',
    'List the character sprite sheets in the project, and how many characters ' +
      'each one holds. A name beginning with $ holds one big character; anything ' +
      'else holds eight in a 4x2 grid, so characterIndex runs 0-7. A leading ! ' +
      'marks an object sprite — doors, chests — drawn without a shadow.',
    {
      search: z.string().optional().describe('Filter by name, case-insensitive substring'),
      peopleOnly: z.boolean().default(true)
        .describe('Hide the ! object sheets, which are scenery rather than characters'),
    },
    async ({ search, peopleOnly }) => {
      try {
        const project = requireProject();
        let sheets = await listCharacterSheets(project.path);

        if (sheets.length === 0) {
          return errorResult(
            `No sprite sheets found in ${path.join(project.path, 'img', 'characters')}.`
          );
        }
        if (peopleOnly) sheets = sheets.filter((s) => !isObjectCharacterSheet(s));
        if (search) {
          const needle = search.toLowerCase();
          sheets = sheets.filter((s) => s.toLowerCase().includes(needle));
        }
        if (sheets.length === 0) {
          return { content: [{ type: 'text' as const, text: 'Nothing matches.' }] };
        }

        const lines = [`Character sheets (${sheets.length}):`];
        for (const sheet of sheets) {
          const count = charactersOnSheet(sheet);
          const tags = [
            isBigCharacterSheet(sheet) ? 'big' : null,
            isObjectCharacterSheet(sheet) ? 'object' : null,
          ].filter(Boolean);
          lines.push(
            `  ${sheet} — ${count} character(s), index 0${count > 1 ? `-${count - 1}` : ''}` +
            (tags.length > 0 ? ` [${tags.join(', ')}]` : '')
          );
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'place_npc',
    'Put one character on a map: a sprite, something to say, and how it moves. ' +
      'The page settings are the ones real projects use — Action Button, drawn at ' +
      'character level, idling in place.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      x: z.number().int().min(0).describe('X position'),
      y: z.number().int().min(0).describe('Y position'),
      name: z.string().default('NPC').describe('Event name, shown only in the editor'),
      characterName: z.string().describe('Sprite sheet — see list_character_sheets'),
      characterIndex: z.number().int().min(0).max(7).default(0)
        .describe('Which character on the sheet. Always 0 for a $ sheet.'),
      text: z.string().default('').describe('What they say. Wrapped and split into message boxes.'),
      faceName: z.string().optional().describe('Face sheet for the message box'),
      faceIndex: z.number().int().min(0).max(7).default(0).describe('Which face on that sheet'),
      trigger: z.enum(NPC_TRIGGERS as unknown as [string, ...string[]]).default('action')
        .describe('action = talk to them, touch = they speak when walked into'),
      movement: z.enum(MOVE_TYPES as unknown as [string, ...string[]]).default('fixed')
        .describe('fixed stands still, random wanders, toward walks at the player'),
      direction: z.number().int().default(2).describe('Facing: 2 down, 4 left, 6 right, 8 up'),
    },
    async (args) => {
      try {
        const { mapId, x, y } = args;
        const project = requireProject();
        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return errorResult(`Map ID ${mapId} not found.`);
        }
        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;

        if (x >= mapData.width || y >= mapData.height) {
          return errorResult(
            `(${x}, ${y}) is outside the ${mapData.width}x${mapData.height} map.`
          );
        }

        const sheets = await listCharacterSheets(project.path);
        if (sheets.length > 0 && !sheets.includes(args.characterName)) {
          return errorResult(
            `No sprite sheet named "${args.characterName}" in img/characters. ` +
            'Use list_character_sheets to see what the project has.'
          );
        }

        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);
        const standable = standableGrid(mapData, tileset.flags);
        const notes: string[] = [];
        if (!standable[y][x]) {
          notes.push(
            `(${x}, ${y}) is not a tile the player could stand on, so this NPC is standing in ` +
            'a wall. check_map_walkability reports that as event-on-wall.'
          );
        }

        let placed: Event;
        try {
          placed = addEvent(mapData, (id) =>
            npcEvent(id, x, y, args.name, {
              characterName: args.characterName,
              characterIndex: args.characterIndex,
              text: args.text,
              face: args.faceName ? { name: args.faceName, index: args.faceIndex } : undefined,
              trigger: args.trigger as NpcTrigger,
              movement: args.movement as MoveType,
              direction: args.direction,
            })
          );
        } catch (error) {
          if (error instanceof NpcError) return errorResult(error.message);
          throw error;
        }

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(`Placed NPC "${args.name}" on map ${mapId} at (${x}, ${y})`);

        const lines = [
          `Placed "${args.name}" as event ${placed.id} at (${x}, ${y}) on map ${mapId}.`,
          `Sprite ${args.characterName} index ${args.characterIndex}, ` +
          `${args.trigger === 'action' ? 'talks when spoken to' : 'speaks when walked into'}, ` +
          `${args.movement} movement.`,
        ];
        if (args.text) {
          const boxes = placed.pages[0].list.filter((c) => c.code === 101).length;
          lines.push(`Dialogue: ${boxes} message box(es).`);
        } else {
          lines.push('No dialogue: talking to them does nothing.');
        }
        lines.push(...notes.map((n) => `\nNote: ${n}`));

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'populate_map',
    'Scatter NPCs across a map\'s walkable ground. An NPC blocks the tile it ' +
      'stands on, so placement is checked for connectivity: nobody is put where ' +
      'standing would seal off part of the map, or in front of a door.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      count: z.number().int().min(1).max(200).default(8).describe('How many to place'),
      seed: z.number().int().default(1).describe('Same seed, same placement'),
      characterSheets: z.array(z.string()).optional()
        .describe(
          `Sprite sheets to draw from. Defaults to ${DEFAULT_SHEETS.join(', ')}; any the ` +
          'project does not have are skipped and reported.'
        ),
      dialogue: z.array(z.string()).optional()
        .describe(
          'Lines to give them, cycled. The built-in default is obvious placeholder text — ' +
          'pass your own for anything that matters.'
        ),
      movement: z.enum(MOVE_TYPES as unknown as [string, ...string[]]).default('fixed')
        .describe(
          'fixed stands still, random wanders. A wandering NPC can walk somewhere that seals ' +
          'a path at runtime, which the static check cannot see.'
        ),
      trigger: z.enum(NPC_TRIGGERS as unknown as [string, ...string[]]).default('action')
        .describe('action = talk to them, touch = they speak when walked into'),
      startX: z.number().int().min(0).optional()
        .describe('X of a tile the player reaches; connectivity is measured from it'),
      startY: z.number().int().min(0).optional().describe('Y of that tile'),
      namePrefix: z.string().default('Villager').describe('Event names, numbered from 1'),
    },
    async (args) => {
      try {
        const { mapId, count, seed, startX, startY } = args;

        if ((startX === undefined) !== (startY === undefined)) {
          return errorResult('Give both startX and startY, or neither.');
        }

        const project = requireProject();
        const mapPath = path.join(project.dataPath, mapFilename(mapId));
        if (!(await FileHandler.exists(mapPath))) {
          return errorResult(`Map ID ${mapId} not found.`);
        }
        const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;
        const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);

        const available = await listCharacterSheets(project.path);
        const wanted = args.characterSheets ?? DEFAULT_SHEETS;
        const sheets = wanted.filter((s) => available.length === 0 || available.includes(s));
        const missing = wanted.filter((s) => !sheets.includes(s));

        if (sheets.length === 0) {
          return errorResult(
            `None of ${wanted.join(', ')} are in img/characters. Use list_character_sheets to ` +
            'see what the project has, and pass characterSheets.'
          );
        }

        const standable = standableGrid(mapData, tileset.flags);
        const reference = startX !== undefined ? { x: startX, y: startY! } : undefined;
        if (reference && !standable[reference.y]?.[reference.x]) {
          return errorResult(
            `(${reference.x}, ${reference.y}) is not a tile the player can stand on, so it ` +
            'cannot anchor the connectivity check.'
          );
        }

        // Movement is directional, so "adjacent and standable" is not
        // "connected" — reachability has to go through the engine's own rule.
        const canStep = (ax: number, ay: number, bx: number, by: number): boolean => {
          const dx = bx - ax;
          const dy = by - ay;
          const d = (dx === 1 ? 6 : dx === -1 ? 4 : dy === 1 ? 2 : 8) as Direction;
          return canPass(mapData, tileset.flags, ax, ay, d);
        };

        const placement = planNpcPlacement(standable, {
          count,
          seed,
          blocked: reservedTiles(mapData),
          reference,
          canStep,
        });

        const dialogue = args.dialogue ?? DEFAULT_DIALOGUE;
        const placed: string[] = [];

        for (let i = 0; i < placement.placed.length; i++) {
          const slot = placement.placed[i];
          const sheet = sheets[i % sheets.length];
          const index = charactersOnSheet(sheet) === 1 ? 0 : (seed + i) % 8;
          const event = addEvent(mapData, (id) =>
            npcEvent(id, slot.x, slot.y, `${args.namePrefix} ${i + 1}`, {
              characterName: sheet,
              characterIndex: index,
              text: dialogue.length > 0 ? dialogue[i % dialogue.length] : '',
              trigger: args.trigger as NpcTrigger,
              movement: args.movement as MoveType,
            })
          );
          placed.push(`event ${event.id} "${event.name}" at (${slot.x}, ${slot.y}) — ${sheet}#${index}`);
        }

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(`Placed ${placed.length} NPC(s) on map ${mapId}`);

        const lines = [
          `Map ${mapId}: placed ${placed.length} of ${count} NPC(s).`,
          '',
          ...placed.map((p) => `  ${p}`),
        ];
        if (placement.rejected > 0) {
          lines.push(
            '',
            `${placement.rejected} tile(s) were passed over because standing there would have ` +
            'sealed off part of the map — a doorway, or a one-tile gap between buildings.'
          );
        }
        if (placement.ranOut) {
          lines.push(
            '',
            'The map ran out of tiles that could take an NPC without cutting something off.'
          );
        }
        if (missing.length > 0) {
          lines.push('', `Not in img/characters, so skipped: ${missing.join(', ')}.`);
        }
        if (!args.dialogue) {
          lines.push(
            '',
            'The dialogue is the built-in placeholder set. Pass `dialogue` to give them ' +
            'something worth reading.'
          );
        }
        if (args.movement === 'random') {
          lines.push(
            '',
            'These NPCs wander. The connectivity check only holds for where they start — a ' +
            'wandering NPC can stand in a doorway at runtime, which no static check can see.'
          );
        }
        lines.push(
          '',
          'Run check_map_walkability to confirm nothing ended up unreachable' +
          (reference ? ` (startX=${reference.x} startY=${reference.y})` : '') + '.'
        );

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
