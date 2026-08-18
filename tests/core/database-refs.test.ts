import { describe, it, expect } from 'vitest';
import {
  checkDatabaseRefs,
  referencesDatabase,
  namedRows,
  rowCount,
  highestId,
  DatabaseRefError,
  type DatabaseTables,
} from '../../src/core/database-refs.js';

/**
 * Every rule here is an engine guard that silently does nothing:
 *
 *  - `command301`: `if ($dataTroops[troopId])` wraps both the battle setup and
 *    `setEventCallback`, so a bad troop skips the battle *and* every arm.
 *  - `command117`: `if (commonEvent)`.
 *  - `command129` / `320` / `321`: `$gameActors.actor(id)` then `if (actor)`.
 *  - `Game_Party.gainItem`: `itemContainer(null)` is null, so `if (container)`
 *    is false.
 *  - `iterateActorId(0)` iterates the whole party rather than looking anything
 *    up, which is why actorId 0 must not be refused on those commands.
 */

/** A table shaped like a data file: index 0 is null, ids from 1. */
const table = (...rows: ({ name?: string; members?: unknown[] } | null)[]) => [null, ...rows];

const tables: DatabaseTables = {
  troops: table(
    { name: 'Goblin*2', members: [{}, {}] },
    { name: 'Treant', members: [{}] },
    { name: '', members: [] },
  ),
  commonEvents: table({ name: 'Autosave' }, { name: 'Heal' }),
  items: table({ name: 'Potion' }, { name: 'Antidote' }),
  weapons: table({ name: 'Sword' }),
  armors: table({ name: 'Shield' }),
  actors: table({ name: 'Harold' }, { name: 'Therese' }),
  classes: table({ name: 'Hero' }),
  skills: table({ name: 'Attack' }),
  states: table({ name: 'Poison' }),
};

const check = (commands: Record<string, unknown>[]) => checkDatabaseRefs(commands, tables);

describe('referencesDatabase', () => {
  it('knows which command types name a row', () => {
    expect(referencesDatabase('battle_processing')).toBe(true);
    expect(referencesDatabase('shop_processing')).toBe(true);
    expect(referencesDatabase('change_class')).toBe(true);
    expect(referencesDatabase('show_text')).toBe(false);
  });
});

describe('ids that exist', () => {
  it('passes a command naming a real row', () => {
    expect(() => check([{ type: 'battle_processing', troopId: 1 }])).not.toThrow();
    expect(() => check([{ type: 'common_event', eventId: 2 }])).not.toThrow();
    expect(() => check([{ type: 'change_items', itemId: 2, value: 1 }])).not.toThrow();
  });

  it('checks the default the converter would use when the field is absent', () => {
    // convertCommand falls back to troopId 1, which exists here.
    expect(() => check([{ type: 'battle_processing' }])).not.toThrow();
  });

  it('leaves commands that name nothing alone', () => {
    const result = check([{ type: 'show_text', text: 'hello' }]);
    expect(result.commands[0]).toEqual({ type: 'show_text', text: 'hello' });
  });
});

describe('ids that do not', () => {
  it('refuses a troop past the end, saying how many the project has', () => {
    expect(() => check([{ type: 'battle_processing', troopId: 9 }]))
      .toThrow(/troopId 9, which is not in Troops\.json.*3 row\(s\), ids 1-3/s);
  });

  it('says why it matters — the engine skips the command with no error', () => {
    expect(() => check([{ type: 'common_event', eventId: 9 }]))
      .toThrow(/skipped in play with no error anywhere/);
  });

  it('refuses a missing item, weapon, armor, class, skill and state', () => {
    expect(() => check([{ type: 'change_items', itemId: 9 }])).toThrow(/Items\.json/);
    expect(() => check([{ type: 'change_weapons', weaponId: 9 }])).toThrow(/Weapons\.json/);
    expect(() => check([{ type: 'change_armors', armorId: 9 }])).toThrow(/Armors\.json/);
    expect(() => check([{ type: 'change_class', actorId: 1, classId: 9 }])).toThrow(/Classes\.json/);
    expect(() => check([{ type: 'change_skill', actorId: 1, skillId: 9 }])).toThrow(/Skills\.json/);
    expect(() => check([{ type: 'change_state', actorId: 1, stateId: 9 }])).toThrow(/States\.json/);
  });

  it('names the command index so a long list can be fixed', () => {
    expect(() =>
      check([
        { type: 'show_text', text: 'a' },
        { type: 'show_text', text: 'b' },
        { type: 'battle_processing', troopId: 9 },
      ])
    ).toThrow(/command 3/);
  });
});

describe('actor id 0', () => {
  it('is the whole party on the iterateActorEx commands, so it passes', () => {
    // command311/313/314/315/316/318/326 reach iterateActorId, where 0 means
    // every party member rather than an actor id.
    for (const type of [
      'change_hp', 'change_mp', 'change_tp', 'change_exp',
      'change_level', 'change_skill', 'change_state', 'recover_all',
    ]) {
      expect(() => check([{ type, actorId: 0, skillId: 1, stateId: 1 }])).not.toThrow();
    }
  });

  it('is not a party shorthand on the commands that look the actor up directly', () => {
    // command129/320/321 call $gameActors.actor(params[0]) with no 0 case.
    expect(() => check([{ type: 'change_party_member', actorId: 0 }])).toThrow(/Actors\.json/);
    expect(() => check([{ type: 'change_name', actorId: 0, name: 'x' }])).toThrow(/Actors\.json/);
    expect(() => check([{ type: 'change_class', actorId: 0, classId: 1 }])).toThrow(/Actors\.json/);
  });

  it('still refuses a real but missing actor on the party commands', () => {
    expect(() => check([{ type: 'change_hp', actorId: 9 }])).toThrow(/Actors\.json/);
  });
});

describe('shop goods', () => {
  it('checks every row against the table its kind names', () => {
    expect(() => check([{ type: 'shop_processing', goods: [[0, 1], [1, 1], [2, 1]] }]))
      .not.toThrow();
    expect(() => check([{ type: 'shop_processing', goods: [[0, 1], [2, 9]] }]))
      .toThrow(/Armors\.json/);
  });

  it('refuses a kind that is not item, weapon or armor', () => {
    expect(() => check([{ type: 'shop_processing', goods: [[7, 1]] }]))
      .toThrow(/kind 0 item, 1 weapon, 2 armor/);
  });
});

describe('troop names', () => {
  it('rewrites a name to its id', () => {
    const result = check([{ type: 'battle_processing', troopName: 'Treant' }]);

    expect(result.commands[0]).toEqual({ type: 'battle_processing', troopId: 2 });
    expect(result.troops).toEqual([{ name: 'Treant', id: 2 }]);
  });

  it('matches case-insensitively and trimmed, as flag names do', () => {
    expect(check([{ type: 'battle_processing', troopName: '  treant ' }]).commands[0].troopId)
      .toBe(2);
  });

  it('refuses an unknown name rather than allocating one', () => {
    // The difference from a switch: a troop is content, not a slot.
    expect(() => check([{ type: 'battle_processing', troopName: 'Dragon' }]))
      .toThrow(/content, not a slot/);
  });

  it('lists the names that do exist, so the caller can pick', () => {
    expect(() => check([{ type: 'battle_processing', troopName: 'Dragon' }]))
      .toThrow(/1 "Goblin\*2", 2 "Treant"/);
  });

  it('refuses an ambiguous name rather than guessing', () => {
    const dupes: DatabaseTables = {
      troops: table({ name: 'Rats', members: [{}] }, { name: 'rats', members: [{}] }),
    };

    expect(() => checkDatabaseRefs([{ type: 'battle_processing', troopName: 'Rats' }], dupes))
      .toThrow(/2 rows carry \(ids 1, 2\)/);
  });

  it('refuses a troopName on a command with no troop in it', () => {
    expect(() => check([{ type: 'show_text', text: 'a', troopName: 'Treant' }]))
      .toThrow(/no troop for troopName to name/);
  });

  it('never mutates the commands handed to it', () => {
    const commands = [{ type: 'battle_processing', troopName: 'Treant' }];
    check(commands);

    expect(commands[0]).toEqual({ type: 'battle_processing', troopName: 'Treant' });
  });
});

describe('a troop with no members', () => {
  it('is refused, because the battle is won on its first frame', () => {
    // Game_Unit.isAllDead is aliveMembers().length === 0, so checkBattleEnd
    // calls processVictory immediately.
    expect(() => check([{ type: 'battle_processing', troopId: 3 }]))
      .toThrow(/won before it begins/);
  });

  it('cites the engine rather than a house rule', () => {
    expect(() => check([{ type: 'battle_processing', troopId: 3 }]))
      .toThrow(/aliveMembers\(\)\.length === 0/);
  });
});

describe('a table that could not be read', () => {
  it('makes no claim rather than refusing', () => {
    // loadDatabaseTables leaves out a file that is missing or will not parse.
    expect(() => checkDatabaseRefs([{ type: 'battle_processing', troopId: 99 }], {}))
      .not.toThrow();
  });

  it('leaves a troopName alone rather than failing the call', () => {
    const result = checkDatabaseRefs([{ type: 'battle_processing', troopName: 'Treant' }], {});

    expect(result.commands[0].troopId).toBeUndefined();
    expect(result.troops).toHaveLength(0);
  });

  it('notes a troop row with no members list instead of guessing', () => {
    const odd: DatabaseTables = { troops: table({ name: 'Odd' }) };
    const result = checkDatabaseRefs([{ type: 'battle_processing', troopId: 1 }], odd);

    expect(result.notes[0]).toContain('could not be checked');
  });
});

describe('table helpers', () => {
  it('counts rows without the leading null and reports the reach', () => {
    expect(rowCount(tables.troops!)).toBe(3);
    expect(highestId(tables.troops!)).toBe(3);
  });

  it('lists only rows carrying a name', () => {
    // In Wicked Heart the 87 unnamed rows are all empty slots.
    expect(namedRows(tables.troops!)).toEqual([
      { id: 1, name: 'Goblin*2' },
      { id: 2, name: 'Treant' },
    ]);
  });
});

describe('DatabaseRefError', () => {
  it('is what every refusal throws, so the tool can catch just these', () => {
    expect(() => check([{ type: 'battle_processing', troopId: 9 }])).toThrow(DatabaseRefError);
  });
});
