import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { FLAG_STAR } from '../core/map-grid.js';
import {
  SLOTS,
  planTilesetPassage,
  applyTilesetPassage,
  setPassageFlags,
  catalogueSheetNames,
  describeFlag,
  normaliseFlags,
  PassageError,
  type PassageSpec,
} from '../core/passage.js';
import {
  getAutotileKind,
  makeAutotileId,
  SHAPES_PER_KIND,
  TILE_ID_A1,
  TILE_ID_MAX,
} from '../core/autotile.js';
import { collectProps, findProps, propCells } from '../core/props.js';
import { requireProject } from './project-tools.js';
import { logger } from '../logger.js';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/** Read Tilesets.json whole, so one entry can be replaced and the rest kept. */
async function readTilesets(dataPath: string): Promise<unknown[]> {
  const raw = await FileHandler.readJsonRaw(path.join(dataPath, 'Tilesets.json'));
  if (!Array.isArray(raw)) {
    throw new PassageError('Tilesets.json is not an array; refusing to write over it.');
  }
  return raw;
}

async function writeTilesets(dataPath: string, tilesets: unknown[]): Promise<void> {
  await FileHandler.writeJson(path.join(dataPath, 'Tilesets.json'), tilesets);
}

export function registerPassageTools(server: McpServer): void {
  server.tool(
    'configure_tileset_passage',
    'Write a tileset\'s passage flags from the configuration RPG Maker MZ ships ' +
      'for the same sheets — what makes walls actually block the player. Until ' +
      'this is done a generated map has geometry but no collision, which ' +
      'check_project reports as tileset-passage-unconfigured. Which materials ' +
      'are solid cannot be derived from the image, so it is taken from the ' +
      'editor\'s own tilesets, matched sheet by sheet.',
    {
      tilesetId: z.number().int().positive().describe('Tileset ID to configure'),
      dryRun: z.boolean().default(false)
        .describe('Report what would change without writing anything'),
      slots: z.array(z.string()).optional()
        .describe(
          'Only these sheet slots, e.g. ["A2","B"]. Omitted does every slot the ' +
          'catalogue knows. Use this to keep passage you have configured by hand.'
        ),
    },
    async ({ tilesetId, dryRun, slots }) => {
      try {
        const project = requireProject();
        const tileset = await TilesetReader.get(project.dataPath, tilesetId);

        const wanted = slots?.map((s) => s.toUpperCase());
        if (wanted) {
          const valid = new Set(SLOTS.map((s) => s.name));
          const bad = wanted.filter((s) => !valid.has(s));
          if (bad.length > 0) {
            return errorResult(
              `Unknown slot(s): ${bad.join(', ')}. Valid slots are ${[...valid].join(', ')}.`
            );
          }
        }

        const full = planTilesetPassage(tileset.tilesetNames, tileset.flags);
        const plan = wanted
          ? { ...full, slots: full.slots.filter((s) => wanted.includes(s.slot.name)) }
          : full;
        const changed = plan.slots.reduce((total, s) => total + s.changed, 0);

        const before = normaliseFlags(tileset.flags);
        const wasConfigured = (before[0] & FLAG_STAR) !== 0;

        const lines = [
          `Tileset ${tilesetId} "${tileset.name}"`,
          '',
          wasConfigured
            ? 'Passage was already configured (tile 0 carries the star bit).'
            : 'Passage was NOT configured: tile 0 has no star bit, so every tile reported as ' +
              'walkable and nothing painted on any layer could block the player.',
          '',
        ];

        if (plan.slots.length === 0) {
          lines.push(
            'None of this tileset\'s sheets are in the catalogue, so nothing can be written.',
            '',
            'The catalogue is built from the sheets the editor ships. A project using its own ' +
            'art has to configure those sheets in the editor, or with set_tileset_passage.'
          );
          if (full.unknown.length > 0) {
            lines.push('', 'Sheets not in the catalogue: ' +
              full.unknown.map((u) => `${u.sheetName} (slot ${u.slot.name})`).join(', '));
          }
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }

        lines.push('Per slot:');
        for (const s of plan.slots) {
          lines.push(
            `  ${s.slot.name.padEnd(2)} ${s.sheetName.padEnd(28)} ` +
            `${String(s.changed).padStart(5)} of ${s.slot.count} tile(s) change` +
            (s.borrowedFromSlot ? `  [catalogued in slot ${s.borrowedFromSlot}]` : '')
          );
        }

        if (full.unknown.length > 0) {
          lines.push(
            '',
            'Left alone — not in the catalogue: ' +
            full.unknown.map((u) => `${u.sheetName} (slot ${u.slot.name})`).join(', ')
          );
        }
        if (full.empty.length > 0) {
          lines.push(`Empty slots: ${full.empty.map((s) => s.name).join(', ')}.`);
        }

        if (dryRun) {
          lines.push('', `Dry run: ${changed} tile(s) would change. Nothing was written.`);
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }

        const flags = applyTilesetPassage(tileset.flags, plan);
        const tilesets = await readTilesets(project.dataPath);
        const entry = tilesets[tilesetId] as { flags: number[] } | null;
        if (!entry) return errorResult(`Tileset ID ${tilesetId} not found in Tilesets.json.`);
        entry.flags = flags;
        await writeTilesets(project.dataPath, tilesets);
        await project.getVersionSync().bump();

        logger.info(`Configured passage for tileset ${tilesetId}: ${changed} tiles`);

        lines.push('', `Wrote ${changed} tile(s) to Tilesets.json.`);

        if ((flags[0] & FLAG_STAR) === 0) {
          // Tile 0 lives in slot B. If that sheet was unknown or excluded, the
          // tileset is still functionally unconfigured however much else landed.
          lines.push(
            '',
            'WARNING: tile 0 still has no star bit, so this tileset is still unconfigured and ' +
            'everything on it will report as walkable. Tile 0 belongs to slot B, which was ' +
            'not written — its sheet is not in the catalogue, or the slot was excluded. ' +
            'Set it directly with set_tileset_passage: tileIds [0], star true.'
          );
        } else if (!wasConfigured) {
          lines.push(
            '',
            'Tile 0 now carries the star bit, which is what lets empty upper layers fall ' +
            'through to the ground layer. Walls block from now on — get_map_grid and ' +
            'check_map_walkability will report differently on every map using this tileset, ' +
            'and maps that looked fine may now have unreachable areas worth checking.'
          );
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        if (error instanceof PassageError) return errorResult(error.message);
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'set_tileset_passage',
    'Set passage and terrain flags on chosen tiles of a tileset — for custom art ' +
      'the catalogue does not cover, or to correct what it wrote. Tiles are named ' +
      'by autotile material, by prop name, or by raw id. Passability is stated ' +
      'the way you mean it: passable true or false, not the inverted bit the file ' +
      'stores.',
    {
      tilesetId: z.number().int().positive().describe('Tileset ID to edit'),
      autotileKinds: z.array(z.number().int().min(0)).optional()
        .describe(
          'A1-A4 materials, by kind. Covers all 48 shapes of each, which is what the ' +
          'editor does — passage is per material, not per shape.'
        ),
      propNames: z.array(z.string()).optional()
        .describe('Objects by catalogue name, e.g. ["Barrel","Well"] — see list_tileset_props'),
      tileIds: z.array(z.number().int().min(0).max(TILE_ID_MAX - 1)).optional()
        .describe('Raw tile ids, for anything the other two cannot name'),
      passable: z.boolean().optional()
        .describe('Walk onto it from any direction, or from none'),
      down: z.boolean().optional().describe('Passable from below (moving up onto it)'),
      left: z.boolean().optional(),
      right: z.boolean().optional(),
      up: z.boolean().optional(),
      star: z.boolean().optional()
        .describe('[*] — this tile has no say in passage; the layer below decides'),
      ladder: z.boolean().optional(),
      bush: z.boolean().optional(),
      counter: z.boolean().optional(),
      damageFloor: z.boolean().optional(),
      terrainTag: z.number().int().min(0).max(7).optional(),
      dryRun: z.boolean().default(false).describe('Report without writing'),
    },
    async (args) => {
      try {
        const project = requireProject();
        const tileset = await TilesetReader.get(project.dataPath, args.tilesetId);

        // --- which tiles ---
        const targets = new Set<number>();
        const notes: string[] = [];

        for (const kind of args.autotileKinds ?? []) {
          const first = makeAutotileId(kind, 0);
          if (first < TILE_ID_A1 || first >= TILE_ID_MAX) {
            notes.push(`Autotile kind ${kind} is outside the A1-A4 range and was skipped.`);
            continue;
          }
          for (let shape = 0; shape < SHAPES_PER_KIND; shape++) targets.add(first + shape);
        }

        if ((args.propNames ?? []).length > 0) {
          const catalogue = collectProps(tileset.tilesetNames);
          for (const name of args.propNames ?? []) {
            const matches = findProps(catalogue, name);
            if (matches.length === 0) {
              notes.push(`"${name}" is not in this tileset, so nothing was set for it.`);
              continue;
            }
            for (const prop of matches) {
              for (const cell of propCells(prop)) targets.add(cell.tileId);
            }
          }
        }

        for (const id of args.tileIds ?? []) targets.add(id);

        if (targets.size === 0) {
          return errorResult(
            'No tiles selected. Give autotileKinds, propNames or tileIds.' +
            (notes.length > 0 ? `\n\n${notes.join('\n')}` : '')
          );
        }

        // --- what to set ---
        const spec: PassageSpec = {
          passable: args.passable, down: args.down, left: args.left,
          right: args.right, up: args.up, star: args.star, ladder: args.ladder,
          bush: args.bush, counter: args.counter, damageFloor: args.damageFloor,
          terrainTag: args.terrainTag,
        };
        if (Object.values(spec).every((v) => v === undefined)) {
          return errorResult(
            'Nothing to set. Give at least one of passable, down/left/right/up, star, ' +
            'ladder, bush, counter, damageFloor or terrainTag.'
          );
        }

        const ids = [...targets].sort((a, b) => a - b);
        const result = setPassageFlags(tileset.flags, ids, spec);

        const before = normaliseFlags(tileset.flags);
        const sample = ids.slice(0, 6).map((id) => {
          const kind = id >= TILE_ID_A1 ? ` (A kind ${getAutotileKind(id)})` : '';
          return `  tile ${id}${kind}: ${describeFlag(before[id])} -> ${describeFlag(result.flags[id])}`;
        });

        const lines = [
          `Tileset ${args.tilesetId} "${tileset.name}": ${ids.length} tile(s) selected, ` +
          `${result.changed} changed.`,
          '',
          ...sample,
        ];
        if (ids.length > sample.length) lines.push(`  ... and ${ids.length - sample.length} more`);
        if (notes.length > 0) lines.push('', ...notes.map((n) => `Note: ${n}`));

        if (args.dryRun) {
          lines.push('', 'Dry run: nothing was written.');
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }

        const tilesets = await readTilesets(project.dataPath);
        const entry = tilesets[args.tilesetId] as { flags: number[] } | null;
        if (!entry) return errorResult(`Tileset ID ${args.tilesetId} not found in Tilesets.json.`);
        entry.flags = result.flags;
        await writeTilesets(project.dataPath, tilesets);
        await project.getVersionSync().bump();

        logger.info(`Set passage on tileset ${args.tilesetId}: ${result.changed} tiles`);
        lines.push('', 'Written to Tilesets.json.');

        if ((result.flags[0] & FLAG_STAR) === 0) {
          lines.push(
            '',
            'WARNING: tile 0 still has no star bit, so passage resolves on the empty upper ' +
            'layers and everything reports as walkable regardless of what was just set. ' +
            'configure_tileset_passage fixes that, or set star on tile 0 here.'
          );
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        if (error instanceof PassageError) return errorResult(error.message);
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'list_passage_catalogue',
    'List the tileset sheets whose passage configuration is known, so you can ' +
      'tell before configuring whether a tileset is covered.',
    { search: z.string().optional().describe('Filter by name, case-insensitive substring') },
    async ({ search }) => {
      const names = catalogueSheetNames().filter(
        (n) => !search || n.toLowerCase().includes(search.toLowerCase())
      );
      const text = names.length === 0
        ? 'Nothing matches.'
        : `${names.length} sheet(s) with known passage flags:\n` +
          names.map((n) => `  ${n}`).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    }
  );
}
