import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { readLayer, writeLayer, hasTileBelow, TILE_LAYERS } from '../core/map-layers.js';
import { applyPlacements, type Placement } from '../core/tile-batch.js';
import { loadTransparentObjectTiles } from '../core/tileset-image.js';
import { TilesetReader } from '../core/tileset-reader.js';
import {
  collectProps,
  findProps,
  propCells,
  propGaps,
  propPart,
  propShape,
  unknownSheets,
  PropError,
  type Prop,
} from '../core/props.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';
import { logger } from '../logger.js';

const MAX_LISTED = 200;

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function describe(prop: Prop): string {
  const size = `${prop.width}x${prop.height}`;
  const ragged = prop.cells.some((c) => !c) ? ' (ragged)' : '';
  return `${prop.name} [${size}${ragged}] ${prop.sheet} tile ${prop.topLeft}`;
}

async function loadMapAndTileset(mapId: number) {
  const project = requireProject();
  const mapPath = path.join(project.dataPath, mapFilename(mapId));
  if (!(await FileHandler.exists(mapPath))) return null;
  const mapData = (await FileHandler.readJsonRaw(mapPath)) as MapData;
  const tileset = await TilesetReader.get(project.dataPath, mapData.tilesetId);
  return { project, mapPath, mapData, tileset };
}

export function registerPropTools(server: McpServer): void {
  server.tool(
    'list_tileset_props',
    'List the named objects a map\'s tileset offers — barrels, signs, trees, ' +
      'windows, roofs — so they can be placed by name instead of by raw tile id. ' +
      'The names are the editor\'s own: RPG Maker ships a label for every tile ' +
      'beside each tileset image, and a prop is a run of tiles sharing one label.',
    {
      mapId: z.number().int().positive()
        .describe('Map ID — the tileset is taken from the map'),
      search: z.string().optional()
        .describe(
          'Filter by name. An exact match wins outright, so "Tree" gives the tree rather than ' +
          'every name containing it; anything else matches as a substring.'
        ),
      minSize: z.number().int().min(1).default(1)
        .describe('Only props covering at least this many tiles. 2 hides the 1x1 clutter.'),
    },
    async ({ mapId, search, minSize }) => {
      try {
        const loaded = await loadMapAndTileset(mapId);
        if (!loaded) return errorResult(`Map ID ${mapId} not found.`);
        const { mapData, tileset } = loaded;

        const all = collectProps(tileset.tilesetNames);
        const unknown = unknownSheets(tileset.tilesetNames);

        if (all.length === 0) {
          return errorResult(
            `No named props for tileset ${mapData.tilesetId} "${tileset.name}". Its object ` +
            `sheets (${unknown.join(', ') || 'none'}) are not in the catalogue, which covers the ` +
            'sheets shipped with the editor. Custom art has to be placed with raw tile ids ' +
            'through paint_tiles.'
          );
        }

        let matched = search ? findProps(all, search) : all;
        matched = matched.filter((p) => p.cells.filter(Boolean).length >= minSize);

        if (matched.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text:
                `Nothing matches${search ? ` "${search}"` : ''} in "${tileset.name}". ` +
                `The tileset has ${all.length} named props; call again without search to see them.`,
            }],
          };
        }

        const bySheet = new Map<string, Prop[]>();
        for (const prop of matched) {
          const list = bySheet.get(prop.sheet) ?? [];
          list.push(prop);
          bySheet.set(prop.sheet, list);
        }

        const lines = [
          `Props in tileset ${mapData.tilesetId} "${tileset.name}"` +
          (search ? ` matching "${search}"` : '') +
          ` — ${matched.length} of ${all.length}`,
        ];

        let shown = 0;
        for (const [sheet, props] of bySheet) {
          lines.push(`\n${sheet}:`);
          for (const prop of props) {
            if (shown >= MAX_LISTED) break;
            lines.push(`  ${describe(prop)}`);
            shown++;
          }
        }
        if (matched.length > shown) {
          lines.push(`\n... and ${matched.length - shown} more. Narrow it with search or minSize.`);
        }
        if (unknown.length > 0) {
          lines.push(
            `\nNot catalogued: ${unknown.join(', ')} — custom or DLC art, which has to go ` +
            'through paint_tiles as raw tile ids.'
          );
        }
        lines.push(
          '\nA name can cover an object together with its filler variants: "Tree" on Outside_B ' +
          'is a 1x2 tree plus a canopy filler beside it, "Large Tree" a 2x2 tree plus the mass ' +
          'that fills the middle of a grove. Anything bigger than about 1x2 is worth checking ' +
          'with place_prop\'s part argument rather than stamping whole.'
        );

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'place_prop',
    'Place a named object from the tileset at a position — one call for the ' +
      'whole thing, however many tiles it is made of. Use list_tileset_props to ' +
      'find names. Props are drawn over the ground rather than replacing it, so ' +
      'they go on an upper layer and need something painted beneath them.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      name: z.string()
        .describe('Prop name, as listed by list_tileset_props. Matched exactly first, then as a substring.'),
      x: z.number().int().min(0).describe('X of the prop\'s top-left tile'),
      y: z.number().int().min(0).describe('Y of the prop\'s top-left tile'),
      layer: z.number().int().min(0).max(TILE_LAYERS - 1).default(1)
        .describe(
          'Tile layer. Defaults to 1 — object tiles are cut out around their edges, so on ' +
          'layer 0 those edges show the map background as black.'
        ),
      part: z.object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }).optional()
        .describe(
          'Place only this sub-rectangle of the prop, in tiles from its top-left. This is how ' +
          'you take the tree out of "Tree" without its canopy filler: {x:0, y:0, width:1, height:2}.'
        ),
      skipOccupied: z.boolean().default(false)
        .describe('Only write cells that are currently empty on this layer.'),
      allowOverEmptyGround: z.boolean().default(false)
        .describe('Place the prop even where its cut-out cells have nothing painted beneath them.'),
    },
    async ({ mapId, name, x, y, layer, part, skipOccupied, allowOverEmptyGround }) => {
      try {
        const loaded = await loadMapAndTileset(mapId);
        if (!loaded) return errorResult(`Map ID ${mapId} not found.`);
        const { project, mapPath, mapData, tileset } = loaded;

        const all = collectProps(tileset.tilesetNames);
        const matched = findProps(all, name);

        if (matched.length === 0) {
          return errorResult(
            `No prop named "${name}" in tileset "${tileset.name}". Use list_tileset_props to see ` +
            `what it offers${unknownSheets(tileset.tilesetNames).length > 0 ? ', and note that some of its sheets are not catalogued' : ''}.`
          );
        }
        if (matched.length > 1) {
          return errorResult(
            `"${name}" matches ${matched.length} props — say which:\n` +
            matched.slice(0, 20).map((p) => `  ${describe(p)}`).join('\n') +
            (matched.length > 20 ? `\n  ... and ${matched.length - 20} more` : '')
          );
        }

        let prop = matched[0];
        try {
          if (part) prop = propPart(prop, part);
        } catch (error) {
          if (error instanceof PropError) return errorResult(error.message);
          throw error;
        }

        const cells = propCells(prop);

        if (x + prop.width > mapData.width || y + prop.height > mapData.height) {
          return errorResult(
            `"${prop.name}" is ${prop.width}x${prop.height} and would run off the ` +
            `${mapData.width}x${mapData.height} map at (${x}, ${y}). A clipped prop loses part ` +
            'of its picture, so this is refused rather than trimmed.'
          );
        }

        // Object tiles are cut out around their edges — the same failure mode as
        // a roof's sloped corner. Only the cells that are actually cut need
        // something beneath them, so measure the sheet rather than assume.
        const cut = await loadTransparentObjectTiles(
          project.path,
          prop.sheet,
          cells.map((c) => c.tileId)
        );

        const bare: string[] = [];
        for (const cell of cells) {
          if (cut && !cut.has(cell.tileId)) continue;
          if (!hasTileBelow(mapData, x + cell.dx, y + cell.dy, layer)) {
            bare.push(`(${x + cell.dx}, ${y + cell.dy})`);
          }
        }

        const notes: string[] = [];
        if (bare.length > 0 && !allowOverEmptyGround) {
          return errorResult(
            `${bare.length} cell(s) of "${prop.name}" are cut out and have nothing painted ` +
            `beneath them: ${bare.slice(0, 8).join(' ')}${bare.length > 8 ? ' ...' : ''}\n\n` +
            'They would show the map background, which renders black in game. Fill the ground ' +
            'first with fill_map_region on layer 0, drop to a lower layer, or pass ' +
            'allowOverEmptyGround if the holes are deliberate.'
          );
        }
        if (cut === null) {
          notes.push(
            `Could not read img/tilesets/${prop.sheet}.png, so the prop's cut-out cells were not ` +
            'checked against what is beneath them.'
          );
        }

        const placements: Placement[] = cells.map((c) => ({
          x: x + c.dx,
          y: y + c.dy,
          tileId: c.tileId,
        }));

        const result = applyPlacements(readLayer(mapData, layer), placements, {
          skipOccupied,
          // Object tiles carry no shapes; running the autotile pass over them
          // would only risk reshaping whatever else is on this layer.
          computeShapes: false,
        });
        writeLayer(mapData, layer, result.grid);

        await FileHandler.writeJson(mapPath, mapData);
        await project.getVersionSync().bump();

        logger.info(`Placed prop "${prop.name}" on map ${mapId} at (${x}, ${y}) layer ${layer}`);

        const shape = propShape(prop);
        const lines = [
          `Placed "${prop.name}" at (${x}, ${y}) on map ${mapId}, layer ${layer} — ` +
          `${result.painted} tile(s) from ${prop.sheet}.`,
        ];
        if (prop.width * prop.height > 1) {
          lines.push(`Footprint ${prop.width}x${prop.height}:`, ...shape.map((r) => `  ${r}`));
        }
        const gaps = propGaps(all, prop);
        if (gaps.length > 0) {
          lines.push(
            'Gaps in the footprint, left empty — the sheet gives those cells to another prop:',
            ...gaps.map((g) =>
              `  (${x + g.dx}, ${y + g.dy}) belongs to ${g.filledBy ? `"${g.filledBy}"` : 'no named prop'}`
            )
          );
        }
        if (result.skipped > 0) {
          lines.push(
            `Left ${result.skipped} already-occupied cell(s) untouched (skipOccupied) — the prop ` +
            'is incomplete.'
          );
        }
        if (result.overwritten > 0) {
          lines.push(`Replaced ${result.overwritten} tile(s) already on layer ${layer}.`);
        }
        lines.push(...notes.map((n) => `\nNote: ${n}`));

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
