import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TilesetReader } from '../core/tileset-reader.js';
import { loadA2Materials, type A2Material } from '../core/tileset-image.js';
import { FLAG_STAR } from '../core/map-grid.js';
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
