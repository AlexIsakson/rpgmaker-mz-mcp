/**
 * Commands that name a row of the database — and what happens when it is not
 * there.
 *
 * The engine's habit here is consistent and it is the reason this module
 * exists: **it guards the lookup and then does nothing.** Every one of these is
 * from v1.9.0 `rmmz_objects.js`:
 *
 * ```js
 * command117: const commonEvent = $dataCommonEvents[params[0]]; if (commonEvent) {...}
 * command301: if ($dataTroops[troopId]) { BattleManager.setup(...); ... }
 * command129: const actor = $gameActors.actor(params[0]); if (actor) {...}
 * command321: if (actor && $dataClasses[params[1]]) {...}
 * gainItem:   const container = this.itemContainer(item); if (container) {...}
 * ```
 *
 * No error, no log, no visible difference — the command is simply skipped. A
 * generated ambush whose troop id is past the end of Troops.json is a player
 * walking down a road where nothing happens.
 *
 * `battle_processing` is the worst of them, because the guard also wraps the
 * event callback: `BattleManager.setEventCallback` is inside the same
 * `if ($dataTroops[troopId])`, so `_branch[_indent]` is never set and **every
 * if_win / if_escape / if_lose arm is skipped too**. Confirmed by walking a real
 * list with the interpreter port in `command-nesting.ts`.
 *
 * **Measured across the databases on hand** — the `newdata` reference project
 * (what a new project ships) and `Wicked Heart`:
 *
 * | | troops | common events | actors | classes | items | weapons | armors | skills | states |
 * |---|---|---|---|---|---|---|---|---|---|
 * | new project | **5** | **4** | 8 | 8 | 30 | 50 | 100 | 235 | 30 |
 * | Wicked Heart | 100 | 40 | 10 | 10 | 150 | 50 | 110 | 350 | 40 |
 *
 * The small tables are where this bites. A new project has **5 troops and 4
 * common events**, so an id chosen without looking is past the end far more
 * easily than the 235-row skill list would suggest.
 *
 * **Troops can be named**, and the measurement says naming them is not a
 * partial solution. In `Wicked Heart`, 13 of the 100 troop rows carry a name
 * and 87 do not — but the split is exactly by whether the row is real:
 * **13 named all have members, 87 unnamed all have zero members, with no row on
 * either diagonal.** The unnamed rows are empty slots the editor allocated, not
 * troops. So every troop that exists is named, in both projects, with no
 * duplicate names in either.
 *
 * That empty-slot case is a second silent failure and it is checked too. A row
 * with no members is truthy, so `command301` starts the battle — and
 * `Game_Unit.isAllDead` is `aliveMembers().length === 0`, which is true at once,
 * so `BattleManager.checkBattleEnd` calls `processVictory()` on the first frame.
 * An empty troop is a battle won before it begins.
 *
 * This module is pure: it is handed the loaded tables and returns text.
 */

import { battleDesignationOf } from './designation.js';

export const DATABASE_NAMES = [
  'troops',
  'commonEvents',
  'items',
  'weapons',
  'armors',
  'actors',
  'classes',
  'skills',
  'states',
] as const;

export type DatabaseName = (typeof DATABASE_NAMES)[number];

export class DatabaseRefError extends Error {}

/** As much of a database row as this module looks at. */
export interface DatabaseRow {
  id?: number;
  name?: string;
  /** Troops only — an empty one is a battle that ends on the first frame. */
  members?: unknown[];
}

/**
 * The loaded tables. A table left out is one the caller could not read, and is
 * skipped rather than treated as empty — failing a whole command list over an
 * unreadable Skills.json would be worse than the bug.
 */
export type DatabaseTables = Partial<Record<DatabaseName, (DatabaseRow | null)[]>>;

/** How each command names a row. */
interface FieldRef {
  /** The field on the human-readable command. */
  field: string;
  db: DatabaseName;
  /** What convertCommand uses when the field is absent. */
  fallback: number;
  /**
   * True where the engine reads 0 as "every party member" rather than as an
   * actor id — the `iterateActorId` path, which commands 311, 313, 314, 315,
   * 316, 318 and 326 all reach through `iterateActorEx`. Commands 129, 320 and
   * 321 call `$gameActors.actor(params[0])` directly and have no such meaning.
   */
  zeroMeansParty?: boolean;
}

const ACTOR_EX: FieldRef = { field: 'actorId', db: 'actors', fallback: 0, zeroMeansParty: true };
const ACTOR_DIRECT: FieldRef = { field: 'actorId', db: 'actors', fallback: 1 };

const REFS: Record<string, FieldRef[]> = {
  battle_processing: [{ field: 'troopId', db: 'troops', fallback: 1 }],
  common_event: [{ field: 'eventId', db: 'commonEvents', fallback: 1 }],
  change_items: [{ field: 'itemId', db: 'items', fallback: 1 }],
  change_weapons: [{ field: 'weaponId', db: 'weapons', fallback: 1 }],
  change_armors: [{ field: 'armorId', db: 'armors', fallback: 1 }],
  change_party_member: [ACTOR_DIRECT],
  change_name: [ACTOR_DIRECT],
  change_class: [ACTOR_DIRECT, { field: 'classId', db: 'classes', fallback: 1 }],
  change_skill: [ACTOR_EX, { field: 'skillId', db: 'skills', fallback: 1 }],
  change_state: [ACTOR_EX, { field: 'stateId', db: 'states', fallback: 1 }],
  change_hp: [{ ...ACTOR_EX, fallback: 1 }],
  change_mp: [{ ...ACTOR_EX, fallback: 1 }],
  change_tp: [{ ...ACTOR_EX, fallback: 1 }],
  change_exp: [ACTOR_EX],
  change_level: [ACTOR_EX],
  recover_all: [ACTOR_EX],
};

/** Shop goods are `[kind, dataId]`, kind 0 item, 1 weapon, 2 armor. */
const GOODS_KIND: DatabaseName[] = ['items', 'weapons', 'armors'];

const LABELS: Record<DatabaseName, string> = {
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

/** Whether this command type names a database row at all. */
export function referencesDatabase(type: string): boolean {
  return type === 'shop_processing' || REFS[type] !== undefined;
}

/** Rows that actually exist, ignoring the null at index 0 the editor writes. */
export function rowCount(table: (DatabaseRow | null)[]): number {
  return table.filter((row) => row !== null && row !== undefined).length;
}

/** The highest id the table reaches, which is its length minus one. */
export function highestId(table: (DatabaseRow | null)[]): number {
  return Math.max(0, table.length - 1);
}

/** Exported for `requirePageConditionRefs`, which checks the same shape outside a command list. */
export function exists(table: (DatabaseRow | null)[] | undefined, id: number): boolean {
  if (table === undefined) return true; // not loaded — no claim either way
  return id >= 0 && id < table.length && table[id] !== null && table[id] !== undefined;
}

const ordinal = (index: number) => `command ${index + 1}`;

/** Named rows, for the "did you mean" line and for name lookup. */
export function namedRows(table: (DatabaseRow | null)[]): { id: number; name: string }[] {
  const out: { id: number; name: string }[] = [];
  for (let id = 0; id < table.length; id++) {
    const row = table[id];
    const name = row?.name?.trim() ?? '';
    if (name !== '') out.push({ id, name });
  }
  return out;
}

export interface TroopResolution {
  name: string;
  id: number;
}

export interface DatabaseCheckResult {
  /** Commands with any `troopName` rewritten to a `troopId`. Never mutated. */
  commands: Record<string, unknown>[];
  /** One entry per troop name that was looked up. */
  troops: TroopResolution[];
  notes: string[];
}

/**
 * Rewrite troop names to ids and refuse any command naming a row that is not
 * there.
 *
 * Unlike a switch, a troop is **content, not a slot** — there is nothing
 * sensible to allocate, so an unknown name is refused rather than created. That
 * is the whole difference from `resolveCommandFlags`.
 */
export function checkDatabaseRefs(
  commands: Record<string, unknown>[],
  tables: DatabaseTables
): DatabaseCheckResult {
  const out: Record<string, unknown>[] = [];
  const troops: TroopResolution[] = [];
  const notes: string[] = [];

  for (let i = 0; i < commands.length; i++) {
    const command = { ...commands[i] };
    const type = typeof command.type === 'string' ? command.type : '';

    if (command.troopName !== undefined) {
      if (type !== 'battle_processing') {
        throw new DatabaseRefError(
          `${ordinal(i)} (${type || 'no type'}) has no troop for troopName to name. Only ` +
            'battle_processing takes one.'
        );
      }
      if (battleDesignationOf(command) !== 0) {
        throw new DatabaseRefError(
          `${ordinal(i)} gives troopName as well as a variable or encounter-table troop. ` +
            'command301 reads params[0] and then takes exactly one source — pick one.'
        );
      }
      const resolved = resolveTroopName(command.troopName, tables.troops, i);
      if (resolved !== null) {
        command.troopId = resolved.id;
        troops.push(resolved);
      }
      delete command.troopName;
    }

    // A battle whose troop comes from a variable or from the encounter table
    // has no static id to check. Say so rather than checking the fallback and
    // reporting a pass that means nothing.
    const battleDesignation = type === 'battle_processing' ? battleDesignationOf(command) : 0;
    if (battleDesignation !== 0) {
      const source =
        battleDesignation === 1 ? 'from a variable' : "from the map's encounter table";
      notes.push(
        `Note: ${ordinal(i)} takes its troop ${source}, so Troops.json cannot be checked ` +
          "here — whatever id turns up at runtime lands in command301's " +
          '`if ($dataTroops[troopId])`, and a miss is silent.'
      );
    }

    for (const ref of REFS[type] ?? []) {
      if (battleDesignation !== 0 && ref.db === 'troops') continue;
      const raw = command[ref.field];
      const id = typeof raw === 'number' ? raw : ref.fallback;
      if (ref.zeroMeansParty && id === 0) continue;
      requireRow(tables, ref.db, id, i, type, `${ref.field} ${id}`);
    }

    if (type === 'shop_processing') checkGoods(command, tables, i);
    if (type === 'battle_processing' && battleDesignation === 0) {
      checkTroopHasMembers(command, tables, i, notes);
    }

    out.push(command);
  }

  return { commands: out, troops, notes };
}

function resolveTroopName(
  raw: unknown,
  table: (DatabaseRow | null)[] | undefined,
  index: number
): TroopResolution | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new DatabaseRefError(`${ordinal(index)} has an empty troopName.`);
  }
  if (table === undefined) return null; // Troops.json unreadable — leave the id alone

  const wanted = raw.trim().toLowerCase();
  const matches = namedRows(table).filter((row) => row.name.trim().toLowerCase() === wanted);

  if (matches.length === 0) {
    const named = namedRows(table);
    throw new DatabaseRefError(
      `${ordinal(index)} names troop "${raw}", which is not in Troops.json. A troop is content, ` +
        'not a slot, so there is nothing to allocate — it has to exist first. ' +
        (named.length === 0
          ? 'No troop in this project carries a name.'
          : `Named troops here: ${named.map((r) => `${r.id} "${r.name}"`).join(', ')}.`)
    );
  }
  if (matches.length > 1) {
    throw new DatabaseRefError(
      `${ordinal(index)} names troop "${raw}", which ${matches.length} rows carry ` +
        `(ids ${matches.map((m) => m.id).join(', ')}). Use troopId to say which.`
    );
  }
  return { name: matches[0].name, id: matches[0].id };
}

function requireRow(
  tables: DatabaseTables,
  db: DatabaseName,
  id: number,
  index: number,
  type: string,
  subject: string
): void {
  const table = tables[db];
  if (exists(table, id)) return;

  // Id 0 is never a row — the editor writes null there — so a caller who meant
  // "everyone" has reached a command where that shorthand does not exist.
  const zeroHint =
    id === 0 && db === 'actors'
      ? ' Id 0 means the whole party only on the commands that go through ' +
        'iterateActorId (change_hp, change_state, recover_all and the rest); this one calls ' +
        '$gameActors.actor directly, so it needs a real actor.'
      : '';

  throw new DatabaseRefError(
    `${ordinal(index)} (${type}) names ${subject}, which is not in ${LABELS[db]} — that ` +
      `file holds ${rowCount(table!)} row(s), ids 1-${highestId(table!)}. The engine guards ` +
      'every one of these lookups and does nothing when it fails, so this command would be ' +
      `skipped in play with no error anywhere.${zeroHint}`
  );
}

function checkGoods(
  command: Record<string, unknown>,
  tables: DatabaseTables,
  index: number
): void {
  const goods = command.goods;
  if (!Array.isArray(goods)) return;
  for (const row of goods) {
    if (!Array.isArray(row)) continue;
    const kind = typeof row[0] === 'number' ? row[0] : 0;
    const dataId = typeof row[1] === 'number' ? row[1] : 0;
    const db = GOODS_KIND[kind];
    if (db === undefined) {
      throw new DatabaseRefError(
        `${ordinal(index)} (shop_processing) has a goods row of kind ${kind}. Shop goods are ` +
          'kind 0 item, 1 weapon, 2 armor.'
      );
    }
    const kindName = ['item', 'weapon', 'armor'][kind];
    requireRow(tables, db, dataId, index, 'shop_processing', `a goods row stocking ${kindName} ${dataId}`);
  }
}

/**
 * Refuse a page's `itemId` / `actorId` condition when it names a row that is
 * not there.
 *
 * Same guard-then-do-nothing shape as `requireRow`, just outside a command
 * list: `Game_Event.meetsConditions` reads `$dataItems[c.itemId]` and
 * `$gameActors.actor(c.actorId)` straight into a truthiness/membership check,
 * so a bad id does not fail the page load — it makes the condition
 * permanently false. For a single-page event that is a page that silently
 * never shows; for a second page gating new behaviour, it is a page that
 * silently never takes over from the first.
 *
 * `itemId` / `actorId` are `undefined` when that condition kind was not set —
 * the caller passes exactly what `resolvePageConditions` marked `*Valid`.
 */
export function requirePageConditionRefs(
  itemId: number | undefined,
  actorId: number | undefined,
  tables: DatabaseTables,
  subject: string
): void {
  if (itemId !== undefined && !exists(tables.items, itemId)) {
    const table = tables.items!;
    throw new DatabaseRefError(
      `${subject} names item ${itemId}, which is not in Items.json — that file holds ` +
        `${rowCount(table)} row(s), ids 1-${highestId(table)}. Game_Event.meetsConditions reads ` +
        '$dataItems[itemId] straight into a truthiness check, so a bad id does not error — it ' +
        'makes the condition permanently false.'
    );
  }
  if (actorId !== undefined && !exists(tables.actors, actorId)) {
    const table = tables.actors!;
    throw new DatabaseRefError(
      `${subject} names actor ${actorId}, which is not in Actors.json — that file holds ` +
        `${rowCount(table)} row(s), ids 1-${highestId(table)}. Game_Event.meetsConditions calls ` +
        '$gameActors.actor(actorId) and checks party membership, so a bad id is the same silent ' +
        'always-false condition.'
    );
  }
}

/**
 * A troop row with no members is truthy, so the battle starts — and
 * `Game_Unit.isAllDead()` is `aliveMembers().length === 0`, true on the first
 * frame, so `checkBattleEnd` goes straight to `processVictory()`.
 *
 * Refused rather than noted: a battle that is won before it begins is never
 * what the caller meant, and nothing at runtime would tell them. All 87 unnamed
 * rows in `Wicked Heart` are exactly this — slots the editor allocated and
 * nobody filled.
 */
function checkTroopHasMembers(
  command: Record<string, unknown>,
  tables: DatabaseTables,
  index: number,
  notes: string[]
): void {
  const table = tables.troops;
  if (table === undefined) return;
  const id = typeof command.troopId === 'number' ? command.troopId : 1;
  const row = table[id];
  if (!row) return; // already refused by requireRow
  if (!Array.isArray(row.members)) {
    notes.push(
      `Note: troop ${id} in Troops.json has no members list, so it could not be checked for ` +
        'being empty.'
    );
    return;
  }
  if (row.members.length > 0) return;

  const named = namedRows(table);
  throw new DatabaseRefError(
    `${ordinal(index)} (battle_processing) names troop ${id}, which has no members. ` +
      'Game_Unit.isAllDead is `aliveMembers().length === 0`, so BattleManager.checkBattleEnd ' +
      'calls processVictory on the first frame — the battle is won before it begins. ' +
      (named.length === 0
        ? 'No troop in this project has a name.'
        : `Troops with members here: ${named.map((r) => `${r.id} "${r.name}"`).join(', ')}.`)
  );
}
