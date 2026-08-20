import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { loadA2Materials, type A2Material } from '../core/tileset-image.js';
import { FLAG_STAR } from '../core/map-grid.js';
import { describeA1Kind, A1_KIND_MAX } from '../core/water-autotile.js';
import { a1KindLabel } from '../core/a1-catalogue.js';
import { requireProject } from './project-tools.js';

/** Group consecutive kinds so the report reads as ranges rather than 32 lines. */
function describeGroup(materials: A2Material[]): string {
  return materials.map((m) => m.kind).join(', ');
}

export function registerTilesetTools(server: McpServer): void {
  server.tool(
    'describe_tileset_materials',
    'Inspect a tileset\'s A2 ground sheet and report, per material, whether it is ' +
      'safe to paint on layer 0 and whether it has a visible outline. Both come from ' +
      'the image, not the map data, and both vary between tilesets — so this is the ' +
      'catalogue to consult before choosing materials for a floor, a path or a patch.',
    {
      tilesetId: z.number().int().positive().describe('Tileset ID to inspect'),
    },
    async ({ tilesetId }) => {
      try {
        const project = requireProject();
        const tileset = await TilesetReader.get(project.dataPath, tilesetId);
        const materials = await loadA2Materials(project.path, tileset.tilesetNames);

        if (!materials) {
          return {
            content: [{
              type: 'text' as const,
              text:
                `Tileset ${tilesetId} "${tileset.name}" has no readable A2 sheet ` +
                `(expected img/tilesets/${tileset.tilesetNames[1] || '(unset)'}.png). ` +
                'Material advice is unavailable for this tileset.',
            }],
            isError: true,
          };
        }

        const ground = materials.filter((m) => m.opacity === 'ground');
        const overlay = materials.filter((m) => m.opacity === 'overlay');
        const empty = materials.filter((m) => m.opacity === 'empty');
        const seamless = ground.filter((m) => m.outline === 'seamless');
        const outlined = ground.filter((m) => m.outline === 'outlined');

        const lines = [
          `Tileset ${tilesetId} "${tileset.name}" — A2 sheet ${tileset.tilesetNames[1]}`,
          '',
          'Ground materials (opaque — safe as the base layer 0 fill):',
          `  seamless, no visible boundary: ${describeGroup(seamless) || 'none'}`,
          `  outlined, reads as a distinct patch or path: ${describeGroup(outlined) || 'none'}`,
          '',
          `Overlay materials (transparent edges — layer 1 or above, over a ground tile): ${describeGroup(overlay) || 'none'}`,
          `Effectively empty: ${describeGroup(empty) || 'none'}`,
          '',
          'How to choose:',
          '  - Base fill covering the whole map: any ground material; a seamless one is fine.',
          '  - A path, plaza or patch that should read as a distinct area: an *outlined*',
          '    material. A seamless one has edge pieces identical to its middle, so the',
          '    patch has no boundary and looks like a floating slab.',
          '  - Grass, hedges, fences, shallow water and similar: overlay materials. Painting',
          '    one on layer 0 leaves the map background showing through its edges, which',
          '    renders black in game.',
          '',
          'Per material:',
          '  kind  column  opacity   outline    centre/edge opaque   edge contrast',
        ];

        for (const m of materials) {
          lines.push(
            `  ${String(m.kind).padStart(4)}  ${String(m.column).padStart(6)}  ` +
            `${m.opacity.padEnd(8)}  ${m.outline.padEnd(9)}  ` +
            `${(m.centreOpacity * 100).toFixed(0).padStart(6)}% / ${(m.edgeOpacity * 100).toFixed(0).padStart(4)}%   ` +
            `${m.edgeContrast.toFixed(3)}`
          );
        }

        // --- A1 ---
        // The A1 section needs no image: which table a kind takes is arithmetic
        // on the tile id, so this holds for a sheet the RTP never shipped. Only
        // the *names* come from a catalogue, and it says so when it has none.
        const a1Sheet = tileset.tilesetNames[0] ?? '';
        lines.push('', `A1 water sheet ${a1Sheet || '(unset)'}`);
        if (!a1Sheet) {
          lines.push(
            '  This tileset has no A1 slot, so no A1 kind can be painted on it — ' +
            'fill_map_region refuses one rather than writing a tile that draws nothing.'
          );
        } else {
          const named = a1KindLabel(a1Sheet, 0) !== null;
          const waterfalls: string[] = [];
          const surprises: string[] = [];
          lines.push(
            '  kind  table       animates   name',
          );
          for (let kind = 0; kind <= A1_KIND_MAX; kind++) {
            const facts = describeA1Kind(kind);
            const label = a1KindLabel(a1Sheet, kind);
            lines.push(
              `  ${String(kind).padStart(4)}  ${facts.table.padEnd(10)}  ` +
              `${(facts.animated ? 'yes' : 'no').padEnd(9)}  ${label ?? '(name unknown)'}`
            );
            if (facts.table !== 'waterfall') continue;
            waterfalls.push(String(kind));
            if (label !== null && !/waterfall|fall/i.test(label)) {
              surprises.push(`${kind} "${label}"`);
            }
          }
          lines.push(
            '',
            `  Waterfall kinds: ${waterfalls.join(', ')}. These take WATERFALL_AUTOTILE_TABLE, ` +
            'which has four shapes rather than 48: only the left and right neighbours matter, ' +
            'so a fall repeats unchanged down its column and its animation runs vertically. ' +
            'Every other A1 kind is water and uses the ordinary floor table.',
            '  The engine picks the table from the *slot* — kind 4 and up, odd — and never from ' +
            'the art, so the name below is a description and not a promise.'
          );
          if (surprises.length > 0) {
            lines.push(
              `  On this sheet that bites: ${surprises.join(', ')} ` +
              `${surprises.length === 1 ? 'sits' : 'sit'} in a waterfall slot despite the name. ` +
              'Painting it gives waterfall behaviour.'
            );
          }
          if (!named) {
            lines.push(
              `  No name catalogue for "${a1Sheet}" — it is not one of the sheets the editor ` +
              'ships, so only the table and animation columns above are known for it.'
            );
          }
        }

        if (((tileset.flags[0] ?? 0) & FLAG_STAR) === 0) {
          lines.push(
            '',
            'WARNING: this tileset has no star bit on tile 0, so passage resolves on the ' +
              'empty upper layers and every tile reports as walkable — walls painted on ' +
              'any layer will not block the player. Configure the tileset in the editor, ' +
              'or copy the flags from a reference database.'
          );
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );
}
