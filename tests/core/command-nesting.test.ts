import { describe, it, expect } from 'vitest';
import {
  assignIndents,
  maxIndent,
  walkCommands,
  isStructuralType,
  NestingError,
  type NestedCommand,
  type WalkCommand,
} from '../../src/core/command-nesting.js';
import { convertCommand } from '../../src/schemas/event.js';

/**
 * The assertions that matter here are made by walking the emitted list with
 * `walkCommands`, a port of `Game_Interpreter.executeCommand` / `skipBranch` /
 * `command111` / `command411` / `command402` / `command413` / `command113`.
 *
 * Checking `assignIndents` against a restatement of its own rules would prove
 * nothing: the bug it fixes was that a *self-consistent* flat list is walked by
 * the engine in a way nobody intended. So the test builds the list the tool
 * builds, hands it to the engine's walk, and asks which commands ran.
 */

/** The pipeline add_event_commands runs: assign indents, convert, terminate. */
function build(commands: NestedCommand[]): WalkCommand[] {
  const out: WalkCommand[] = [];
  for (const { command, indent } of assignIndents(commands)) {
    for (const c of convertCommand(command as { type: string })) {
      out.push({ ...c, indent });
    }
  }
  // Every one of the 3014 corpus lists ends with this, and skipBranch's
  // unguarded `_list[_index + 1]` depends on it.
  out.push({ code: 0, indent: 0, parameters: [] });
  return out;
}

/** The texts of the Show Text bodies that actually ran. */
function spoken(list: WalkCommand[], decisions = {}): string[] {
  return walkCommands(list, decisions)
    .map((i) => list[i])
    .filter((c) => c.code === 401)
    .map((c) => String(c.parameters[0]));
}

describe('a conditional branch gates', () => {
  const list = () =>
    build([
      { type: 'conditional_branch', conditionType: 0, param1: 1, param2: 0 },
      { type: 'show_text', text: 'inside' },
      { type: 'end_branch' },
      { type: 'show_text', text: 'after' },
    ]);

  it('runs the body when the condition holds', () => {
    expect(spoken(list(), { branches: [true] })).toEqual(['inside', 'after']);
  });

  it('skips the body when it does not — the bug this task fixes', () => {
    expect(spoken(list(), { branches: [false] })).toEqual(['after']);
  });

  it('would have run the body anyway at a flat indent', () => {
    // What the tool emitted before: every command at indent 0. skipBranch
    // advances while the *next* command is deeper, and none is.
    const flat: WalkCommand[] = [
      { code: 111, indent: 0, parameters: [0, 1, 0] },
      { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
      { code: 401, indent: 0, parameters: ['inside'] },
      { code: 412, indent: 0, parameters: [] },
      { code: 0, indent: 0, parameters: [] },
    ];

    expect(spoken(flat, { branches: [false] })).toEqual(['inside']);
  });
});

describe('else', () => {
  const list = () =>
    build([
      { type: 'conditional_branch', conditionType: 0, param1: 1, param2: 0 },
      { type: 'show_text', text: 'then' },
      { type: 'else' },
      { type: 'show_text', text: 'otherwise' },
      { type: 'end_branch' },
      { type: 'show_text', text: 'after' },
    ]);

  it('takes the then arm and skips the else arm', () => {
    expect(spoken(list(), { branches: [true] })).toEqual(['then', 'after']);
  });

  it('takes the else arm and skips the then arm', () => {
    expect(spoken(list(), { branches: [false] })).toEqual(['otherwise', 'after']);
  });

  it('sits at the same indent as its branch, as all 9 in the corpus do', () => {
    const placed = assignIndents([
      { type: 'conditional_branch', conditionType: 0, param1: 1 },
      { type: 'show_text', text: 'a' },
      { type: 'else' },
      { type: 'show_text', text: 'b' },
      { type: 'end_branch' },
    ]);
    const at = (type: string) => placed.find((p) => p.command.type === type)?.indent;

    expect(at('conditional_branch')).toBe(0);
    expect(at('else')).toBe(0);
    expect(at('end_branch')).toBe(0);
    expect(at('show_text')).toBe(1);
  });
});

describe('nesting', () => {
  it('gates an inner branch inside an outer one', () => {
    const list = build([
      { type: 'conditional_branch', conditionType: 0, param1: 1, param2: 0 },
      { type: 'show_text', text: 'outer' },
      { type: 'conditional_branch', conditionType: 0, param1: 2, param2: 0 },
      { type: 'show_text', text: 'inner' },
      { type: 'end_branch' },
      { type: 'end_branch' },
      { type: 'show_text', text: 'after' },
    ]);

    expect(spoken(list, { branches: [true, true] })).toEqual(['outer', 'inner', 'after']);
    expect(spoken(list, { branches: [true, false] })).toEqual(['outer', 'after']);
    // The outer branch failing must skip the inner one whole, not just its body.
    expect(spoken(list, { branches: [false] })).toEqual(['after']);
  });

  it('reports how deep it went', () => {
    const placed = assignIndents([
      { type: 'conditional_branch', conditionType: 0, param1: 1 },
      { type: 'conditional_branch', conditionType: 0, param1: 2 },
      { type: 'show_text', text: 'deep' },
      { type: 'end_branch' },
      { type: 'end_branch' },
    ]);

    expect(maxIndent(placed)).toBe(2);
  });
});

describe('loops', () => {
  it('repeats until a break, and repeat_above sits at the loop indent', () => {
    const list = build([
      { type: 'loop' },
      { type: 'show_text', text: 'round' },
      { type: 'conditional_branch', conditionType: 0, param1: 1, param2: 0 },
      { type: 'break_loop' },
      { type: 'end_branch' },
      { type: 'repeat_above' },
      { type: 'show_text', text: 'out' },
    ]);

    // Branch false twice, then true: three passes, then the break.
    expect(spoken(list, { branches: [false, false, true] })).toEqual([
      'round', 'round', 'round', 'out',
    ]);
  });

  it('refuses a break_loop with no loop around it', () => {
    // command113 scans forward for a 413 and, finding none, stops at the end of
    // the list — silently skipping everything after.
    expect(() => assignIndents([{ type: 'break_loop' }])).toThrow(/no loop around it/);
  });
});

describe('choices', () => {
  const list = () =>
    build([
      { type: 'show_choices', choices: ['Yes', 'No'] },
      { type: 'when_choice', index: 0, label: 'Yes' },
      { type: 'show_text', text: 'agreed' },
      { type: 'when_choice', index: 1, label: 'No' },
      { type: 'show_text', text: 'refused' },
      { type: 'end_choices' },
      { type: 'show_text', text: 'after' },
    ]);

  it('runs only the arm that was picked', () => {
    expect(spoken(list(), { choices: [0] })).toEqual(['agreed', 'after']);
    expect(spoken(list(), { choices: [1] })).toEqual(['refused', 'after']);
  });

  it('puts every when at the show_choices indent, as all 27 in the corpus are', () => {
    const placed = assignIndents([
      { type: 'show_choices', choices: ['Yes', 'No'] },
      { type: 'when_choice', index: 0 },
      { type: 'show_text', text: 'a' },
      { type: 'when_choice', index: 1 },
      { type: 'show_text', text: 'b' },
      { type: 'end_choices' },
    ]);

    expect(placed.filter((p) => p.command.type === 'when_choice').map((p) => p.indent))
      .toEqual([0, 0]);
    expect(placed.filter((p) => p.command.type === 'show_text').map((p) => p.indent))
      .toEqual([1, 1]);
  });

  it('refuses a command between show_choices and its first when', () => {
    // All 9 show_choices in the corpus are followed immediately by a 402; a
    // command here runs before the player has chosen anything.
    expect(() =>
      assignIndents([
        { type: 'show_choices', choices: ['Yes'] },
        { type: 'show_text', text: 'too early' },
        { type: 'when_choice', index: 0 },
        { type: 'end_choices' },
      ])
    ).toThrow(/before the player has chosen/);
  });
});

describe('refusals', () => {
  it('names the block that was never closed, and where it opened', () => {
    expect(() =>
      assignIndents([
        { type: 'show_text', text: 'a' },
        { type: 'conditional_branch', conditionType: 0, param1: 1 },
        { type: 'show_text', text: 'b' },
      ])
    ).toThrow(/conditional_branch at command 2 is never closed/);
  });

  it('refuses a closer with nothing open', () => {
    expect(() => assignIndents([{ type: 'end_branch' }]))
      .toThrow(/nothing open to close/);
  });

  it('refuses blocks that cross', () => {
    expect(() =>
      assignIndents([
        { type: 'conditional_branch', conditionType: 0, param1: 1 },
        { type: 'loop' },
        { type: 'end_branch' },
        { type: 'repeat_above' },
      ])
    ).toThrow(/blocks cannot cross/);
  });

  it('refuses an else that belongs to no branch', () => {
    expect(() =>
      assignIndents([
        { type: 'loop' },
        { type: 'else' },
        { type: 'repeat_above' },
      ])
    ).toThrow(/belongs to a conditional_branch/);
  });

  it('refuses a second else on one branch', () => {
    // command411 tests the one stored result, so both arms would behave alike.
    expect(() =>
      assignIndents([
        { type: 'conditional_branch', conditionType: 0, param1: 1 },
        { type: 'else' },
        { type: 'else' },
        { type: 'end_branch' },
      ])
    ).toThrow(/second else/);
  });

  it('refuses an indent set by hand', () => {
    expect(() => assignIndents([{ type: 'show_text', text: 'a', indent: 2 }]))
      .toThrow(NestingError);
  });
});

describe('what the emitted list looks like', () => {
  it('ends every block body with the blank line the editor leaves', () => {
    // All 95 mid-list code-0 commands in the corpus sit immediately before a
    // marker at a shallower indent. This reproduces that.
    const list = build([
      { type: 'conditional_branch', conditionType: 0, param1: 1 },
      { type: 'show_text', text: 'a' },
      { type: 'end_branch' },
    ]);

    const blanks = list
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => c.code === 0 && i < list.length - 1);

    expect(blanks).toHaveLength(1);
    expect(blanks[0].c.indent).toBe(1);
    expect(list[blanks[0].i + 1].code).toBe(412);
    expect(list[blanks[0].i + 1].indent).toBe(0);
  });

  it('keeps a multi-command expansion together at one indent', () => {
    // A message is a 101 plus its 401 body lines; a body line left at indent 0
    // would fall out of the branch and be spoken unconditionally.
    const list = build([
      { type: 'conditional_branch', conditionType: 0, param1: 1 },
      { type: 'show_text', text: 'one\ntwo' },
      { type: 'end_branch' },
    ]);

    for (const c of list.filter((c) => c.code === 101 || c.code === 401)) {
      expect(c.indent).toBe(1);
    }
    expect(spoken(list, { branches: [false] })).toEqual([]);
  });

  it('ends the whole list with the terminator skipBranch depends on', () => {
    const list = build([
      { type: 'conditional_branch', conditionType: 0, param1: 1 },
      { type: 'show_text', text: 'a' },
      { type: 'end_branch' },
    ]);

    expect(list[list.length - 1]).toEqual({ code: 0, indent: 0, parameters: [] });
  });

  it('a branch as the last command would crash the engine without it', () => {
    // skipBranch reads _list[_index + 1] unguarded. This is why all 3014 corpus
    // lists carry a terminator, and why the tool always appends one.
    const unterminated: WalkCommand[] = [{ code: 111, indent: 0, parameters: [0, 1, 0] }];

    expect(() => walkCommands(unterminated, { branches: [false] })).toThrow();
  });
});

describe('isStructuralType', () => {
  it('knows the markers from the actions', () => {
    expect(isStructuralType('conditional_branch')).toBe(true);
    expect(isStructuralType('end_choices')).toBe(true);
    expect(isStructuralType('show_text')).toBe(false);
    expect(isStructuralType('break_loop')).toBe(false);
  });
});

describe('battle result arms', () => {
  const battle = (extra: Record<string, unknown> = {}) => ({
    type: 'battle_processing',
    troopId: 3,
    canEscape: true,
    canLose: true,
    ...extra,
  });

  const list = () =>
    build([
      battle(),
      { type: 'if_win' },
      { type: 'show_text', text: 'won' },
      { type: 'if_escape' },
      { type: 'show_text', text: 'fled' },
      { type: 'if_lose' },
      { type: 'show_text', text: 'lost' },
      { type: 'end_battle' },
      { type: 'show_text', text: 'after' },
    ]);

  it('runs only the arm matching the result BattleManager handed back', () => {
    // endBattle passes 0 win, 1 escape, 2 lose to the callback command301 set.
    expect(spoken(list(), { battles: [0] })).toEqual(['won', 'after']);
    expect(spoken(list(), { battles: [1] })).toEqual(['fled', 'after']);
    expect(spoken(list(), { battles: [2] })).toEqual(['lost', 'after']);
  });

  it('skips every arm when the troop does not exist', () => {
    // command301 only installs the callback inside `if ($dataTroops[troopId])`,
    // so _branch[_indent] is never set and 601/602/603 all skip.
    expect(spoken(list(), { battles: [null] })).toEqual(['after']);
  });

  it('puts the arms at the battle indent and their bodies one deeper', () => {
    const placed = assignIndents([
      battle(),
      { type: 'if_win' },
      { type: 'show_text', text: 'won' },
      { type: 'end_battle' },
    ]);
    const at = (type: string) => placed.find((p) => p.command.type === type)?.indent;

    expect(at('battle_processing')).toBe(0);
    expect(at('if_win')).toBe(0);
    expect(at('end_battle')).toBe(0);
    expect(at('show_text')).toBe(1);
  });

  it('leaves a bare battle_processing alone — 2 of the 13 in the corpus have no arms', () => {
    const placed = assignIndents([
      battle({ canLose: false }),
      { type: 'show_text', text: 'after' },
    ]);

    expect(placed.map((p) => p.indent)).toEqual([0, 0]);
  });

  it('runs the commands after an armless battle unconditionally', () => {
    const flat = build([battle({ canLose: false }), { type: 'show_text', text: 'after' }]);

    expect(spoken(flat, { battles: [0] })).toEqual(['after']);
    expect(spoken(flat, { battles: [2] })).toEqual(['after']);
  });
});

describe('battle refusals', () => {
  const battle = (extra: Record<string, unknown> = {}) => ({
    type: 'battle_processing',
    troopId: 3,
    canLose: true,
    ...extra,
  });

  it('refuses an if_lose arm the engine can never reach', () => {
    // updateBattleEnd sends a party wipe to Scene_Gameover unless canLose, so
    // the interpreter never resumes to run the arm.
    expect(() =>
      assignIndents([
        battle({ canLose: false }),
        { type: 'if_lose' },
        { type: 'show_text', text: 'lost' },
        { type: 'end_battle' },
      ])
    ).toThrow(/Scene_Gameover/);
  });

  it('accepts an escape arm on a no-escape battle, which is unusual but reachable', () => {
    // Result 1 also comes from Abort Battle (command340) on a troop page, which
    // does not consult canEscape.
    expect(() =>
      assignIndents([
        battle({ canEscape: false }),
        { type: 'if_escape' },
        { type: 'show_text', text: 'aborted' },
        { type: 'end_battle' },
      ])
    ).not.toThrow();
  });

  it('refuses arms out of order', () => {
    expect(() =>
      assignIndents([
        battle(),
        { type: 'if_lose' },
        { type: 'if_win' },
        { type: 'end_battle' },
      ])
    ).toThrow(/puts if_win after if_lose/);
  });

  it('refuses a repeated arm', () => {
    expect(() =>
      assignIndents([
        battle(),
        { type: 'if_win' },
        { type: 'if_win' },
        { type: 'end_battle' },
      ])
    ).toThrow(/second if_win/);
  });

  it('refuses a command between the battle and its first arm', () => {
    expect(() =>
      assignIndents([
        battle(),
        { type: 'show_text', text: 'too early' },
        { type: 'if_win' },
        { type: 'end_battle' },
      ])
    ).toThrow(/before the battle result is known/);
  });

  it('refuses an unclosed battle block', () => {
    expect(() =>
      assignIndents([battle(), { type: 'if_win' }, { type: 'show_text', text: 'won' }])
    ).toThrow(/battle_processing at command 1 is never closed/);
  });

  it('refuses an if_win with no battle open', () => {
    expect(() => assignIndents([{ type: 'if_win' }])).toThrow(/nothing open for it to divide/);
  });
});
