import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileHandler } from '../core/file-handler.js';
import { requireProject } from './project-tools.js';
import { convertCommand, type Event, type EventCommand, type EventPage } from '../schemas/event.js';
import {
  CommandFlagError,
  describeResolutions,
  resolveCommandFlags,
  resolvePageConditions,
  unusableFlagIds,
  usesConditionName,
  usesFlagName,
  type RawPageConditions,
} from '../core/command-flags.js';
import { isUsableId, highestUsableId } from '../core/switches.js';
import { describePageConditions } from '../core/event-flow.js';
import {
  battleDesignationOf,
  checkEncounterSource,
  resolveBattleDesignation,
  resolveTransferDesignation,
  DesignationError,
} from '../core/designation.js';
import { surveyEncounterRegions } from '../core/encounters.js';
import { describeArrival, type ArrivalSurvey } from '../core/arrival.js';
import { resolveArrival } from './encounter-tools.js';
import { TilesetReader } from '../core/tileset-reader.js';
import {
  assignIndents,
  maxIndent,
  NestingError,
  type NestedCommand,
} from '../core/command-nesting.js';
import {
  checkDatabaseRefs,
  referencesDatabase,
  requirePageConditionRefs,
  DatabaseRefError,
  DATABASE_NAMES,
  type DatabaseName,
  type DatabaseTables,
} from '../core/database-refs.js';
import {
  checkMapRefs,
  referencesMap,
  requireCharacterSheet,
  transferTargets,
  MapRefError,
} from '../core/map-refs.js';
import { loadCharacterSheets, loadTransferInventory } from './map-ref-loaders.js';
import { defaultEventPage, endCommand } from '../templates/defaults.js';
import type { MapData } from '../schemas/map.js';
import { logger } from '../logger.js';

/** The System.json shape this file touches — the two names arrays. */
interface SystemFile {
  switches: string[];
  variables: string[];
  [key: string]: unknown;
}

function mapFilename(id: number): string {
  return `Map${String(id).padStart(3, '0')}.json`;
}

/** Which data file each database lives in. */
const DATABASE_FILES: Record<DatabaseName, string> = {
  troops: 'Troops.json',
  commonEvents: 'CommonEvents.json',
  items: 'Items.json',
  weapons: 'Weapons.json',
  armors: 'Armors.json',
  actors: 'Actors.json',
  classes: 'Classes.json',
  skills: 'Skills.json',
  states: 'States.json',
};

/** Cheap test for whether any table needs reading at all. */
function needsDatabaseCheck(cmd: Record<string, unknown>): boolean {
  return cmd.troopName !== undefined || referencesDatabase(cmd.type as string);
}

/**
 * Read the tables. A file that is missing or will not parse is left out, and
 * `checkDatabaseRefs` then makes no claim about it — degrading to "unchecked"
 * beats failing a whole command list over an unreadable Skills.json.
 */
async function loadDatabaseTables(dataPath: string): Promise<DatabaseTables> {
  const tables: DatabaseTables = {};
  await Promise.all(
    DATABASE_NAMES.map(async (name) => {
      try {
        const raw = await FileHandler.readJsonRaw(path.join(dataPath, DATABASE_FILES[name]));
        if (Array.isArray(raw)) tables[name] = raw as DatabaseTables[typeof name];
      } catch {
        // left undefined on purpose
      }
    })
  );
  return tables;
}

/**
 * The region ids a "same as random encounters" battle could actually draw on.
 *
 * Not simply what z=5 holds: `meetsEncounterConditions` tests the region under
 * the *player*, so an id painted only on walls, or only on floor cut off from
 * where they arrive, gates a row exactly as hard as an id that was never
 * painted. The reachable set comes from `surveyArrival`, so this agrees with
 * `set_map_encounters` given the same start — and derives the same one when
 * neither is given.
 *
 * A map whose data array is short of six planes reports no regions, which is
 * what `Game_Map.regionId` answers for it too.
 */
function reachableRegions(mapData: MapData, arrival: ArrivalSurvey): Set<number> {
  const survey = surveyEncounterRegions(mapData, arrival.reachable);
  return new Set([...survey.values()].filter((r) => r.reachable > 0).map((r) => r.regionId));
}

async function readMap(dataPath: string, mapId: number): Promise<MapData> {
  const mapPath = path.join(dataPath, mapFilename(mapId));
  return (await FileHandler.readJsonRaw(mapPath)) as MapData;
}

async function writeMap(dataPath: string, mapId: number, mapData: MapData): Promise<void> {
  const mapPath = path.join(dataPath, mapFilename(mapId));
  await FileHandler.writeJson(mapPath, mapData);
}

/**
 * Resolve a page's `conditions` argument into the full shape
 * `Game_Event.meetsConditions` reads, allocating any named switch/variable
 * and checking any item/actor id against the database — the same split
 * `add_event_commands` already makes between flag names (System.json) and
 * database rows (`checkDatabaseRefs`), just for one page's worth of fields
 * instead of a whole command list.
 *
 * Returns `undefined` when the caller gave no `conditions` at all, so
 * `create_event`/`update_event` can tell "leave this page's conditions
 * alone" apart from "`{}`", which sets every condition off.
 */
async function resolvePageConditionsForTool(
  project: ReturnType<typeof requireProject>,
  raw: RawPageConditions | undefined
): Promise<{ conditions: EventPage['conditions']; notes: string[] } | undefined> {
  if (raw === undefined) return undefined;
  const notes: string[] = [];

  let switches: string[] = [];
  let variables: string[] = [];
  let system: SystemFile | undefined;
  const systemPath = path.join(project.dataPath, 'System.json');

  if (usesConditionName(raw)) {
    system = (await FileHandler.readJsonRaw(systemPath)) as SystemFile;
    if (!Array.isArray(system.switches) || !Array.isArray(system.variables)) {
      throw new CommandFlagError(
        'System.json has no switches/variables arrays. Refusing to guess at one.'
      );
    }
    switches = system.switches;
    variables = system.variables;
  }

  const result = resolvePageConditions(raw, switches, variables);

  // Written before the map, so a name that resolved is a name that stays
  // resolved even if the map write then fails.
  if (result.changed && system !== undefined) {
    system.switches = result.switches;
    system.variables = result.variables;
    await FileHandler.writeJson(systemPath, system);
  }
  notes.push(...describeResolutions(result.resolutions));

  // A raw id past the end is only checkable when System.json was actually
  // read — an id-only caller with no System.json on disk keeps working, the
  // same degrade `add_event_commands` uses.
  if (system !== undefined) {
    const c = result.conditions;
    const checks: { active: boolean; id: number; kind: 'switch' | 'variable' }[] = [
      { active: c.switch1Valid, id: c.switch1Id, kind: 'switch' },
      { active: c.switch2Valid, id: c.switch2Id, kind: 'switch' },
      { active: c.variableValid, id: c.variableId, kind: 'variable' },
    ];
    for (const check of checks) {
      if (!check.active) continue;
      const names = check.kind === 'switch' ? result.switches : result.variables;
      if (isUsableId(names, check.id)) continue;
      notes.push(
        `Warning: ${check.kind} ${check.id} is past the end of System.json's ` +
          `${check.kind === 'switch' ? 'switches' : 'variables'} array, which reaches ` +
          `${highestUsableId(names)}. setValue is guarded by \`id < length\`, so this condition ` +
          `is permanently false. Allocate it first, or use ${
            check.kind === 'switch' ? 'switch1Name/switch2Name' : 'variableName'
          }.`
      );
    }
  }

  if (raw.itemId !== undefined || raw.actorId !== undefined) {
    const tables = await loadDatabaseTables(project.dataPath);
    requirePageConditionRefs(raw.itemId, raw.actorId, tables, 'conditions');
  }

  return { conditions: result.conditions, notes };
}

/**
 * A page's conditions, human-readable. Every field is optional and independent
 * — `Game_Event.meetsConditions` ANDs whichever kinds are `*Valid`, so naming
 * one kind does not require naming any other. switch1/switch2/variable can be
 * named instead of numbered, the same way `switchName`/`variableName` work on
 * `add_event_commands`: an existing flag of that name is reused, otherwise one
 * is allocated exactly as `allocate_switch` would.
 */
const conditionsSchema = z.object({
  switch1Id: z.number().int().positive().optional().describe('Switch 1 must be ON'),
  switch1Name: z.string().optional().describe('Named switch for condition 1'),
  switch2Id: z.number().int().positive().optional().describe('Switch 2 must be ON (ANDed with switch 1)'),
  switch2Name: z.string().optional().describe('Named switch for condition 2'),
  variableId: z.number().int().positive().optional().describe('Variable that must be >= variableValue'),
  variableName: z.string().optional().describe('Named variable for the variable condition'),
  variableValue: z.number().int().optional().describe('Threshold for the variable condition (default 0)'),
  selfSwitchCh: z.enum(['A', 'B', 'C', 'D']).optional().describe('Self-switch that must be ON'),
  itemId: z.number().int().positive().optional().describe('Item the party must be carrying'),
  actorId: z.number().int().positive().optional().describe('Actor that must be in the party'),
}).optional().describe(
  'Page conditions. Omitting this leaves the page\'s conditions untouched; passing {} clears ' +
  'every condition (an unconditioned page — always eligible). Naming a switch/variable/item/' +
  'actor is checked against the project before anything is written.'
);

export function registerEventTools(server: McpServer): void {
  // --- list_events ---
  server.tool(
    'list_events',
    'List all events on a specific map.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
    },
    async ({ mapId }) => {
      try {
        const project = requireProject();
        const mapData = await readMap(project.dataPath, mapId);

        const events = mapData.events.filter((e): e is Event => e !== null);
        if (events.length === 0) {
          return { content: [{ type: 'text' as const, text: `No events on map ${mapId}.` }] };
        }

        const lines = events.map((e) => {
          const pageCount = e.pages.length;
          return `[${e.id}] "${e.name}" at (${e.x}, ${e.y}) — ${pageCount} page(s)`;
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Events on map ${mapId} (${events.length}):\n${lines.join('\n')}`,
          }],
        };
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

  // --- create_event ---
  server.tool(
    'create_event',
    'Create a new event on a map at the specified position.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      name: z.string().describe('Event name'),
      x: z.number().int().min(0).describe('X position on map'),
      y: z.number().int().min(0).describe('Y position on map'),
      note: z.string().default('').describe('Event note'),
      characterName: z.string().optional().describe(
        'Character sprite name, without .png. Must be in img/characters — a missing sheet ' +
        'makes the whole map throw a LoadError on arrival. See list_character_sheets.'
      ),
      characterIndex: z.number().int().optional().describe('Character sprite index'),
      trigger: z.number().int().min(0).max(4).default(0)
        .describe('Trigger: 0=Action Button, 1=Player Touch, 2=Event Touch, 3=Autorun, 4=Parallel'),
      conditions: conditionsSchema,
    },
    async ({ mapId, name, x, y, note, characterName, characterIndex, trigger, conditions }) => {
      try {
        const project = requireProject();
        const mapData = await readMap(project.dataPath, mapId);

        if (characterName) {
          requireCharacterSheet(
            characterName,
            await loadCharacterSheets(project.path),
            'characterName'
          );
        }

        const resolvedConditions = await resolvePageConditionsForTool(project, conditions);

        // Find next event ID
        let newId = 1;
        for (let i = 1; i < mapData.events.length; i++) {
          if (mapData.events[i] !== null) newId = i + 1;
        }
        // Also check if we can reuse a null slot
        let slot = -1;
        for (let i = 1; i < mapData.events.length; i++) {
          if (mapData.events[i] === null) {
            slot = i;
            break;
          }
        }

        if (slot === -1) {
          slot = mapData.events.length;
          newId = slot;
        } else {
          newId = slot;
        }

        // Create default page
        const page = defaultEventPage();
        page.trigger = trigger;
        if (characterName) {
          page.image.characterName = characterName;
          page.image.characterIndex = characterIndex ?? 0;
        }
        if (resolvedConditions) page.conditions = resolvedConditions.conditions;

        const event: Event = {
          id: newId,
          name,
          note: note || '',
          pages: [page],
          x,
          y,
        };

        // Place event in array
        while (mapData.events.length <= slot) {
          mapData.events.push(null);
        }
        mapData.events[slot] = event;

        await writeMap(project.dataPath, mapId, mapData);
        await project.getVersionSync().bump();

        logger.info(`Event created: [${newId}] "${name}" on map ${mapId} at (${x}, ${y})`);

        const lines = [
          `Event created!`,
          '',
          `ID: ${newId}`,
          `Name: ${name}`,
          `Map: ${mapId}`,
          `Position: (${x}, ${y})`,
          `Trigger: ${trigger}`,
        ];
        if (resolvedConditions) {
          const summary = describePageConditions(page);
          lines.push(`Conditions: ${summary.length > 0 ? summary.join(' AND ') : '(none — always eligible)'}`);
          lines.push(...resolvedConditions.notes);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        if (error instanceof MapRefError || error instanceof CommandFlagError || error instanceof DatabaseRefError) {
          return { content: [{ type: 'text' as const, text: error.message }], isError: true };
        }
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

  // --- update_event ---
  server.tool(
    'update_event',
    'Update event properties (name, position, note) and one page\'s sprite, trigger and ' +
    'conditions.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      eventId: z.number().int().positive().describe('Event ID'),
      name: z.string().optional().describe('New event name'),
      x: z.number().int().optional().describe('New X position'),
      y: z.number().int().optional().describe('New Y position'),
      note: z.string().optional().describe('New event note'),
      pageIndex: z.number().int().min(0).default(0).describe(
        'Which page characterName/characterIndex/trigger/conditions apply to (0-based). Equal ' +
        'to the event\'s current page count to append a new page — pages are evaluated bottom-' +
        'to-top by the engine, first whose conditions hold wins, so a conditioned page belongs ' +
        'after its unconditioned fallback. Cannot skip ahead of the next free index.'
      ),
      characterName: z.string().optional().describe(
        'Character sprite name for pageIndex. Must be in img/characters — see ' +
        'list_character_sheets.'
      ),
      characterIndex: z.number().int().optional().describe('Character sprite index for pageIndex'),
      trigger: z.number().int().min(0).max(4).optional().describe(
        'Trigger for pageIndex: 0=Action Button, 1=Player Touch, 2=Event Touch, 3=Autorun, ' +
        '4=Parallel'
      ),
      conditions: conditionsSchema,
    },
    async ({ mapId, eventId, name, x, y, note, pageIndex, characterName, characterIndex, trigger, conditions }) => {
      try {
        const project = requireProject();
        const mapData = await readMap(project.dataPath, mapId);

        if (eventId >= mapData.events.length || !mapData.events[eventId]) {
          return {
            content: [{ type: 'text' as const, text: `Event ${eventId} not found on map ${mapId}.` }],
            isError: true,
          };
        }

        const event = mapData.events[eventId] as Event;
        if (name !== undefined) event.name = name;
        if (x !== undefined) event.x = x;
        if (y !== undefined) event.y = y;
        if (note !== undefined) event.note = note;

        if (pageIndex > event.pages.length) {
          return {
            content: [{
              type: 'text' as const,
              text: `pageIndex ${pageIndex} is past the end — event ${eventId} has ` +
                `${event.pages.length} page(s), so the next addable index is ${event.pages.length}. ` +
                'Pages are a dense array in order; there is no slot to leave empty ahead of one.',
            }],
            isError: true,
          };
        }

        const touchesPage =
          characterName !== undefined || characterIndex !== undefined ||
          trigger !== undefined || conditions !== undefined;
        const appending = pageIndex === event.pages.length;

        const resolvedConditions = await resolvePageConditionsForTool(project, conditions);

        if (touchesPage) {
          if (appending) event.pages.push(defaultEventPage());
          const page = event.pages[pageIndex];

          if (characterName !== undefined) {
            requireCharacterSheet(
              characterName,
              await loadCharacterSheets(project.path),
              'characterName'
            );
            page.image.characterName = characterName;
            if (characterIndex !== undefined) page.image.characterIndex = characterIndex;
          }
          if (trigger !== undefined) page.trigger = trigger;
          if (resolvedConditions) page.conditions = resolvedConditions.conditions;
        }

        await writeMap(project.dataPath, mapId, mapData);
        await project.getVersionSync().bump();

        const lines = [`Event ${eventId} on map ${mapId} updated.`];
        if (appending && touchesPage) lines.push(`Page ${pageIndex} added (now ${event.pages.length} page(s)).`);
        if (resolvedConditions) {
          const summary = describePageConditions(event.pages[pageIndex]);
          lines.push(
            `Page ${pageIndex} conditions: ` +
              (summary.length > 0 ? summary.join(' AND ') : '(none — always eligible)')
          );
          lines.push(...resolvedConditions.notes);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        if (error instanceof MapRefError || error instanceof CommandFlagError || error instanceof DatabaseRefError) {
          return { content: [{ type: 'text' as const, text: error.message }], isError: true };
        }
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

  // --- add_event_commands ---
  server.tool(
    'add_event_commands',
    `Add commands to an event page. Commands use human-readable format that gets converted to RPG Maker MZ codes.

Supported command types:
- show_text: { type: "show_text", face: "Actor1", faceIndex: 0, text: "Hello!" }
- show_choices: { type: "show_choices", choices: ["Yes", "No"] }
- transfer_player: { type: "transfer_player", mapId: 1, x: 5, y: 5 }  (the map must exist, the landing square must be inside it, and it must reach at least a quarter of the target map's largest walkable area — otherwise the transfer throws a LoadError, freezes the player, or strands them somewhere they can never walk out of)
- control_switches: { type: "control_switches", startId: 1, value: 0 }  (0=ON, 1=OFF)
- control_variables: { type: "control_variables", startId: 1, operationType: 0, operand: 0, value: 100 }
  (operand picks what fills the variable, and each one needs its own field(s) — a random
  assignment with only "value" and no "randomMax" used to silently set the variable to NaN:
    0 Constant:  value
    1 Variable:  sourceVariableId (copies another variable's current value)
    2 Random:    value (low end) and randomMax (high end), both inclusive
    3 Game Data: gameDataType (0 item, 1 weapon, 2 armor, 3 actor, 4 enemy, 5 character, 6
                 party, 7 other, 8 last action), plus gameDataParam1/gameDataParam2 to refine it
    4 Script:    script (a string, eval'd verbatim as the new value)
  )
- control_self_switch: { type: "control_self_switch", key: "A", value: 0 }
- conditional_branch: { type: "conditional_branch", conditionType: 0, param1: 1, param2: 0 }

Switches and variables can be named instead of numbered. control_switches and
conditional_branch (conditionType 0) take switchName; control_variables and
conditional_branch (conditionType 1) take variableName. An existing flag of that
name is reused, otherwise one is allocated exactly as allocate_switch would, and
the result says which id it got:
- { type: "control_switches", switchName: "Village gate open", value: 0 }
- { type: "conditional_branch", conditionType: 0, switchName: "Village gate open", param2: 0 }
A name on a command with no flag in it is refused rather than ignored.

Blocks nest. Indent is computed for you — the engine finds the end of a block by
indent alone, so it is never passed by hand. Close every block you open:
- conditional_branch ... [else] ... end_branch
- loop ... repeat_above   (break_loop jumps out)
- show_choices ... when_choice / when_cancel ... end_choices
- battle_processing ... if_win / if_escape / if_lose ... end_battle
  (arms run in that order; a bare battle_processing with no arms is fine.
   if_lose needs canLose: true, or a party wipe goes to Game Over and the
   arm can never run)

Any command naming a database row — a troop, common event, item, weapon,
armor, actor, class, skill or state — is checked against the project before
anything is written. The engine guards each of these lookups and then does
nothing when it fails, so a bad id is silent in play; this is the only place
it can be caught. battle_processing also takes troopName instead of troopId,
matched against Troops.json (a troop is content, not a slot, so an unknown
name is refused rather than created), and a troop with no members is refused
because the battle is won on its first frame.

battle_processing and transfer_player each carry a designation, which decides
whether the numbers after it are values or variable ids:
- battle: troopId / troopName (direct), troopVariableId / troopVariableName
  (read the troop id from a variable), or sameAsRandomEncounter: true (roll on
  this map's encounter table). Exactly one — the others would be written and
  never read. sameAsRandomEncounter is refused on a map whose encounterList
  cannot produce a troop, because makeEncounterTroopId then returns 0 and the
  battle silently does not happen. That check needs to know where the player
  can stand: it derives the arrival tiles from every Transfer Player aimed at
  this map plus the new game start, and startX/startY overrides that.
- transfer: mapId/x/y (direct), or mapVariableId/xVariableId/yVariableId — all
  three together, since the engine has one flag covering all three numbers.
  The *VariableName forms allocate the way switchName does.

  { type: "conditional_branch", conditionType: 0, switchName: "Gate open", param2: 0 },
  { type: "show_text", text: "It swings open." },
  { type: "else" },
  { type: "show_text", text: "It will not budge." },
  { type: "end_branch" }

An unbalanced list is refused, naming which block was left open and where.
- common_event: { type: "common_event", eventId: 1 }
- change_gold: { type: "change_gold", operation: 0, value: 100 }
- change_items: { type: "change_items", itemId: 1, operation: 0, value: 1 }
- play_bgm: { type: "play_bgm", name: "Town1", volume: 90 }
- play_se: { type: "play_se", name: "Decision1" }
- wait: { type: "wait", duration: 60 }
- fadeout_screen, fadein_screen, erase_event, game_over, return_to_title
- comment: { type: "comment", text: "This is a comment" }
- label/jump_to_label: { type: "label", name: "start" }
- And many more (change_hp, change_exp, battle_processing, shop_processing, etc.)`,
    {
      mapId: z.number().int().positive().describe('Map ID'),
      eventId: z.number().int().positive().describe('Event ID'),
      pageIndex: z.number().int().min(0).default(0).describe('Page index (0-based)'),
      commands: z.array(z.record(z.unknown())).describe('Array of command objects with "type" field'),
      append: z.boolean().default(true).describe('If true, append to existing commands. If false, replace all commands.'),
      startX: z.number().int().min(0).optional()
        .describe(
          'X of a tile the player is known to reach on this map. Only read by the ' +
          'sameAsRandomEncounter check, which has to know where the player can stand before it ' +
          'can say a region-scoped encounter row is dead. Without it the tile is derived from ' +
          'every Transfer Player in the project aimed at this map, plus the new game start; ' +
          'give it when that derivation would be wrong or when nothing transfers here yet.'
        ),
      startY: z.number().int().min(0).optional().describe('Y of that tile'),
    },
    async ({ mapId, eventId, pageIndex, commands, append, startX, startY }) => {
      try {
        const project = requireProject();
        if ((startX === undefined) !== (startY === undefined)) {
          return {
            content: [{ type: 'text' as const, text: 'Give both startX and startY, or neither.' }],
            isError: true,
          };
        }
        const mapData = await readMap(project.dataPath, mapId);

        if (eventId >= mapData.events.length || !mapData.events[eventId]) {
          return {
            content: [{ type: 'text' as const, text: `Event ${eventId} not found on map ${mapId}.` }],
            isError: true,
          };
        }

        const event = mapData.events[eventId] as Event;
        if (pageIndex >= event.pages.length) {
          return {
            content: [{ type: 'text' as const, text: `Page ${pageIndex} not found. Event has ${event.pages.length} page(s).` }],
            isError: true,
          };
        }

        for (const cmd of commands) {
          if (!cmd.type || typeof cmd.type !== 'string') {
            return {
              content: [{ type: 'text' as const, text: 'Each command must have a "type" field.' }],
              isError: true,
            };
          }
        }

        // Named flags become ids before conversion. System.json is only touched
        // when a name is actually used, so an id-only caller keeps working in a
        // project whose System.json is missing or unreadable.
        let resolved = commands as Record<string, unknown>[];
        const notes: string[] = [];
        const namesUsed = commands.some((cmd) => usesFlagName(cmd));

        if (namesUsed) {
          const systemPath = path.join(project.dataPath, 'System.json');
          const system = (await FileHandler.readJsonRaw(systemPath)) as SystemFile;
          if (!Array.isArray(system.switches) || !Array.isArray(system.variables)) {
            return {
              content: [{
                type: 'text' as const,
                text: 'System.json has no switches/variables arrays. Refusing to guess at one.',
              }],
              isError: true,
            };
          }

          let result;
          try {
            result = resolveCommandFlags(resolved, system.switches, system.variables);
          } catch (error) {
            if (error instanceof CommandFlagError) {
              return {
                content: [{ type: 'text' as const, text: error.message }],
                isError: true,
              };
            }
            throw error;
          }

          // Written before the map, so a name that resolved is a name that
          // stays resolved even if the map write then fails.
          if (result.changed) {
            system.switches = result.switches;
            system.variables = result.variables;
            await FileHandler.writeJson(systemPath, system);
          }
          resolved = result.commands;
          notes.push(...describeResolutions(result.resolutions));

          // An id past the end of the array is silently unwritable and reads as
          // false forever, so say it here — nothing at runtime will.
          const unusable = unusableFlagIds(resolved, result.switches, result.variables);
          for (const ref of unusable) {
            notes.push(
              `Warning: ${ref.kind} ${ref.id} is past the end of System.json's ` +
              `${ref.kind === 'switch' ? 'switches' : 'variables'} array, which reaches ` +
              `${ref.reach}. setValue is guarded by \`id < length\`, so that command does ` +
              'nothing and every condition reading it is false forever. Allocate it first, ' +
              `or use ${ref.kind === 'switch' ? 'switchName' : 'variableName'}.`
            );
          }
        }

        // Database rows next. The engine guards every one of these lookups and
        // then does nothing, so a bad id is invisible in play — this is the only
        // place it can be caught. Tables are loaded only when a command
        // actually names one, and one that will not parse is skipped rather
        // than failing the whole call.
        if (resolved.some((cmd) => needsDatabaseCheck(cmd))) {
          const tables = await loadDatabaseTables(project.dataPath);
          try {
            const checked = checkDatabaseRefs(resolved, tables);
            resolved = checked.commands;
            notes.push(...checked.notes);
            for (const troop of checked.troops) {
              notes.push(`Troop ${troop.id} "${troop.name}" was matched by name.`);
            }
          } catch (error) {
            if (error instanceof DatabaseRefError) {
              return {
                content: [{ type: 'text' as const, text: error.message }],
                isError: true,
              };
            }
            throw error;
          }
        }

        // Designation structure first: which source a command names is a
        // question about the command alone, and answering it before the
        // encounter table means a caller who gave two sources is told that,
        // rather than being told the table is empty.
        try {
          for (let i = 0; i < resolved.length; i++) {
            const cmd = resolved[i];
            if (cmd.type === 'battle_processing') resolveBattleDesignation(cmd, i);
            if (cmd.type === 'transfer_player') resolveTransferDesignation(cmd, i);
          }
        } catch (error) {
          if (error instanceof DesignationError) {
            return {
              content: [{ type: 'text' as const, text: error.message }],
              isError: true,
            };
          }
          throw error;
        }

        // A "same as random encounters" battle takes its troop from *this*
        // map's encounter table, so the map being written is the one to check.
        // Every map on this machine ships an empty list, which is why an
        // unusable table is a refusal rather than a note.
        try {
          const fromEncounters = resolved.some(
            (cmd) => cmd.type === 'battle_processing' && battleDesignationOf(cmd) === 2
          );
          const troopRows = fromEncounters
            ? ((await loadDatabaseTables(project.dataPath)).troops ?? [])
            : [];
          // Only derived when a designation-2 battle is actually present: it
          // reads every map in the project to find what transfers here, which
          // is 14 ms for 64 maps and not worth paying on an ordinary write.
          const arrival = fromEncounters
            ? await resolveArrival(
                project.dataPath,
                mapId,
                mapData,
                (await TilesetReader.get(project.dataPath, mapData.tilesetId)).flags,
                startX,
                startY
              )
            : undefined;
          const regions = arrival ? reachableRegions(mapData, arrival) : new Set<number>();
          if (arrival) notes.push(describeArrival(arrival));

          for (let i = 0; i < resolved.length; i++) {
            const cmd = resolved[i];
            if (cmd.type !== 'battle_processing' || battleDesignationOf(cmd) !== 2) continue;
            const check = checkEncounterSource(
              mapData.encounterList,
              regions,
              i,
              mapId,
              troopRows.length === 0
                ? undefined
                : (troopId) => troopId > 0 && troopId < troopRows.length && !!troopRows[troopId]
            );
            notes.push(
              `Encounters: ${check.usable} of ${mapData.encounterList.length} row(s) on map ` +
              `${mapId} can be picked, every ${mapData.encounterStep} steps.`,
              ...check.notes
            );
          }
        } catch (error) {
          if (error instanceof DesignationError) {
            return {
              content: [{ type: 'text' as const, text: error.message }],
              isError: true,
            };
          }
          throw error;
        }

        // Then the references the map itself carries. A transfer to a map with
        // no file does not fail quietly the way a database row does — the load
        // 404s and the next isMapLoaded() throws a LoadError, so the player
        // gets the engine error screen part-way through the transfer.
        if (resolved.some((cmd) => referencesMap(cmd.type as string))) {
          try {
            const inventory = await loadTransferInventory(
              project.dataPath,
              transferTargets(resolved)
            );
            notes.push(...checkMapRefs(resolved, inventory).notes);
          } catch (error) {
            if (error instanceof MapRefError) {
              return {
                content: [{ type: 'text' as const, text: error.message }],
                isError: true,
              };
            }
            throw error;
          }
        }

        // Work out the block structure before converting. Indent is the only
        // thing the engine uses to find the end of a branch, so this is what
        // decides whether a conditional_branch gates anything at all.
        let placed;
        try {
          placed = assignIndents(resolved as NestedCommand[]);
        } catch (error) {
          if (error instanceof NestingError) {
            return {
              content: [{ type: 'text' as const, text: error.message }],
              isError: true,
            };
          }
          throw error;
        }

        // Convert human-readable commands to RPG Maker MZ format. A source
        // command can expand to several (a message is a 101 and its 401 body
        // lines); all of them belong at the indent the source command got, or
        // the body would fall out of its own block.
        const convertedCommands: EventCommand[] = [];
        try {
          for (const { command, indent } of placed) {
            const converted = convertCommand(command as { type: string; [key: string]: unknown });
            for (const c of converted) convertedCommands.push({ ...c, indent });
          }
        } catch (error) {
          if (error instanceof DesignationError) {
            return {
              content: [{ type: 'text' as const, text: error.message }],
              isError: true,
            };
          }
          throw error;
        }

        const deepest = maxIndent(placed);
        if (deepest > 0) {
          notes.push(
            `Nesting: ${deepest} level(s) deep. The engine finds the end of a block by indent ` +
            '(Game_Interpreter.skipBranch), so this is what makes the branch gate.'
          );
        }

        const page = event.pages[pageIndex];
        if (append) {
          // Remove the end command (code 0), append new commands, then add end back
          const existing = page.list.filter((c) => c.code !== 0);
          page.list = [...existing, ...convertedCommands, endCommand()];
        } else {
          page.list = [...convertedCommands, endCommand()];
        }

        // Auto-add blank page for Autorun/Parallel events that set a self switch
        // Without this, the event loops forever after the self switch is set
        let autoPageAdded = false;
        if (page.trigger === 3 || page.trigger === 4) {
          const selfSwitchCmd = page.list.find((c) => c.code === 123);
          if (selfSwitchCmd) {
            const switchKey = selfSwitchCmd.parameters[0] as string;
            const hasFollowup = event.pages.some((p, idx) =>
              idx !== pageIndex && p.conditions?.selfSwitchValid && p.conditions?.selfSwitchCh === switchKey
            );
            if (!hasFollowup) {
              const blankPage = defaultEventPage();
              blankPage.conditions.selfSwitchCh = switchKey;
              blankPage.conditions.selfSwitchValid = true;
              blankPage.trigger = 0;
              event.pages.push(blankPage);
              autoPageAdded = true;
            }
          }
        }

        await writeMap(project.dataPath, mapId, mapData);
        await project.getVersionSync().bump();

        logger.info(`Added ${convertedCommands.length} command(s) to event ${eventId} page ${pageIndex} on map ${mapId}`);

        let msg = `Added ${convertedCommands.length} command(s) to event ${eventId}, page ${pageIndex} on map ${mapId}.`;
        if (autoPageAdded) {
          msg += `\n\nNote: Auto-added a blank page (self switch condition) to prevent autorun loop.`;
        }
        if (notes.length > 0) {
          msg += `\n\n${notes.join('\n')}`;
        }

        return {
          content: [{
            type: 'text' as const,
            text: msg,
          }],
        };
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

  // --- delete_event ---
  server.tool(
    'delete_event',
    'Delete an event from a map.',
    {
      mapId: z.number().int().positive().describe('Map ID'),
      eventId: z.number().int().positive().describe('Event ID to delete'),
    },
    async ({ mapId, eventId }) => {
      try {
        const project = requireProject();
        const mapData = await readMap(project.dataPath, mapId);

        if (eventId >= mapData.events.length || !mapData.events[eventId]) {
          return {
            content: [{ type: 'text' as const, text: `Event ${eventId} not found on map ${mapId}.` }],
            isError: true,
          };
        }

        const eventName = (mapData.events[eventId] as Event).name;
        mapData.events[eventId] = null;

        await writeMap(project.dataPath, mapId, mapData);
        await project.getVersionSync().bump();

        logger.info(`Event deleted: [${eventId}] "${eventName}" from map ${mapId}`);

        return {
          content: [{
            type: 'text' as const,
            text: `Event ${eventId} ("${eventName}") deleted from map ${mapId}.`,
          }],
        };
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
