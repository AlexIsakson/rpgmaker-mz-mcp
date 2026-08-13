/**
 * Global switches and variables.
 *
 * These are the primitive everything with *state* needs — quests, locked doors,
 * a shop that only opens after dark — and until now nothing in the server
 * touched them. A caller wanting a flag had to pick an id by hand and hope.
 *
 * The engine settles more here than one might expect:
 *
 *  - **Id 0 does not exist, and neither does anything past the names array.**
 *    `Game_Switches.setValue` is guarded by
 *    `switchId > 0 && switchId < $dataSystem.switches.length`, and
 *    `Game_Variables.setValue` by the identical test on `variables`. So the
 *    names array in System.json is not decoration: **its length is the engine's
 *    bound on which flags work at all.**
 *  - **Going outside that range fails silently in both directions.** `setValue`
 *    does nothing, and `value()` is unguarded, returning `false` (or `0`) for
 *    any id. An event that sets switch 50 in a project whose array stops at 20
 *    has no effect and reports no error, and every condition reading that switch
 *    is false forever. Nothing at runtime says a word.
 *  - Self switches are the exception and are *not* handled here:
 *    `Game_SelfSwitches` is a plain keyed dictionary with no bound, which is why
 *    chests and doors can use one without allocating anything.
 *
 * Allocation therefore has one hard rule: **never hand out an id the array does
 * not already cover** — grow it first, or the flag is dead on arrival.
 *
 * How the arrays look in practice was taken from the projects on hand rather
 * than assumed: a new project has 21 slots, and the two larger projects have 101
 * and 201 — always `20n + 1`, the extra slot being the unusable index 0. Naming
 * is sparse (one project names 28 of its 200), so a gap in the middle is normal
 * and the natural place to put a new flag.
 *
 * This module is pure — it rewrites a names array and never reads a file.
 */

export const FLAG_KINDS = ['switch', 'variable'] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

/**
 * Slots added at a time when the array has to grow.
 *
 * Matches how the shipped projects are sized — 21, 101, 201 are all `20n + 1` —
 * so a grown file still looks like one the editor wrote.
 */
export const SLOT_BLOCK = 20;

/**
 * A ceiling on growth. **This is ours, not the engine's** — nothing in the
 * corescript caps either array. It exists so a mistyped id cannot turn
 * System.json into a file with a million empty strings in it.
 */
export const MAX_SLOTS = 5000;

export class SwitchError extends Error {}

/** The largest id the engine will let anything write, given this array. */
export function highestUsableId(names: string[]): number {
  return Math.max(0, names.length - 1);
}

/** Whether `setValue` would actually do anything for this id. */
export function isUsableId(names: string[], id: number): boolean {
  return Number.isInteger(id) && id > 0 && id < names.length;
}

/**
 * Compare two flag names.
 *
 * Trimmed and case-insensitive: the editor stores free text, and a caller
 * asking for "Met the mayor" twice in different cases means the same flag both
 * times. Being strict here would quietly allocate a second id for it.
 */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The id already carrying this name, or null. */
export function findFlag(names: string[], name: string): number | null {
  if (name.trim() === '') return null;
  for (let id = 1; id < names.length; id++) {
    if (typeof names[id] === 'string' && sameName(names[id], name)) return id;
  }
  return null;
}

/** Ids with no name on them, in order — the slots free to be claimed. */
export function freeSlots(names: string[]): number[] {
  const free: number[] = [];
  for (let id = 1; id < names.length; id++) {
    if (!names[id] || names[id].trim() === '') free.push(id);
  }
  return free;
}

/** Ids that carry a name, with it. */
export function namedFlags(names: string[]): { id: number; name: string }[] {
  const out: { id: number; name: string }[] = [];
  for (let id = 1; id < names.length; id++) {
    if (names[id] && names[id].trim() !== '') out.push({ id, name: names[id] });
  }
  return out;
}

/**
 * Extend a names array so `id` becomes usable, padding with empty strings the
 * way the editor does. Returns the array unchanged when it is already long
 * enough.
 */
export function growToFit(names: string[], id: number): string[] {
  if (id < names.length) return names;
  if (id > MAX_SLOTS) {
    throw new SwitchError(
      `Id ${id} is past the ${MAX_SLOTS}-slot ceiling this server imposes. The engine has no ` +
        'limit of its own, but growing the array to reach one id that far out is almost ' +
        'always a typo — every slot below it is written to System.json as an empty string.'
    );
  }
  // Round up to the next 20n + 1, which is how every shipped project is sized.
  const needed = id + 1;
  const blocks = Math.ceil((needed - 1) / SLOT_BLOCK);
  const grown = [...names];
  while (grown.length < blocks * SLOT_BLOCK + 1) grown.push('');
  return grown;
}

export interface AllocationResult {
  id: number;
  /** The rewritten array. The input is never mutated. */
  names: string[];
  /** False when an existing flag of that name was handed back instead. */
  created: boolean;
  /** True when the array had to be extended to make the id usable. */
  grew: boolean;
}

export interface AllocateOptions {
  /**
   * Claim this exact id rather than the first free one, growing the array if
   * it does not reach that far. An id already carrying a *different* name is
   * refused — renaming someone else's flag is how two features end up sharing
   * one switch.
   */
  id?: number;
}

/**
 * Get an id for a named flag, creating it if there is not one already.
 *
 * Reusing by name is what makes this safe to call repeatedly: a generator that
 * wants "Village gate open" gets the same switch every run rather than burning
 * a new one each time.
 */
export function allocateFlag(
  names: string[],
  name: string,
  options: AllocateOptions = {}
): AllocationResult {
  if (name.trim() === '') {
    throw new SwitchError(
      'A flag needs a name. An unnamed slot is a free slot, so allocating one without a name ' +
        'would hand back an id that the next allocation would hand out again.'
    );
  }

  const existing = findFlag(names, name);

  if (options.id !== undefined) {
    const { id } = options;
    if (!Number.isInteger(id) || id < 1) {
      throw new SwitchError(
        `Id ${id} is not usable: setValue requires id > 0, so index 0 of the array can never ` +
          'hold a flag.'
      );
    }
    if (existing !== null && existing !== id) {
      throw new SwitchError(
        `"${names[existing]}" is already flag ${existing}. Asking for it at ${id} as well would ` +
          'leave two ids with the same name and no way to tell which one anything meant.'
      );
    }
    const grownNames = growToFit(names, id);
    const occupant = grownNames[id];
    if (occupant && occupant.trim() !== '' && !sameName(occupant, name)) {
      throw new SwitchError(
        `Flag ${id} is already "${occupant}". Renaming it would silently repoint every event ` +
          'that uses it. Free it first, or let a new id be chosen.'
      );
    }
    const out = [...grownNames];
    out[id] = name;
    return {
      id,
      names: out,
      created: existing === null,
      grew: grownNames.length !== names.length,
    };
  }

  if (existing !== null) {
    return { id: existing, names: [...names], created: false, grew: false };
  }

  const free = freeSlots(names);
  if (free.length > 0) {
    const out = [...names];
    out[free[0]] = name;
    return { id: free[0], names: out, created: true, grew: false };
  }

  // Full: the next id is one past the end, which needs the array extended
  // before the engine will let anything write to it.
  const id = names.length;
  const grown = growToFit(names, id);
  grown[id] = name;
  return { id, names: grown, created: true, grew: true };
}

/** Take the name off a flag, freeing the slot without shortening the array. */
export function releaseFlag(names: string[], id: number): string[] {
  if (!isUsableId(names, id)) {
    throw new SwitchError(
      `Flag ${id} is outside the array, which holds ids 1-${highestUsableId(names)}.`
    );
  }
  const out = [...names];
  out[id] = '';
  return out;
}

/** `switches` / `variables` — the System.json key each kind lives under. */
export function systemKey(kind: FlagKind): 'switches' | 'variables' {
  return kind === 'switch' ? 'switches' : 'variables';
}
