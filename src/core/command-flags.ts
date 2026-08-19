import {
  allocateFlag,
  findFlag,
  highestUsableId,
  isUsableId,
  SwitchError,
  type FlagKind,
} from './switches.js';
import type { EventPageCondition } from '../schemas/event.js';

/**
 * Flag *names* in an event command list.
 *
 * `allocate_switch` gives a named flag an id, and `place_lever` and
 * `place_locked_door` both accept a `switchName` and allocate behind it.
 * `add_event_commands` did not: a caller had to allocate first, remember the
 * number, and hand it back as `startId`. This module closes that gap — it
 * rewrites a command list's `switchName` / `variableName` keys into the numeric
 * ids the engine actually reads, allocating any name it has not seen before.
 *
 * **Which commands get a name was measured, not guessed.** Counted over the
 * corpus (293 sample maps, the `newdata` reference project, and the three
 * projects under `M:/Projects/RPGMZ`):
 *
 *  - The 293 sample maps use **no** global switch or variable anywhere: 0
 *    occurrences of code 121, 122, or a switch page condition. They are rooms,
 *    not scripts, so — as with the region plane — the corpus settles nothing
 *    here and the semantics come from the engine instead.
 *  - `Wicked Heart` (64 maps) is the only project on hand with real logic in it:
 *    **43** Control Switches (121), **23** switch conditional branches (111 type
 *    0), and 62 switch page conditions — against **2** Control Variables (122)
 *    and **2** variable branches (111 type 1).
 *  - **All 26 distinct switch ids that project references carry a name in
 *    System.json** (out of 28 named). The name is already the handle a real
 *    project works in; the id is bookkeeping.
 *
 * So 121 and 111-type-0 take a `switchName`, which is where the traffic is. The
 * variable equivalents take a `variableName` on the same machinery, because it
 * is the same allocation — but 2 and 2 is far too thin a sample to claim
 * anything about how variables are actually used, and nothing was invented for
 * them beyond the shape the engine defines.
 *
 * Page conditions are the single largest count (62) — more than Control
 * Switches and conditional branches combined — and `resolvePageConditions`
 * handles them, on the same `allocateFlag` primitive but through its own
 * small resolver rather than a `NAME_KEYS` entry: a page's `conditions` is not
 * a command (it has no `type` to dispatch on), so it does not fit the
 * per-command loop `resolveCommandFlags` runs.
 *
 * This module is pure. It rewrites names arrays and never reads a file; the
 * caller decides whether to persist them.
 */

export class CommandFlagError extends Error {}

/** A name that got turned into an id, and what that cost. */
export interface FlagResolution {
  kind: FlagKind;
  name: string;
  id: number;
  /** False when a flag already carried that name and was reused. */
  created: boolean;
  /** True when the names array had to be extended to make the id usable. */
  grew: boolean;
}

export interface ResolveFlagsResult {
  /** The command records with names replaced by ids. Inputs are not mutated. */
  commands: Record<string, unknown>[];
  /** Rewritten arrays. Equal to the inputs when nothing was allocated. */
  switches: string[];
  variables: string[];
  /** One entry per distinct name, in the order the names were first seen. */
  resolutions: FlagResolution[];
  /** True when either array changed and System.json needs writing. */
  changed: boolean;
}

/** Which name key each command type accepts, and what it names. */
const NAME_KEYS: Record<string, { key: string; kind: FlagKind }[]> = {
  control_switches: [{ key: 'switchName', kind: 'switch' }],
  control_variables: [{ key: 'variableName', kind: 'variable' }],
  conditional_branch: [
    { key: 'switchName', kind: 'switch' },
    { key: 'variableName', kind: 'variable' },
  ],
};

/**
 * Names that resolve to an id and land in a named field, rather than steering a
 * range or a branch. Added for the designation work: `battle_processing` and
 * `transfer_player` can read their operands from variables, and a variable that
 * drives a transfer destination is exactly the kind a project names.
 */
const DIRECT_NAME_KEYS: Record<string, { nameKey: string; idKey: string; kind: FlagKind }[]> = {
  battle_processing: [
    { nameKey: 'troopVariableName', idKey: 'troopVariableId', kind: 'variable' },
  ],
  transfer_player: [
    { nameKey: 'mapVariableName', idKey: 'mapVariableId', kind: 'variable' },
    { nameKey: 'xVariableName', idKey: 'xVariableId', kind: 'variable' },
    { nameKey: 'yVariableName', idKey: 'yVariableId', kind: 'variable' },
  ],
};

/** Every name key this module knows about, for the "no flag to name" refusal. */
const ALL_NAME_KEYS = [
  'switchName',
  'variableName',
  ...Object.values(DIRECT_NAME_KEYS).flatMap((refs) => refs.map((r) => r.nameKey)),
];

/**
 * Whether a command carries any flag name at all.
 *
 * `add_event_commands` uses this to decide whether System.json needs reading —
 * an id-only caller keeps working in a project whose System.json is missing.
 * Exported so the list of name keys stays in one place: adding a key here used
 * to mean remembering to widen a condition in the tool as well.
 */
export function usesFlagName(cmd: Record<string, unknown>): boolean {
  return ALL_NAME_KEYS.some((key) => cmd[key] !== undefined);
}

interface Arrays {
  switch: string[];
  variable: string[];
}

const plural = (kind: FlagKind) => (kind === 'switch' ? 'switches' : 'variables');

/**
 * Turn one name into an id, reusing an existing flag of that name.
 *
 * `requestedId` mirrors how `place_lever` and `place_locked_door` treat their
 * `switchId`: it is the id to *claim*, not a second way of saying which flag.
 * Asking for a name that already lives somewhere else is refused by
 * `allocateFlag` rather than leaving two ids carrying one name.
 */
function resolveOne(
  arrays: Arrays,
  kind: FlagKind,
  name: string,
  requestedId: number | undefined,
  seen: Map<string, FlagResolution>
): number {
  const cacheKey = `${kind}:${name.trim().toLowerCase()}`;
  const cached = seen.get(cacheKey);
  if (cached !== undefined && requestedId === undefined) return cached.id;

  const names = arrays[kind];
  const existing = findFlag(names, name);
  if (existing !== null && (requestedId === undefined || requestedId === existing)) {
    if (!seen.has(cacheKey)) {
      seen.set(cacheKey, { kind, name: names[existing], id: existing, created: false, grew: false });
    }
    return existing;
  }

  let allocated;
  try {
    allocated = allocateFlag(names, name, requestedId === undefined ? {} : { id: requestedId });
  } catch (error) {
    if (error instanceof SwitchError) throw new CommandFlagError(error.message);
    throw error;
  }
  arrays[kind] = allocated.names;
  seen.set(cacheKey, {
    kind,
    name,
    id: allocated.id,
    created: allocated.created,
    grew: allocated.grew,
  });
  return allocated.id;
}

function asOptionalInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CommandFlagError(`${label} must be a whole number, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** The name on a command, checked to be a non-empty string. */
function readName(cmd: Record<string, unknown>, key: string): string | undefined {
  const raw = cmd[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new CommandFlagError(
      `${key} must be a non-empty name. An unnamed slot is a free slot, so allocating one ` +
        'would hand back an id the next allocation hands out again.'
    );
  }
  return raw;
}

/**
 * Rewrite `switchName` / `variableName` into ids across a whole command list.
 *
 * The arrays are only handed back once the entire list has resolved, so a
 * refusal halfway through leaves the caller's System.json untouched — nobody
 * ends up with three flags allocated for a batch that was then rejected.
 */
export function resolveCommandFlags(
  commands: Record<string, unknown>[],
  switches: string[],
  variables: string[]
): ResolveFlagsResult {
  const arrays: Arrays = { switch: [...switches], variable: [...variables] };
  const seen = new Map<string, FlagResolution>();
  const out: Record<string, unknown>[] = [];

  for (let i = 0; i < commands.length; i++) {
    const cmd = { ...commands[i] };
    const type = typeof cmd.type === 'string' ? cmd.type : '';
    const where = `command ${i + 1} (${type || 'no type'})`;
    const accepted = NAME_KEYS[type] ?? [];
    const direct = DIRECT_NAME_KEYS[type] ?? [];

    // A name on a command with no flag in it is a caller who believes something
    // is being gated when nothing is. Say so rather than dropping the key.
    for (const key of ALL_NAME_KEYS) {
      if (cmd[key] === undefined) continue;
      if (!accepted.some((a) => a.key === key) && !direct.some((d) => d.nameKey === key)) {
        const takers = Object.entries({ ...NAME_KEYS, ...DIRECT_NAME_KEYS })
          .filter(([, refs]) =>
            (refs as { key?: string; nameKey?: string }[]).some(
              (r) => (r.key ?? r.nameKey) === key
            )
          )
          .map(([t]) => t);
        throw new CommandFlagError(
          `${where} has no flag for ${key} to name. ` +
            (takers.length > 0
              ? `Only ${takers.join(', ')} take${takers.length === 1 ? 's' : ''} one.`
              : `Only ${Object.keys(NAME_KEYS).join(', ')} take a flag name.`)
        );
      }
    }

    const switchName = readName(cmd, 'switchName');
    const variableName = readName(cmd, 'variableName');

    if (type === 'control_switches' && switchName !== undefined) {
      applyRangeName(cmd, where, arrays, 'switch', switchName, seen);
    } else if (type === 'control_variables' && variableName !== undefined) {
      applyRangeName(cmd, where, arrays, 'variable', variableName, seen);
    } else if (
      type === 'conditional_branch' &&
      (switchName !== undefined || variableName !== undefined)
    ) {
      applyBranchName(cmd, where, arrays, switchName, variableName, seen);
    }

    // A named operand resolves straight into its id field. The id alongside a
    // name is the id to claim, the same as everywhere else in this module.
    for (const ref of direct) {
      const name = readName(cmd, ref.nameKey);
      if (name === undefined) continue;
      const requested = asOptionalInt(cmd[ref.idKey], `${where} ${ref.idKey}`);
      cmd[ref.idKey] = resolveOne(arrays, ref.kind, name, requested, seen);
      delete cmd[ref.nameKey];
    }

    delete cmd.switchName;
    delete cmd.variableName;
    out.push(cmd);
  }

  const sameArray = (a: string[], b: string[]) =>
    a.length === b.length && a.every((n, i) => n === b[i]);

  return {
    commands: out,
    switches: arrays.switch,
    variables: arrays.variable,
    resolutions: [...seen.values()],
    changed: !sameArray(arrays.switch, switches) || !sameArray(arrays.variable, variables),
  };
}

/**
 * `control_switches` / `control_variables`: the name fixes both ends of the
 * range, because a name denotes exactly one flag. A `startId` alongside it is
 * the id to claim, the way `place_lever`'s `switchId` is.
 */
function applyRangeName(
  cmd: Record<string, unknown>,
  where: string,
  arrays: Arrays,
  kind: FlagKind,
  name: string,
  seen: Map<string, FlagResolution>
): void {
  const endId = asOptionalInt(cmd.endId, `${where} endId`);
  if (endId !== undefined) {
    throw new CommandFlagError(
      `${where} gives both a name and endId ${endId}. A name is one flag, so there is no range ` +
        'for it to cover — drop endId, or address the range by startId/endId without a name.'
    );
  }
  const requested = asOptionalInt(cmd.startId, `${where} startId`);
  const id = resolveOne(arrays, kind, name, requested, seen);
  cmd.startId = id;
  cmd.endId = id;
}

/**
 * `conditional_branch`: which name is meaningful depends on `conditionType`,
 * because command111 switches on it — type 0 reads params[1] as a switch id,
 * type 1 reads it as a variable id, and every other type means something else
 * entirely.
 */
function applyBranchName(
  cmd: Record<string, unknown>,
  where: string,
  arrays: Arrays,
  switchName: string | undefined,
  variableName: string | undefined,
  seen: Map<string, FlagResolution>
): void {
  if (switchName !== undefined && variableName !== undefined) {
    throw new CommandFlagError(
      `${where} names both a switch and a variable. One branch tests one thing — command111 ` +
        'reads params[1] as a switch id or a variable id depending on conditionType, never both.'
    );
  }
  const conditionType = asOptionalInt(cmd.conditionType, `${where} conditionType`) ?? 0;
  const kind: FlagKind = switchName !== undefined ? 'switch' : 'variable';
  const name = (switchName ?? variableName) as string;
  const wanted = kind === 'switch' ? 0 : 1;

  if (conditionType !== wanted) {
    throw new CommandFlagError(
      `${where} has conditionType ${conditionType}, which does not test a ${kind}. ` +
        `${kind === 'switch' ? 'switchName' : 'variableName'} only means something on ` +
        `conditionType ${wanted} (${wanted === 0 ? 'Switch' : 'Variable'}).`
    );
  }

  const requested = asOptionalInt(cmd.param1, `${where} param1`);
  cmd.param1 = resolveOne(arrays, kind, name, requested, seen);
}

/** An id a command names that the engine cannot reach, and how far it reaches. */
export interface UnusableFlagRef {
  kind: FlagKind;
  id: number;
  /** The highest id these arrays make usable. */
  reach: number;
}

/**
 * Ids a command list refers to that the engine cannot write, given these
 * arrays. `setValue` is guarded by `id < names.length` and `value()` is not
 * guarded at all, so an id past the end fails silently in both directions —
 * before the file is written is the only chance to say anything about it.
 */
export function unusableFlagIds(
  commands: Record<string, unknown>[],
  switches: string[],
  variables: string[]
): UnusableFlagRef[] {
  const bad: UnusableFlagRef[] = [];
  const check = (kind: FlagKind, id: unknown) => {
    if (typeof id !== 'number' || !Number.isInteger(id)) return;
    const names = kind === 'switch' ? switches : variables;
    if (!isUsableId(names, id)) bad.push({ kind, id, reach: highestUsableId(names) });
  };

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'control_switches':
        check('switch', cmd.startId ?? 1);
        if (cmd.endId !== undefined) check('switch', cmd.endId);
        break;
      case 'control_variables':
        check('variable', cmd.startId ?? 1);
        if (cmd.endId !== undefined) check('variable', cmd.endId);
        break;
      case 'conditional_branch': {
        const conditionType = cmd.conditionType ?? 0;
        if (conditionType === 0) check('switch', cmd.param1 ?? 0);
        else if (conditionType === 1) check('variable', cmd.param1 ?? 0);
        break;
      }
    }
  }
  return bad;
}

/** What a caller can name on a page's conditions. Already Zod-validated by the tool. */
export interface RawPageConditions {
  switch1Id?: number;
  switch1Name?: string;
  switch2Id?: number;
  switch2Name?: string;
  variableId?: number;
  variableName?: string;
  variableValue?: number;
  selfSwitchCh?: string;
  itemId?: number;
  actorId?: number;
}

/** Whether a conditions object names a switch or variable at all. */
export function usesConditionName(conditions: RawPageConditions): boolean {
  return (
    conditions.switch1Name !== undefined ||
    conditions.switch2Name !== undefined ||
    conditions.variableName !== undefined
  );
}

export interface ResolveConditionsResult {
  /** The full 13-field shape `Game_Event.meetsConditions` reads. */
  conditions: EventPageCondition;
  switches: string[];
  variables: string[];
  /** One entry per distinct name, in the order the names were first seen. */
  resolutions: FlagResolution[];
  /** True when either array changed and System.json needs writing. */
  changed: boolean;
}

/** A name if given, else a raw id if given, else "not this kind at all". */
function pick(
  arrays: Arrays,
  kind: FlagKind,
  name: string | undefined,
  id: number | undefined,
  seen: Map<string, FlagResolution>
): number | undefined {
  if (name === undefined && id === undefined) return undefined;
  if (name === undefined) return id;
  return resolveOne(arrays, kind, name, id, seen);
}

/**
 * Turn a page's `switch1Name` / `switch2Name` / `variableName` into ids, the
 * same allocation `resolveCommandFlags` runs for a command list — reusing
 * `resolveOne` directly, since a page condition and a `control_switches`
 * command name the same kind of flag.
 *
 * This is a **full replace, not a merge**: the result is the complete
 * six-kind shape the engine reads, with exactly the kinds the caller named
 * turned on and everything else left at `blankConditions()`'s defaults —
 * `*Id: 1`, every `*Valid: false`. A caller clearing a page's conditions
 * passes `{}` rather than needing a separate "unset" argument.
 *
 * `itemId` / `actorId` need no allocation — they name a database row, not a
 * flag — so they pass straight through; checking they exist is
 * `requirePageConditionRefs`'s job in `database-refs.ts`, the same split
 * `add_event_commands` already makes between flag names and database rows.
 */
export function resolvePageConditions(
  raw: RawPageConditions,
  switches: string[],
  variables: string[]
): ResolveConditionsResult {
  const arrays: Arrays = { switch: [...switches], variable: [...variables] };
  const seen = new Map<string, FlagResolution>();

  const switch1Id = pick(arrays, 'switch', raw.switch1Name, raw.switch1Id, seen);
  const switch2Id = pick(arrays, 'switch', raw.switch2Name, raw.switch2Id, seen);
  const variableId = pick(arrays, 'variable', raw.variableName, raw.variableId, seen);

  const conditions: EventPageCondition = {
    switch1Valid: switch1Id !== undefined,
    switch1Id: switch1Id ?? 1,
    switch2Valid: switch2Id !== undefined,
    switch2Id: switch2Id ?? 1,
    variableValid: variableId !== undefined,
    variableId: variableId ?? 1,
    variableValue: raw.variableValue ?? 0,
    selfSwitchValid: raw.selfSwitchCh !== undefined,
    selfSwitchCh: raw.selfSwitchCh ?? 'A',
    itemValid: raw.itemId !== undefined,
    itemId: raw.itemId ?? 1,
    actorValid: raw.actorId !== undefined,
    actorId: raw.actorId ?? 1,
  };

  const sameArray = (a: string[], b: string[]) =>
    a.length === b.length && a.every((n, i) => n === b[i]);

  return {
    conditions,
    switches: arrays.switch,
    variables: arrays.variable,
    resolutions: [...seen.values()],
    changed: !sameArray(arrays.switch, switches) || !sameArray(arrays.variable, variables),
  };
}

/** One line per resolution, for the tool to report what it allocated. */
export function describeResolutions(resolutions: FlagResolution[]): string[] {
  return resolutions.map((r) => {
    const noun = r.kind === 'switch' ? 'Switch' : 'Variable';
    if (!r.created) return `${noun} ${r.id} "${r.name}" already existed and was reused.`;
    return (
      `${noun} ${r.id} was allocated as "${r.name}"` +
      (r.grew
        ? `, extending the ${plural(r.kind)} array so the id is one the engine will actually ` +
          'write to.'
        : '.')
    );
  });
}
