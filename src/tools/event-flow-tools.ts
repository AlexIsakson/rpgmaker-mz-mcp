import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { renderEvent, renderEventOverview } from '../core/event-flow.js';
import { requireProject } from './project-tools.js';
import { mapFilename } from './map-tools.js';
import type { MapData } from '../schemas/map.js';
import type { Event } from '../schemas/event.js';

async function readMapOrThrow(dataPath: string, mapId: number): Promise<MapData> {
  const mapPath = path.join(dataPath, mapFilename(mapId));
  if (!(await FileHandler.exists(mapPath))) {
    throw new Error(`Map ID ${mapId} not found.`);
  }
  return (await FileHandler.readJsonRaw(mapPath)) as MapData;
}

function errorResult(error: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
    }],
    isError: true,
  };
}

export function registerEventFlowTools(server: McpServer): void {
  // --- describe_event ---
  server.tool(
    'describe_event',
    'Explain what an event actually does: every page with its trigger, the ' +
      'conditions gating it, the command flow in readable form, and the switches / ' +
      'variables / self-switches / common events / map transfers it touches.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      eventId: z.number().int().positive().describe('Event ID on that map'),
    },
    async ({ mapId, eventId }) => {
      try {
        const project = requireProject();
        const mapData = await readMapOrThrow(project.dataPath, mapId);

        const event = mapData.events.find(
          (e): e is Event => e !== null && e.id === eventId
        );
        if (!event) {
          return {
            content: [{ type: 'text' as const, text: `Event ID ${eventId} not found on map ${mapId}.` }],
            isError: true,
          };
        }

        return { content: [{ type: 'text' as const, text: renderEvent(event) }] };
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  // --- describe_map_events ---
  server.tool(
    'describe_map_events',
    'Overview of every event on a map: one line per page showing its trigger and ' +
      'the conditions under which it runs. Use describe_event for a full command dump.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      trigger: z.number().int().min(0).max(4).optional()
        .describe('Only show pages with this trigger: 0=Action Button, 1=Player Touch, 2=Event Touch, 3=Autorun, 4=Parallel'),
    },
    async ({ mapId, trigger }) => {
      try {
        const project = requireProject();
        const mapData = await readMapOrThrow(project.dataPath, mapId);

        let events = mapData.events.filter((e): e is Event => e !== null);

        if (trigger !== undefined) {
          events = events
            .map((e) => ({ ...e, pages: e.pages.filter((p) => p.trigger === trigger) }))
            .filter((e) => e.pages.length > 0);
        }

        if (events.length === 0) {
          const suffix = trigger !== undefined ? ` with trigger ${trigger}` : '';
          return { content: [{ type: 'text' as const, text: `No events on map ${mapId}${suffix}.` }] };
        }

        const header =
          trigger !== undefined
            ? `Events on map ${mapId} with trigger ${trigger} (${events.length}):`
            : `Events on map ${mapId} (${events.length}):`;

        return {
          content: [{
            type: 'text' as const,
            text: `${header}\n${renderEventOverview(events)}`,
          }],
        };
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
