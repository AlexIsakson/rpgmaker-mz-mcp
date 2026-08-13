import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import {
  allocateFlag,
  releaseFlag,
  findFlag,
  freeSlots,
  namedFlags,
  highestUsableId,
  systemKey,
  SwitchError,
  FLAG_KINDS,
  type FlagKind,
} from '../core/switches.js';
import { requireProject } from './project-tools.js';
import { logger } from '../logger.js';

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

interface SystemFile {
  switches: string[];
  variables: string[];
  [key: string]: unknown;
}

async function readSystem(dataPath: string): Promise<SystemFile> {
  const raw = (await FileHandler.readJsonRaw(path.join(dataPath, 'System.json'))) as SystemFile;
  if (!Array.isArray(raw.switches) || !Array.isArray(raw.variables)) {
    throw new SwitchError(
      'System.json has no switches/variables arrays, or they are not arrays. Refusing to ' +
        'write over it.'
    );
  }
  return raw;
}

const plural = (kind: FlagKind) => (kind === 'switch' ? 'switches' : 'variables');

export function registerSwitchTools(server: McpServer): void {
  server.tool(
    'list_switches',
    'What the project\'s global switches and variables are called, which ids are ' +
      'free, and how far the arrays reach. The array length matters: setValue is ' +
      'guarded by `id < $dataSystem.switches.length`, so an id past the end is ' +
      'silently unwritable rather than an error.',
    {
      kind: z.enum(FLAG_KINDS).default('switch')
        .describe('switch or variable'),
      search: z.string().optional()
        .describe('Only names containing this, case-insensitive'),
      showFree: z.boolean().default(false)
        .describe('Also list the unnamed ids available to claim'),
    },
    async ({ kind, search, showFree }) => {
      try {
        const project = requireProject();
        const system = await readSystem(project.dataPath);
        const names = system[systemKey(kind)];

        const named = namedFlags(names).filter(
          (f) => !search || f.name.toLowerCase().includes(search.toLowerCase())
        );
        const free = freeSlots(names);

        const lines = [
          `${plural(kind)}: ${namedFlags(names).length} named, ${free.length} free, ` +
            `ids 1-${highestUsableId(names)} usable.`,
        ];

        if (named.length === 0) {
          lines.push(
            '',
            search ? `Nothing matches "${search}".` : `No ${plural(kind)} are named yet.`
          );
        } else {
          lines.push('');
          for (const f of named) lines.push(`  ${String(f.id).padStart(4)}  ${f.name}`);
        }

        if (showFree) {
          lines.push('');
          if (free.length === 0) {
            lines.push(
              `Every id is named. The next allocation extends the array, which is what makes ` +
              'the new id usable at all.'
            );
          } else {
            const shown = free.slice(0, 40).join(', ');
            lines.push(`Free: ${shown}${free.length > 40 ? `, ... (${free.length} total)` : ''}`);
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        if (error instanceof SwitchError) return errorResult(error.message);
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'allocate_switch',
    'Get an id for a named switch or variable, creating it if the project does ' +
      'not have one already. Asking twice for the same name gives the same id ' +
      'back, so a generator can call it every run without burning a new flag. ' +
      'The array is extended when it has to be — an id past the end of it is one ' +
      'the engine will not let anything write to.',
    {
      kind: z.enum(FLAG_KINDS).default('switch').describe('switch or variable'),
      name: z.string().min(1).describe('What the flag is for, e.g. "Village gate open"'),
      id: z.number().int().positive().optional()
        .describe(
          'Claim this exact id instead of the first free one. Refused if it already ' +
          'carries a different name.'
        ),
    },
    async ({ kind, name, id }) => {
      try {
        const project = requireProject();
        const system = await readSystem(project.dataPath);
        const key = systemKey(kind);

        let result;
        try {
          result = allocateFlag(system[key], name, id === undefined ? {} : { id });
        } catch (error) {
          if (error instanceof SwitchError) return errorResult(error.message);
          throw error;
        }

        if (!result.created && !result.grew) {
          // Report the *stored* name, not the one asked for. Matching ignores
          // case, so echoing the request back would misrepresent what is in the
          // file — "village GATE open" when System.json says "Village gate open".
          const stored = result.names[result.id];
          const note = stored === name ? '' : ` (asked for "${name}")`;
          return {
            content: [{
              type: 'text' as const,
              text:
                `${kind} ${result.id} is already "${stored}"${note} — handed back rather than ` +
                'allocating a second one.',
            }],
          };
        }

        system[key] = result.names;
        await FileHandler.writeJson(path.join(project.dataPath, 'System.json'), system);
        await project.getVersionSync().bump();

        logger.info(`Allocated ${kind} ${result.id}: ${name}`);

        const lines = [`${kind} ${result.id} = "${name}".`];
        if (result.grew) {
          lines.push(
            '',
            `The ${plural(kind)} array was extended to ${result.names.length} slots ` +
            `(ids 1-${highestUsableId(result.names)}). It had to be: setValue ignores any id ` +
            'that is not below the array length, so the flag would have been unwritable and ' +
            'permanently false without the extension.'
          );
        }
        lines.push(
          '',
          `Use it with control_${kind === 'switch' ? 'switches' : 'variables'} in ` +
          'add_event_commands, or as a page condition.'
        );

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        if (error instanceof SwitchError) return errorResult(error.message);
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool(
    'release_switch',
    'Take the name off a switch or variable so the id can be reused. The array ' +
      'keeps its length — shortening it would break every id above the one freed.',
    {
      kind: z.enum(FLAG_KINDS).default('switch').describe('switch or variable'),
      id: z.number().int().positive().optional().describe('Id to free'),
      name: z.string().optional().describe('Or name it instead of giving the id'),
    },
    async ({ kind, id, name }) => {
      try {
        if ((id === undefined) === (name === undefined)) {
          return errorResult('Give either id or name, not both and not neither.');
        }

        const project = requireProject();
        const system = await readSystem(project.dataPath);
        const key = systemKey(kind);
        const names = system[key];

        const target = id ?? findFlag(names, name!);
        if (target === null) {
          return errorResult(`No ${kind} is named "${name}".`);
        }

        const was = names[target];
        if (!was || was.trim() === '') {
          return errorResult(`${kind} ${target} has no name on it already.`);
        }

        try {
          system[key] = releaseFlag(names, target);
        } catch (error) {
          if (error instanceof SwitchError) return errorResult(error.message);
          throw error;
        }

        await FileHandler.writeJson(path.join(project.dataPath, 'System.json'), system);
        await project.getVersionSync().bump();

        logger.info(`Released ${kind} ${target} ("${was}")`);

        return {
          content: [{
            type: 'text' as const,
            text:
              `${kind} ${target} ("${was}") is free again.\n\n` +
              'Only the name was cleared. Any event still setting or reading that id now uses ' +
              'an unnamed flag, which check_project reports but the engine runs happily — ' +
              'search for it before reusing the slot.',
          }],
        };
      } catch (error) {
        if (error instanceof SwitchError) return errorResult(error.message);
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
