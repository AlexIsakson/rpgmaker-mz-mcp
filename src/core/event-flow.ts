import type { Event, EventCommand, EventPage } from '../schemas/event.js';

/**
 * Human-readable rendering of event pages and command lists.
 *
 * Descriptions are derived from Game_Event / Game_Interpreter in the MZ
 * corescript (meetsConditions, command111, command122, command201, ...) so the
 * wording matches what the engine actually does, not what the editor UI implies.
 */

export const TRIGGER_NAMES: Record<number, string> = {
  0: 'Action Button',
  1: 'Player Touch',
  2: 'Event Touch',
  3: 'Autorun',
  4: 'Parallel',
};

const PRIORITY_NAMES: Record<number, string> = {
  0: 'Below characters',
  1: 'Same as characters',
  2: 'Above characters',
};

const MOVE_TYPE_NAMES: Record<number, string> = {
  0: 'Fixed',
  1: 'Random',
  2: 'Approach',
  3: 'Custom',
};

const VARIABLE_OPS = ['=', '+=', '-=', '*=', '/=', '%='];
const COMPARISONS = ['==', '>=', '<=', '>', '<', '!='];

export function describeTrigger(trigger: number): string {
  return TRIGGER_NAMES[trigger] ?? `Unknown (${trigger})`;
}

/**
 * Page conditions, in engine terms. All listed conditions must hold for the
 * page to be active; the last matching page wins (Game_Event.findProperPageIndex
 * scans pages in reverse).
 */
export function describePageConditions(page: EventPage): string[] {
  const c = page.conditions;
  const out: string[] = [];
  if (c.switch1Valid) out.push(`switch ${c.switch1Id} is ON`);
  if (c.switch2Valid) out.push(`switch ${c.switch2Id} is ON`);
  if (c.variableValid) out.push(`variable ${c.variableId} >= ${c.variableValue}`);
  if (c.selfSwitchValid) out.push(`self-switch ${c.selfSwitchCh} is ON`);
  if (c.itemValid) out.push(`party has item ${c.itemId}`);
  if (c.actorValid) out.push(`actor ${c.actorId} is in the party`);
  return out;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function onOff(value: unknown): string {
  return asNumber(value) === 0 ? 'ON' : 'OFF';
}

/** Conditional branch (code 111) — see Game_Interpreter.command111. */
function describeConditionalBranch(params: unknown[]): string {
  const type = asNumber(params[0]);
  const p1 = params[1];
  const p2 = params[2];
  const p3 = params[3];

  switch (type) {
    case 0:
      return `If switch ${asNumber(p1)} is ${onOff(p2)}`;
    case 1: {
      const left = `variable ${asNumber(p1)}`;
      const right = asNumber(p2) === 0 ? String(asNumber(p3)) : `variable ${asNumber(p3)}`;
      const op = COMPARISONS[asNumber(params[4])] ?? '?';
      return `If ${left} ${op} ${right}`;
    }
    case 2:
      return `If self-switch ${asString(p1)} is ${onOff(p2)}`;
    case 3:
      return `If timer ${asNumber(p2) === 0 ? '>=' : '<='} ${asNumber(p1)}s`;
    case 4: {
      const actor = `actor ${asNumber(p1)}`;
      switch (asNumber(p2)) {
        case 0: return `If ${actor} is in the party`;
        case 1: return `If ${actor} is named "${asString(p3)}"`;
        case 2: return `If ${actor} is class ${asNumber(p3)}`;
        case 3: return `If ${actor} knows skill ${asNumber(p3)}`;
        case 4: return `If ${actor} has weapon ${asNumber(p3)} equipped`;
        case 5: return `If ${actor} has armor ${asNumber(p3)} equipped`;
        case 6: return `If ${actor} is affected by state ${asNumber(p3)}`;
        default: return `If ${actor} (unknown check ${asNumber(p2)})`;
      }
    }
    case 5:
      return asNumber(p2) === 0
        ? `If enemy ${asNumber(p1)} has appeared`
        : `If enemy ${asNumber(p1)} is affected by state ${asNumber(p3)}`;
    case 6:
      return `If character ${asNumber(p1)} is facing direction ${asNumber(p2)}`;
    case 7: {
      const op = ['>=', '<=', '<'][asNumber(p2)] ?? '?';
      return `If gold ${op} ${asNumber(p1)}`;
    }
    case 8:
      return `If party has item ${asNumber(p1)}`;
    case 9:
      return `If party has weapon ${asNumber(p1)}`;
    case 10:
      return `If party has armor ${asNumber(p1)}`;
    case 11:
      return `If button "${asString(p1)}" is pressed`;
    case 12:
      return `If script: ${asString(p1)}`;
    case 13:
      return `If player is riding vehicle ${asNumber(p1)}`;
    default:
      return `If (unknown condition type ${type})`;
  }
}

/** Transfer Player (code 201). Destinations can be variable-driven, not literal. */
function describeTransfer(params: unknown[]): string {
  const direct = asNumber(params[0]) === 0;
  if (direct) {
    return `Transfer player to map ${asNumber(params[1])} at (${asNumber(params[2])}, ${asNumber(params[3])})`;
  }
  return (
    `Transfer player to map from variable ${asNumber(params[1])}, ` +
    `x from variable ${asNumber(params[2])}, y from variable ${asNumber(params[3])} (dynamic)`
  );
}

function describeRange(startId: number, endId: number, singular: string, plural: string): string {
  return startId === endId ? `${singular} ${startId}` : `${plural} ${startId}-${endId}`;
}

/**
 * One-line description of a single command. Continuation codes (401, 402, 408,
 * ...) are handled by describeCommands, which folds them into their parent.
 */
export function describeCommand(cmd: EventCommand): string {
  const p = cmd.parameters;

  switch (cmd.code) {
    case 0: return '';
    case 101: return 'Show Text:';
    case 102: return `Show Choices: ${(p[0] as string[] ?? []).map((c) => `"${c}"`).join(', ')}`;
    case 103: return `Input Number -> variable ${asNumber(p[0])}`;
    case 104: return `Select Item -> variable ${asNumber(p[0])}`;
    case 105: return 'Show Scrolling Text:';
    case 108: return 'Comment:';
    case 111: return describeConditionalBranch(p);
    case 112: return 'Loop';
    case 113: return 'Break Loop';
    case 115: return 'Exit Event Processing';
    case 117: return `Call Common Event ${asNumber(p[0])}`;
    case 118: return `Label: ${asString(p[0])}`;
    case 119: return `Jump to Label: ${asString(p[0])}`;
    case 121: return `Set ${describeRange(asNumber(p[0]), asNumber(p[1]), 'switch', 'switches')} = ${onOff(p[2])}`;
    case 122: {
      const target = describeRange(asNumber(p[0]), asNumber(p[1]), 'variable', 'variables');
      const op = VARIABLE_OPS[asNumber(p[2])] ?? '=';
      const operand = asNumber(p[3]);
      let value: string;
      switch (operand) {
        case 0: value = String(asNumber(p[4])); break;
        case 1: value = `variable ${asNumber(p[4])}`; break;
        case 2: value = `random ${asNumber(p[4])}..${asNumber(p[5])}`; break;
        case 3: value = 'game data'; break;
        case 4: value = `script: ${asString(p[4])}`; break;
        default: value = '?';
      }
      return `Set ${target} ${op} ${value}`;
    }
    case 123: return `Set self-switch ${asString(p[0])} = ${onOff(p[1])}`;
    case 124: return `${asNumber(p[0]) === 0 ? 'Start' : 'Stop'} Timer`;
    case 125: return `${asNumber(p[0]) === 0 ? 'Gain' : 'Lose'} gold`;
    case 126: return `${asNumber(p[1]) === 0 ? 'Gain' : 'Lose'} item ${asNumber(p[0])}`;
    case 127: return `${asNumber(p[1]) === 0 ? 'Gain' : 'Lose'} weapon ${asNumber(p[0])}`;
    case 128: return `${asNumber(p[1]) === 0 ? 'Gain' : 'Lose'} armor ${asNumber(p[0])}`;
    case 129: return `${asNumber(p[1]) === 0 ? 'Add' : 'Remove'} actor ${asNumber(p[0])} ${asNumber(p[1]) === 0 ? 'to' : 'from'} party`;
    case 201: return describeTransfer(p);
    case 202: return 'Set Vehicle Location';
    case 203: return `Set Event Location (event ${asNumber(p[0])})`;
    case 204: return 'Scroll Map';
    case 205: return `Set Movement Route (character ${asNumber(p[0])})`;
    case 206: return 'Get on/off Vehicle';
    case 211: return `Change Transparency: ${asNumber(p[0]) === 0 ? 'ON' : 'OFF'}`;
    case 212: return `Show Animation ${asNumber(p[1])} on character ${asNumber(p[0])}`;
    case 213: return `Show Balloon Icon ${asNumber(p[1])} on character ${asNumber(p[0])}`;
    case 214: return 'Erase Event';
    case 216: return 'Change Player Followers';
    case 217: return 'Gather Followers';
    case 221: return 'Fadeout Screen';
    case 222: return 'Fadein Screen';
    case 223: return 'Tint Screen';
    case 224: return 'Flash Screen';
    case 225: return 'Shake Screen';
    case 230: return `Wait ${asNumber(p[0])} frames`;
    case 231: return `Show Picture ${asNumber(p[0])}`;
    case 232: return `Move Picture ${asNumber(p[0])}`;
    case 233: return `Rotate Picture ${asNumber(p[0])}`;
    case 234: return `Tint Picture ${asNumber(p[0])}`;
    case 235: return `Erase Picture ${asNumber(p[0])}`;
    case 241: return `Play BGM: ${asString((p[0] as { name?: string })?.name)}`;
    case 242: return 'Fadeout BGM';
    case 245: return `Play BGS: ${asString((p[0] as { name?: string })?.name)}`;
    case 249: return `Play ME: ${asString((p[0] as { name?: string })?.name)}`;
    case 250: return `Play SE: ${asString((p[0] as { name?: string })?.name)}`;
    case 251: return 'Stop SE';
    case 261: return 'Play Movie';
    case 281: return 'Change Map Name Display';
    case 282: return `Change Tileset to ${asNumber(p[0])}`;
    case 283: return 'Change Battle Background';
    case 284: return 'Change Parallax';
    case 301: return `Battle Processing: troop ${asNumber(p[1])}${p[2] ? ' (can escape)' : ''}${p[3] ? ' (can lose)' : ''}`;
    case 302: return 'Shop Processing';
    case 303: return `Name Input Processing (actor ${asNumber(p[0])})`;
    case 311: return `Change HP (actor ${asNumber(p[1])})`;
    case 312: return `Change MP (actor ${asNumber(p[1])})`;
    case 313: return `${asNumber(p[2]) === 0 ? 'Add' : 'Remove'} state ${asNumber(p[3])} (actor ${asNumber(p[1])})`;
    case 314: return 'Recover All';
    case 315: return `Change EXP (actor ${asNumber(p[1])})`;
    case 316: return `Change Level (actor ${asNumber(p[1])})`;
    case 317: return `Change Parameter (actor ${asNumber(p[1])})`;
    case 318: return `${asNumber(p[2]) === 0 ? 'Learn' : 'Forget'} skill ${asNumber(p[3])} (actor ${asNumber(p[1])})`;
    case 319: return `Change Equipment (actor ${asNumber(p[0])})`;
    case 320: return `Change Name (actor ${asNumber(p[0])})`;
    case 321: return `Change Class (actor ${asNumber(p[0])} -> class ${asNumber(p[1])})`;
    case 324: return `Change Nickname (actor ${asNumber(p[0])})`;
    case 325: return `Change Profile (actor ${asNumber(p[0])})`;
    case 326: return `Change TP (actor ${asNumber(p[1])})`;
    case 351: return 'Open Menu Screen';
    case 352: return 'Open Save Screen';
    case 353: return 'Game Over';
    case 354: return 'Return to Title Screen';
    case 355: return `Script: ${asString(p[0])}`;
    case 356: return `Plugin Command (MV): ${asString(p[0])}`;
    case 357: return `Plugin Command: ${asString(p[1])} -> ${asString(p[2])}`;
    default: return `[code ${cmd.code}]`;
  }
}

/**
 * Render a command list as indented lines, folding continuation codes
 * (text/comment/script bodies, choice branches, shop goods) into their parent.
 */
export function describeCommands(list: EventCommand[]): string[] {
  const lines: string[] = [];

  for (let i = 0; i < list.length; i++) {
    const cmd = list[i];
    const pad = '  '.repeat(Math.max(0, cmd.indent));

    switch (cmd.code) {
      // Continuation codes handled by their parent below.
      case 401: case 405: case 408: case 655: case 605:
        continue;

      case 0:
        continue; // end-of-list marker

      case 402: {
        // [index, name] — command402 itself only reads the index, but the
        // editor stores the label alongside it.
        const label = cmd.parameters[1];
        lines.push(
          label === undefined
            ? `${pad}When choice ${asNumber(cmd.parameters[0])}`
            : `${pad}When "${asString(label)}"`
        );
        continue;
      }
      case 403:
        lines.push(`${pad}When Cancel`);
        continue;
      case 411:
        lines.push(`${pad}Else`);
        continue;
      case 412:
        lines.push(`${pad}End If`);
        continue;
      case 413:
        lines.push(`${pad}Repeat Above`);
        continue;
      case 404:
        // Shown for the same reason End If is: without it there is nothing in
        // the read-back to say where the block stopped, so the command after a
        // choice reads as though it were inside the last When.
        lines.push(`${pad}End Choices`);
        continue;
      case 409: case 604:
        continue; // structural end markers, no useful text

      case 101: case 105: case 108: case 355: {
        // Fold the body lines that follow into a single quoted block.
        // 108 (Comment) and 355 (Script) carry their first line in their own
        // parameters; 101/105 carry only display settings, so their text starts
        // in the continuation commands.
        const bodyCode = cmd.code === 101 ? 401 : cmd.code === 105 ? 405 : cmd.code === 108 ? 408 : 655;
        const body: string[] = cmd.code === 108 ? [asString(cmd.parameters[0])] : [];
        let j = i + 1;
        while (j < list.length && list[j].code === bodyCode) {
          body.push(asString(list[j].parameters[0]));
          j++;
        }
        const head = describeCommand(cmd);
        if (cmd.code === 355) {
          const all = [asString(cmd.parameters[0]), ...body].filter((l) => l.length > 0);
          lines.push(`${pad}Script: ${all.join(' / ')}`);
        } else if (body.length > 0) {
          lines.push(`${pad}${head} "${body.join(' / ')}"`);
        } else {
          lines.push(`${pad}${head}`);
        }
        i = j - 1;
        continue;
      }

      default: {
        const text = describeCommand(cmd);
        if (text) lines.push(`${pad}${text}`);
      }
    }
  }

  return lines;
}

export interface EventReferences {
  switchesRead: number[];
  switchesWritten: number[];
  variablesRead: number[];
  variablesWritten: number[];
  selfSwitchesRead: string[];
  selfSwitchesWritten: string[];
  commonEvents: number[];
  /** Literal transfer destinations. Variable-driven transfers are not included. */
  transfersTo: number[];
  /** True if any transfer resolves its destination from variables at runtime. */
  hasDynamicTransfer: boolean;
}

const sortUnique = <T,>(values: T[]): T[] => [...new Set(values)].sort();

/** Mutable accumulator shared by the page-based and flat-list scanners. */
interface RefAccumulator {
  switchesRead: number[];
  switchesWritten: number[];
  variablesRead: number[];
  variablesWritten: number[];
  selfSwitchesRead: string[];
  selfSwitchesWritten: string[];
  commonEvents: number[];
  transfersTo: number[];
  hasDynamicTransfer: boolean;
}

function newAccumulator(): RefAccumulator {
  return {
    switchesRead: [],
    switchesWritten: [],
    variablesRead: [],
    variablesWritten: [],
    selfSwitchesRead: [],
    selfSwitchesWritten: [],
    commonEvents: [],
    transfersTo: [],
    hasDynamicTransfer: false,
  };
}

function scanCommandList(list: EventCommand[], acc: RefAccumulator): void {
  for (const cmd of list) {
    const p = cmd.parameters;
    switch (cmd.code) {
      case 121:
        for (let id = asNumber(p[0]); id <= asNumber(p[1]); id++) acc.switchesWritten.push(id);
        break;
      case 122:
        for (let id = asNumber(p[0]); id <= asNumber(p[1]); id++) acc.variablesWritten.push(id);
        if (asNumber(p[3]) === 1) acc.variablesRead.push(asNumber(p[4]));
        break;
      case 123:
        acc.selfSwitchesWritten.push(asString(p[0]));
        break;
      case 117:
        acc.commonEvents.push(asNumber(p[0]));
        break;
      case 111: {
        const type = asNumber(p[0]);
        if (type === 0) acc.switchesRead.push(asNumber(p[1]));
        else if (type === 1) {
          acc.variablesRead.push(asNumber(p[1]));
          if (asNumber(p[2]) === 1) acc.variablesRead.push(asNumber(p[3]));
        } else if (type === 2) acc.selfSwitchesRead.push(asString(p[1]));
        break;
      }
      case 201:
        if (asNumber(p[0]) === 0) acc.transfersTo.push(asNumber(p[1]));
        else acc.hasDynamicTransfer = true;
        break;
    }
  }
}

function finalize(acc: RefAccumulator): EventReferences {
  return {
    switchesRead: sortUnique(acc.switchesRead),
    switchesWritten: sortUnique(acc.switchesWritten),
    variablesRead: sortUnique(acc.variablesRead),
    variablesWritten: sortUnique(acc.variablesWritten),
    selfSwitchesRead: sortUnique(acc.selfSwitchesRead),
    selfSwitchesWritten: sortUnique(acc.selfSwitchesWritten),
    commonEvents: sortUnique(acc.commonEvents),
    transfersTo: sortUnique(acc.transfersTo),
    hasDynamicTransfer: acc.hasDynamicTransfer,
  };
}

/**
 * Collect the switches / variables / self-switches / common events an event
 * touches. Foundation for the map connection graph and consistency checker.
 */
export function collectReferences(event: Event): EventReferences {
  const acc = newAccumulator();

  for (const page of event.pages) {
    const c = page.conditions;
    if (c.switch1Valid) acc.switchesRead.push(c.switch1Id);
    if (c.switch2Valid) acc.switchesRead.push(c.switch2Id);
    if (c.variableValid) acc.variablesRead.push(c.variableId);
    if (c.selfSwitchValid) acc.selfSwitchesRead.push(c.selfSwitchCh);

    scanCommandList(page.list, acc);
  }

  return finalize(acc);
}

/**
 * Same collection over a bare command list — for common events and troop pages,
 * which have no page conditions.
 */
export function collectCommandReferences(list: EventCommand[]): EventReferences {
  const acc = newAccumulator();
  scanCommandList(list, acc);
  return finalize(acc);
}

export interface TransferTarget {
  /** null when the destination is resolved from variables at runtime. */
  mapId: number | null;
  x: number;
  y: number;
  dynamic: boolean;
}

/** Every Transfer Player (201) in a command list, in order. */
export function extractTransfers(list: EventCommand[]): TransferTarget[] {
  const out: TransferTarget[] = [];
  for (const cmd of list) {
    if (cmd.code !== 201) continue;
    const p = cmd.parameters;
    const dynamic = asNumber(p[0]) !== 0;
    out.push({
      mapId: dynamic ? null : asNumber(p[1]),
      x: asNumber(p[2]),
      y: asNumber(p[3]),
      dynamic,
    });
  }
  return out;
}

/** Every Call Common Event (117) target in a command list. */
export function extractCommonEventCalls(list: EventCommand[]): number[] {
  return list
    .filter((cmd) => cmd.code === 117)
    .map((cmd) => asNumber(cmd.parameters[0]));
}

/** Full multi-page breakdown of one event. */
export function renderEvent(event: Event): string {
  const parts: string[] = [
    `Event [${event.id}] "${event.name || '(unnamed)'}" at (${event.x}, ${event.y}) — ${event.pages.length} page(s)`,
  ];
  if (event.note) parts.push(`Note: ${event.note}`);
  parts.push(
    '',
    'Pages are evaluated last-to-first; the first one whose conditions all hold becomes active.'
  );

  event.pages.forEach((page, index) => {
    const conditions = describePageConditions(page);
    parts.push(
      '',
      `── Page ${index + 1} ──`,
      `Trigger: ${describeTrigger(page.trigger)}`,
      `Conditions: ${conditions.length > 0 ? conditions.join(' AND ') : '(none — always eligible)'}`,
      `Priority: ${PRIORITY_NAMES[page.priorityType] ?? page.priorityType}   Movement: ${MOVE_TYPE_NAMES[page.moveType] ?? page.moveType}`,
      '',
    );
    const lines = describeCommands(page.list);
    parts.push(lines.length > 0 ? lines.join('\n') : '(no commands)');
  });

  const refs = collectReferences(event);
  const refLines: string[] = [];
  if (refs.switchesRead.length) refLines.push(`Reads switches: ${refs.switchesRead.join(', ')}`);
  if (refs.switchesWritten.length) refLines.push(`Writes switches: ${refs.switchesWritten.join(', ')}`);
  if (refs.variablesRead.length) refLines.push(`Reads variables: ${refs.variablesRead.join(', ')}`);
  if (refs.variablesWritten.length) refLines.push(`Writes variables: ${refs.variablesWritten.join(', ')}`);
  if (refs.selfSwitchesRead.length) refLines.push(`Reads self-switches: ${refs.selfSwitchesRead.join(', ')}`);
  if (refs.selfSwitchesWritten.length) refLines.push(`Writes self-switches: ${refs.selfSwitchesWritten.join(', ')}`);
  if (refs.commonEvents.length) refLines.push(`Calls common events: ${refs.commonEvents.join(', ')}`);
  if (refs.transfersTo.length) refLines.push(`Transfers to maps: ${refs.transfersTo.join(', ')}`);
  if (refs.hasDynamicTransfer) refLines.push('Has variable-driven transfer (destination not statically known)');

  if (refLines.length > 0) {
    parts.push('', '── References ──', ...refLines);
  }

  return parts.join('\n');
}

/** One line per page across many events — a map-wide "what runs when" overview. */
export function renderEventOverview(events: Event[]): string {
  const lines: string[] = [];

  for (const event of events) {
    lines.push(`[${event.id}] "${event.name || '(unnamed)'}" at (${event.x}, ${event.y})`);
    event.pages.forEach((page, index) => {
      const conditions = describePageConditions(page);
      const commandCount = page.list.filter((c) => c.code !== 0).length;
      const cond = conditions.length > 0 ? conditions.join(' AND ') : 'always';
      lines.push(
        `    p${index + 1}: ${describeTrigger(page.trigger)} | when ${cond} | ${commandCount} command(s)`
      );
    });
  }

  return lines.join('\n');
}
