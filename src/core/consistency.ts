import { buildMapGraph, type LoadedMap } from './map-graph.js';
import { extractCommonEventCalls } from './event-flow.js';
import type { Event, EventCommand, EventPage } from '../schemas/event.js';
import type { MapInfo } from '../schemas/map.js';

/**
 * Static consistency checks for RPG Maker MZ projects.
 *
 * Rules are deliberately conservative: a linter that cries wolf gets ignored.
 * Anything the engine can do through a Script or Plugin Command is invisible to
 * static analysis, so affected rules skip those events rather than guess.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  where?: string;
}

export interface CommonEventFull {
  id: number;
  name: string;
  trigger: number;
  switchId: number;
  list: EventCommand[];
}

export interface TilesetLike {
  id: number;
  name: string;
  flags: number[];
}

export interface ConsistencyInput {
  startMapId: number;
  maps: LoadedMap[];
  mapInfos: (MapInfo | null)[];
  commonEvents: CommonEventFull[];
  /** Command lists from troop pages (troop pages have no page conditions). */
  troopCommandLists: EventCommand[][];
  /** Switch IDs used by troop page conditions (Game_Troop.meetsConditions). */
  troopConditionSwitches: number[];
  tilesets: TilesetLike[];
  /**
   * Ids that exist in each database, for commands that point at one.
   *
   * Optional: a caller that cannot load the database files gets every other
   * rule and simply no database findings, rather than a wave of false
   * positives claiming everything is missing.
   */
  databaseIds?: DatabaseIds;
  /**
   * `System.switches` and `System.variables`.
   *
   * Two rules want them. Findings read far better with a name attached — "switch
   * 12" says nothing, "switch 12 (Met the mayor)" says which feature is broken —
   * and the array *lengths* are what `Game_Switches.setValue` bounds writes
   * against, so they are the only way to spot an id the engine ignores.
   */
  flagNames?: FlagNames;
}

export interface FlagNames {
  switches: string[];
  variables: string[];
}

export interface DatabaseIds {
  items: Set<number>;
  weapons: Set<number>;
  armors: Set<number>;
}

export interface ConsistencyReport {
  findings: Finding[];
  /** True when Script / Plugin Commands exist, making static results incomplete. */
  hasOpaqueCommands: boolean;
  checkedMaps: number;
  checkedEvents: number;
}

const FLAG_STAR = 0x10;

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/** Script (355/655) and Plugin Command (356/357) can do anything; treat as opaque. */
function listHasOpaqueCommands(list: EventCommand[]): boolean {
  return list.some((c) => c.code === 355 || c.code === 655 || c.code === 356 || c.code === 357);
}

/**
 * Variables referenced from message text via the \V[n] escape code. Without
 * this, display-only variables look "written but never read".
 */
function extractTextVariableReads(list: EventCommand[]): number[] {
  const out: number[] = [];
  for (const cmd of list) {
    if (cmd.code !== 401 && cmd.code !== 405 && cmd.code !== 402 && cmd.code !== 102) continue;
    const texts: string[] = [];
    for (const param of cmd.parameters) {
      if (typeof param === 'string') texts.push(param);
      else if (Array.isArray(param)) {
        for (const entry of param) if (typeof entry === 'string') texts.push(entry);
      }
    }
    for (const text of texts) {
      for (const match of text.matchAll(/\\V\[(\d+)\]/gi)) {
        out.push(Number(match[1]));
      }
    }
  }
  return out;
}

interface Usage {
  switchReads: Set<number>;
  switchWrites: Set<number>;
  variableReads: Set<number>;
  variableWrites: Set<number>;
}

function newUsage(): Usage {
  return {
    switchReads: new Set(),
    switchWrites: new Set(),
    variableReads: new Set(),
    variableWrites: new Set(),
  };
}

/** Switch/variable reads and writes performed by a bare command list. */
function scanUsage(list: EventCommand[], usage: Usage): void {
  for (const cmd of list) {
    const p = cmd.parameters;
    switch (cmd.code) {
      case 121:
        for (let id = asNumber(p[0]); id <= asNumber(p[1]); id++) usage.switchWrites.add(id);
        break;
      case 122:
        for (let id = asNumber(p[0]); id <= asNumber(p[1]); id++) usage.variableWrites.add(id);
        if (asNumber(p[3]) === 1) usage.variableReads.add(asNumber(p[4]));
        break;
      case 111: {
        const type = asNumber(p[0]);
        if (type === 0) usage.switchReads.add(asNumber(p[1]));
        else if (type === 1) {
          usage.variableReads.add(asNumber(p[1]));
          if (asNumber(p[2]) === 1) usage.variableReads.add(asNumber(p[3]));
        }
        break;
      }
    }
  }
  for (const id of extractTextVariableReads(list)) usage.variableReads.add(id);
}

function scanPageConditions(page: EventPage, usage: Usage): void {
  const c = page.conditions;
  if (c.switch1Valid) usage.switchReads.add(c.switch1Id);
  if (c.switch2Valid) usage.switchReads.add(c.switch2Id);
  if (c.variableValid) usage.variableReads.add(c.variableId);
}

/** Self-switches a command list writes directly (Control Self Switch). */
function directSelfSwitchWrites(list: EventCommand[]): string[] {
  return list.filter((c) => c.code === 123).map((c) => asString(c.parameters[0]));
}

/** Self-switches a command list reads (Conditional Branch type 2). */
function directSelfSwitchReads(list: EventCommand[]): string[] {
  return list
    .filter((c) => c.code === 111 && asNumber(c.parameters[0]) === 2)
    .map((c) => asString(c.parameters[1]));
}

/**
 * Transitive self-switch writes per common event. A called common event runs
 * with the *calling event's* eventId (Game_Interpreter.command117), so its
 * Control Self Switch writes the caller's self-switch.
 */
export function resolveCommonEventSelfSwitchWrites(
  commonEvents: CommonEventFull[]
): Map<number, { writes: Set<string>; opaque: boolean }> {
  const byId = new Map(commonEvents.map((ce) => [ce.id, ce]));
  const resolved = new Map<number, { writes: Set<string>; opaque: boolean }>();
  const inProgress = new Set<number>();

  function resolve(id: number): { writes: Set<string>; opaque: boolean } {
    const cached = resolved.get(id);
    if (cached) return cached;
    if (inProgress.has(id)) return { writes: new Set(), opaque: false }; // cycle guard

    const ce = byId.get(id);
    if (!ce) return { writes: new Set(), opaque: false };

    inProgress.add(id);
    const writes = new Set(directSelfSwitchWrites(ce.list));
    let opaque = listHasOpaqueCommands(ce.list);

    for (const calledId of extractCommonEventCalls(ce.list)) {
      const inner = resolve(calledId);
      for (const ch of inner.writes) writes.add(ch);
      if (inner.opaque) opaque = true;
    }

    inProgress.delete(id);
    const result = { writes, opaque };
    resolved.set(id, result);
    return result;
  }

  for (const ce of commonEvents) resolve(ce.id);
  return resolved;
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

const CODE_SHOP_PROCESSING = 302;
const CODE_SHOP_GOODS = 605;

/** `Window_ShopBuy.goodsToItem` switches on goods[0]. */
const GOODS_DATABASE = ['items', 'weapons', 'armors'] as const;

interface GoodsRow {
  database: (typeof GOODS_DATABASE)[number];
  dataId: number;
}

/**
 * Every goods row in a command list.
 *
 * `command302` takes its own parameters as the first row and then absorbs each
 * `605` that immediately follows, so a 605 is only a goods row when it is part
 * of such a run — the code is shared with other continuation commands.
 */
function extractShopGoods(list: EventCommand[]): GoodsRow[] {
  const rows: GoodsRow[] = [];

  const read = (parameters: unknown[]): void => {
    const kind = parameters[0];
    const dataId = parameters[1];
    if (typeof kind !== 'number' || typeof dataId !== 'number') return;
    const database = GOODS_DATABASE[kind];
    if (database) rows.push({ database, dataId });
  };

  for (let i = 0; i < list.length; i++) {
    if (list[i].code !== CODE_SHOP_PROCESSING) continue;
    read(list[i].parameters);
    for (let j = i + 1; j < list.length && list[j].code === CODE_SHOP_GOODS; j++) {
      read(list[j].parameters);
      i = j;
    }
  }

  return rows;
}

/** `command111` cases 8, 9 and 10 — the party-holds-this tests. */
const BRANCH_DATABASE: Record<number, (typeof GOODS_DATABASE)[number]> = {
  8: 'items',
  9: 'weapons',
  10: 'armors',
};

/**
 * Every conditional branch that asks whether the party holds a database entry.
 *
 * This is how a locked door is written — `itemValid`, the engine's page
 * condition for the same question, is used on none of the 544 event pages
 * measured — so a key that gets deleted turns into a branch that is false
 * forever: `hasItem(undefined)` goes through `numItems`, which answers 0.
 */
function extractHeldItemBranches(list: EventCommand[]): GoodsRow[] {
  const rows: GoodsRow[] = [];
  for (const cmd of list) {
    if (cmd.code !== 111) continue;
    const database = BRANCH_DATABASE[asNumber(cmd.parameters[0])];
    if (!database) continue;
    const dataId = cmd.parameters[1];
    if (typeof dataId !== 'number') continue;
    rows.push({ database, dataId });
  }
  return rows;
}

export function checkProject(input: ConsistencyInput): ConsistencyReport {
  const { startMapId, maps, mapInfos, commonEvents, troopCommandLists, troopConditionSwitches, tilesets } = input;

  const findings: Finding[] = [];
  const usage = newUsage();
  let hasOpaqueCommands = false;
  let checkedEvents = 0;

  const mapName = (id: number): string => mapInfos[id]?.name ?? `Map${id}`;
  const commonEventIds = new Set(commonEvents.map((ce) => ce.id));
  const selfSwitchWritesByCommonEvent = resolveCommonEventSelfSwitchWrites(commonEvents);

  // --- Project-wide usage: map events ---
  for (const map of maps) {
    const events = map.data.events.filter((e): e is Event => e !== null);
    for (const event of events) {
      checkedEvents++;
      for (const page of event.pages) {
        scanPageConditions(page, usage);
        scanUsage(page.list, usage);
        if (listHasOpaqueCommands(page.list)) hasOpaqueCommands = true;
      }
    }
  }

  // --- Project-wide usage: common events and troop pages ---
  for (const ce of commonEvents) {
    scanUsage(ce.list, usage);
    if (listHasOpaqueCommands(ce.list)) hasOpaqueCommands = true;
    // Autorun/Parallel common events are gated by a switch — that's a read.
    if (ce.trigger !== 0 && ce.switchId > 0) usage.switchReads.add(ce.switchId);
  }
  for (const list of troopCommandLists) {
    scanUsage(list, usage);
    if (listHasOpaqueCommands(list)) hasOpaqueCommands = true;
  }
  for (const id of troopConditionSwitches) if (id > 0) usage.switchReads.add(id);

  // --- R1/R2: reads with no writer, writes with no reader ---
  //
  // "Switch 12" tells you an id and nothing else; "switch 12 (Met the mayor)"
  // tells you which feature is broken. Unnamed ids are left bare rather than
  // padded with "(unnamed)", which would only add noise to a project that names
  // nothing.
  const flagLabel = (kind: 'switch' | 'variable', id: number): string => {
    const names = kind === 'switch' ? input.flagNames?.switches : input.flagNames?.variables;
    const name = names?.[id];
    return name && name.trim() !== '' ? `${kind} ${id} ("${name}")` : `${kind} ${id}`;
  };
  const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  for (const id of [...usage.switchReads].sort((a, b) => a - b)) {
    if (id <= 0) continue;
    if (!usage.switchWrites.has(id)) {
      findings.push({
        rule: 'switch-read-never-written',
        severity: 'warning',
        message: `${capitalise(flagLabel('switch', id))} is checked but never turned on or off anywhere. Conditions depending on it can never change.`,
      });
    }
  }
  for (const id of [...usage.switchWrites].sort((a, b) => a - b)) {
    if (id <= 0) continue;
    if (!usage.switchReads.has(id)) {
      findings.push({
        rule: 'switch-written-never-read',
        severity: 'info',
        message: `${capitalise(flagLabel('switch', id))} is set but never checked.`,
      });
    }
  }
  for (const id of [...usage.variableReads].sort((a, b) => a - b)) {
    if (id <= 0) continue;
    if (!usage.variableWrites.has(id)) {
      findings.push({
        rule: 'variable-read-never-written',
        severity: 'warning',
        message: `${capitalise(flagLabel('variable', id))} is read but never assigned. It will always be 0.`,
      });
    }
  }

  // --- R10: ids past the end of the System.json array ---
  //
  // The nastiest of these rules to find by hand, because there is no symptom at
  // all. `Game_Switches.setValue` is guarded by
  // `switchId > 0 && switchId < $dataSystem.switches.length`, so a write to an
  // id past the array does nothing, and `value()` is unguarded and answers false
  // — the flag reads as permanently off and no error is raised anywhere.
  if (input.flagNames) {
    const bounds: [('switch' | 'variable'), Set<number>, Set<number>, number][] = [
      ['switch', usage.switchWrites, usage.switchReads, input.flagNames.switches.length],
      ['variable', usage.variableWrites, usage.variableReads, input.flagNames.variables.length],
    ];

    for (const [kind, writes, reads, length] of bounds) {
      const offenders = [...new Set([...writes, ...reads])]
        .filter((id) => id > 0 && id >= length)
        .sort((a, b) => a - b);

      for (const id of offenders) {
        const written = writes.has(id);
        findings.push({
          rule: `${kind}-out-of-range`,
          severity: 'error',
          message:
            `${capitalise(kind)} ${id} is past the end of System.json's ${kind === 'switch' ? 'switches' : 'variables'} ` +
            `array, which reaches ${length - 1}. ` +
            (written
              ? 'setValue ignores it, so the write does nothing and the flag stays false forever.'
              : 'It can never be set, so this condition is always false.') +
            ` Extend the array with allocate_switch.`,
        });
      }
    }
  }

  // --- R3/R4: per-event rules ---
  for (const map of maps) {
    const events = map.data.events.filter((e): e is Event => e !== null);

    for (const event of events) {
      const where = `map ${map.id} "${mapName(map.id)}", event ${event.id} "${event.name || '(unnamed)'}"`;

      // Self-switch writes available to this event: its own pages, plus any
      // common event it calls (which runs with this event's eventId).
      const selfWrites = new Set<string>();
      let eventOpaque = false;

      for (const page of event.pages) {
        for (const ch of directSelfSwitchWrites(page.list)) selfWrites.add(ch);
        if (listHasOpaqueCommands(page.list)) eventOpaque = true;
        for (const calledId of extractCommonEventCalls(page.list)) {
          const resolvedCall = selfSwitchWritesByCommonEvent.get(calledId);
          if (!resolvedCall) continue;
          for (const ch of resolvedCall.writes) selfWrites.add(ch);
          if (resolvedCall.opaque) eventOpaque = true;
        }
      }

      // R3: a page gated on a self-switch nothing can ever set.
      if (!eventOpaque) {
        const selfReads = new Set<string>();
        for (const page of event.pages) {
          if (page.conditions.selfSwitchValid) selfReads.add(page.conditions.selfSwitchCh);
          for (const ch of directSelfSwitchReads(page.list)) selfReads.add(ch);
        }

        for (const ch of [...selfReads].sort()) {
          if (!selfWrites.has(ch)) {
            findings.push({
              rule: 'self-switch-never-set',
              severity: 'error',
              message: `Self-switch ${ch} is required but this event never sets it (self-switches can only be set by the event itself or a common event it calls), so that page can never activate.`,
              where,
            });
          }
        }
      }

      // R4: an autorun page with no visible way to stop locks the game.
      event.pages.forEach((page, index) => {
        if (page.trigger !== 3) return;
        if (listHasOpaqueCommands(page.list)) return;

        const STOPPERS = new Set([214, 123, 121, 201, 122]);
        const canStop = page.list.some((c) => STOPPERS.has(c.code));
        if (!canStop) {
          findings.push({
            rule: 'autorun-cannot-stop',
            severity: 'error',
            message: `Page ${index + 1} is Autorun but never erases the event, sets a switch or self-switch, changes a variable, or transfers the player — it will run forever and lock the game.`,
            where,
          });
        }
      });

      // R8: Call Common Event pointing at a common event that doesn't exist.
      for (const page of event.pages) {
        for (const calledId of extractCommonEventCalls(page.list)) {
          if (!commonEventIds.has(calledId)) {
            findings.push({
              rule: 'missing-common-event',
              severity: 'error',
              message: `Calls common event ${calledId}, which does not exist.`,
              where,
            });
          }
        }
      }
    }
  }

  // --- R9: shop goods pointing at an entry that no longer exists ---
  //
  // Worth a rule of its own because the engine says nothing at all:
  // `Window_ShopBuy.goodsToItem` returns undefined for a missing id and
  // `makeItemList` skips the row, so the only symptom is a shop quietly one
  // item short — which nobody notices unless they remember what it used to sell.
  if (input.databaseIds) {
    const ids = input.databaseIds;
    const sources: { list: EventCommand[]; where: string }[] = [];

    for (const map of maps) {
      for (const event of map.data.events.filter((e): e is Event => e !== null)) {
        for (const page of event.pages) {
          sources.push({
            list: page.list,
            where: `map ${map.id} "${mapName(map.id)}", event ${event.id} "${event.name || '(unnamed)'}"`,
          });
        }
      }
    }
    for (const ce of commonEvents) {
      sources.push({ list: ce.list, where: `common event ${ce.id} "${ce.name || '(unnamed)'}"` });
    }
    for (const list of troopCommandLists) sources.push({ list, where: 'a troop page' });

    for (const { list, where } of sources) {
      for (const row of extractShopGoods(list)) {
        if (ids[row.database].has(row.dataId)) continue;
        findings.push({
          rule: 'shop-sells-missing-entry',
          severity: 'error',
          message:
            `Shop offers ${row.database.replace(/s$/, '')} ${row.dataId}, which is not in the ` +
            'database. The engine drops the row without a word, so the shop just sells one ' +
            'thing fewer.',
          where,
        });
      }

      // R11: a lock whose key was deleted. Worse than the shop case, because the
      // branch does not lose a row — it can never be taken, so whatever it
      // guards is unreachable for the rest of the game.
      for (const row of extractHeldItemBranches(list)) {
        if (ids[row.database].has(row.dataId)) continue;
        findings.push({
          rule: 'branch-checks-missing-entry',
          severity: 'error',
          message:
            `Branches on the party holding ${row.database.replace(/s$/, '')} ${row.dataId}, ` +
            'which is not in the database. hasItem answers false for an entry that is not ' +
            'there, so that branch can never be taken — a door locked this way never opens.',
          where,
        });
      }
    }
  }

  // --- R5/R6: reuse the map connection graph ---
  const graph = buildMapGraph({ startMapId, maps, mapInfos, commonEvents });

  for (const edge of graph.danglingEdges) {
    findings.push({
      rule: 'transfer-to-missing-map',
      severity: 'error',
      message: `Transfers to map ${edge.to}, which has no data file.`,
      where: `map ${edge.from} "${mapName(edge.from)}", event ${edge.eventId} "${edge.eventName || '(unnamed)'}"`,
    });
  }

  for (const id of graph.unreachable) {
    findings.push({
      rule: 'unreachable-map',
      severity: 'warning',
      message: `Map ${id} "${mapName(id)}" has no transfer path from the start map.`,
    });
  }

  // --- R7: tileset passage settings never configured ---
  const usedTilesetIds = new Set(maps.map((m) => m.data.tilesetId));
  for (const tileset of tilesets) {
    if (!usedTilesetIds.has(tileset.id)) continue;
    if (((tileset.flags[0] ?? 0) & FLAG_STAR) === 0) {
      findings.push({
        rule: 'tileset-passage-unconfigured',
        severity: 'warning',
        message: `Tileset ${tileset.id} "${tileset.name}" has no star bit on tile 0, so empty upper layers resolve passage themselves and impassability painted on the ground layer has no effect.`,
      });
    }
  }

  findings.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byRule = a.rule.localeCompare(b.rule);
    if (byRule !== 0) return byRule;
    return (a.where ?? '').localeCompare(b.where ?? '');
  });

  return { findings, hasOpaqueCommands, checkedMaps: maps.length, checkedEvents };
}

export function renderConsistencyReport(
  report: ConsistencyReport,
  minSeverity: Severity = 'info'
): string {
  const threshold = SEVERITY_RANK[minSeverity];
  const shown = report.findings.filter((f) => SEVERITY_RANK[f.severity] <= threshold);

  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of report.findings) counts[f.severity]++;

  const parts: string[] = [
    `Consistency check — ${report.checkedMaps} map(s), ${report.checkedEvents} event(s)`,
    `${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info`,
  ];

  if (shown.length === 0) {
    parts.push('', 'No issues found at this severity.');
  } else {
    let currentSeverity: Severity | null = null;
    for (const finding of shown) {
      if (finding.severity !== currentSeverity) {
        currentSeverity = finding.severity;
        parts.push('', `── ${currentSeverity.toUpperCase()} ──`);
      }
      parts.push(`[${finding.rule}] ${finding.message}`);
      if (finding.where) parts.push(`    at ${finding.where}`);
    }
  }

  const caveats = [
    'Rules are conservative — they only report what is provable from the data files.',
  ];
  if (report.hasOpaqueCommands) {
    caveats.push(
      'This project uses Script / Plugin Commands. Those can read and write anything, ' +
        'so self-switch and autorun rules skip the events containing them, and ' +
        'switch/variable findings may be false positives.'
    );
  }
  parts.push('', '── Caveats ──', ...caveats.map((c) => `- ${c}`));

  return parts.join('\n');
}
