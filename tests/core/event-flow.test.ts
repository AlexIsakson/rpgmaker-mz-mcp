import { describe, it, expect } from 'vitest';
import {
  describeTrigger,
  describePageConditions,
  describeCommand,
  describeCommands,
  collectReferences,
  renderEvent,
  renderEventOverview,
} from '../../src/core/event-flow.js';
import { convertCommand } from '../../src/schemas/event.js';
import { defaultEventPage } from '../../src/templates/defaults.js';
import type { Event, EventCommand, EventPage } from '../../src/schemas/event.js';

const cmd = (code: number, parameters: unknown[] = [], indent = 0): EventCommand => ({
  code,
  indent,
  parameters,
});

function makePage(overrides: Partial<EventPage> = {}): EventPage {
  return { ...defaultEventPage(), ...overrides } as EventPage;
}

function makeEvent(pages: EventPage[], overrides: Partial<Event> = {}): Event {
  return { id: 1, name: 'Test', note: '', x: 0, y: 0, pages, ...overrides };
}

describe('describeTrigger', () => {
  it('names all five engine triggers', () => {
    expect(describeTrigger(0)).toBe('Action Button');
    expect(describeTrigger(1)).toBe('Player Touch');
    expect(describeTrigger(2)).toBe('Event Touch');
    expect(describeTrigger(3)).toBe('Autorun');
    expect(describeTrigger(4)).toBe('Parallel');
  });

  it('falls back for an unknown trigger', () => {
    expect(describeTrigger(9)).toBe('Unknown (9)');
  });
});

describe('describePageConditions', () => {
  it('returns nothing when no condition is valid', () => {
    expect(describePageConditions(makePage())).toEqual([]);
  });

  it('describes each condition kind, and only the valid ones', () => {
    const page = makePage({
      conditions: {
        actorId: 3, actorValid: true,
        itemId: 7, itemValid: true,
        selfSwitchCh: 'B', selfSwitchValid: true,
        switch1Id: 5, switch1Valid: true,
        switch2Id: 6, switch2Valid: false, // not valid -> omitted
        variableId: 2, variableValid: true, variableValue: 10,
      },
    });

    expect(describePageConditions(page)).toEqual([
      'switch 5 is ON',
      'variable 2 >= 10',
      'self-switch B is ON',
      'party has item 7',
      'actor 3 is in the party',
    ]);
  });
});

describe('describeCommand', () => {
  it('describes switch and self-switch writes with ON/OFF', () => {
    expect(describeCommand(cmd(121, [3, 3, 0]))).toBe('Set switch 3 = ON');
    expect(describeCommand(cmd(121, [1, 4, 1]))).toBe('Set switches 1-4 = OFF');
    expect(describeCommand(cmd(123, ['A', 0]))).toBe('Set self-switch A = ON');
  });

  it('describes variable operations including operand kinds', () => {
    expect(describeCommand(cmd(122, [1, 1, 0, 0, 42]))).toBe('Set variable 1 = 42');
    expect(describeCommand(cmd(122, [1, 1, 1, 1, 7]))).toBe('Set variable 1 += variable 7');
    expect(describeCommand(cmd(122, [2, 2, 0, 2, 1, 6]))).toBe('Set variable 2 = random 1..6');
  });

  it('describes conditional branches per condition type', () => {
    expect(describeCommand(cmd(111, [0, 5, 0]))).toBe('If switch 5 is ON');
    expect(describeCommand(cmd(111, [0, 5, 1]))).toBe('If switch 5 is OFF');
    expect(describeCommand(cmd(111, [1, 3, 0, 10, 1]))).toBe('If variable 3 >= 10');
    expect(describeCommand(cmd(111, [1, 3, 1, 4, 5]))).toBe('If variable 3 != variable 4');
    expect(describeCommand(cmd(111, [2, 'C', 0]))).toBe('If self-switch C is ON');
    expect(describeCommand(cmd(111, [4, 2, 0]))).toBe('If actor 2 is in the party');
    expect(describeCommand(cmd(111, [7, 500, 0]))).toBe('If gold >= 500');
    expect(describeCommand(cmd(111, [8, 12]))).toBe('If party has item 12');
  });

  it('distinguishes literal from variable-driven transfers', () => {
    expect(describeCommand(cmd(201, [0, 4, 10, 8, 0, 0])))
      .toBe('Transfer player to map 4 at (10, 8)');
    expect(describeCommand(cmd(201, [1, 20, 21, 22, 0, 0])))
      .toContain('dynamic');
  });

  it('falls back to the raw code for unmapped commands', () => {
    expect(describeCommand(cmd(999))).toBe('[code 999]');
  });
});

describe('describeCommands', () => {
  it('folds 401 text bodies into the parent Show Text', () => {
    const lines = describeCommands(convertCommand({
      type: 'show_text',
      text: 'Hello!\nHow are you?',
    }));

    expect(lines).toEqual(['Show Text: "Hello! / How are you?"']);
  });

  it('splits a >4-line message the way convertCommand emits it', () => {
    // convertCommand starts a new 101 every 4 lines; each becomes its own block.
    const lines = describeCommands(convertCommand({
      type: 'show_text',
      text: 'a\nb\nc\nd\ne',
    }));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Show Text: "a / b / c / d"');
    expect(lines[1]).toBe('Show Text: "e"');
  });

  it('renders choice branches and indentation', () => {
    const lines = describeCommands([
      cmd(102, [['Yes', 'No'], -2, 0, 2, 0]),
      cmd(402, [0, 'Yes']),
      cmd(121, [1, 1, 0], 1),
      cmd(402, [1, 'No']),
      cmd(115, [], 1),
      cmd(404),
      cmd(0),
    ]);

    expect(lines).toEqual([
      'Show Choices: "Yes", "No"',
      'When "Yes"',
      '  Set switch 1 = ON',
      'When "No"',
      '  Exit Event Processing',
      // Shown for the same reason End If is: without it, the command after the
      // block reads as though it were inside the last When.
      'End Choices',
    ]);
  });

  it('renders conditional branch with Else', () => {
    const lines = describeCommands([
      cmd(111, [0, 2, 0]),
      cmd(121, [5, 5, 0], 1),
      cmd(411),
      cmd(121, [5, 5, 1], 1),
      cmd(412),
      cmd(0),
    ]);

    expect(lines).toEqual([
      'If switch 2 is ON',
      '  Set switch 5 = ON',
      'Else',
      '  Set switch 5 = OFF',
      'End If',
    ]);
  });

  it('folds comment bodies and drops end-of-list markers', () => {
    const lines = describeCommands([
      cmd(108, ['first']),
      cmd(408, ['second']),
      cmd(0),
    ]);

    expect(lines).toEqual(['Comment: "first / second"']);
  });

  it('joins a multi-line script into one entry', () => {
    const lines = describeCommands([
      cmd(355, ['const a = 1;']),
      cmd(655, ['doThing(a);']),
    ]);

    expect(lines).toEqual(['Script: const a = 1; / doThing(a);']);
  });
});

describe('collectReferences', () => {
  it('separates reads from writes across conditions and commands', () => {
    const event = makeEvent([
      makePage({
        conditions: {
          actorId: 1, actorValid: false,
          itemId: 1, itemValid: false,
          selfSwitchCh: 'A', selfSwitchValid: true,
          switch1Id: 5, switch1Valid: true,
          switch2Id: 0, switch2Valid: false,
          variableId: 3, variableValid: true, variableValue: 1,
        },
        list: [
          cmd(121, [10, 12, 0]), // writes switches 10,11,12
          cmd(123, ['B', 0]), // writes self-switch B
          cmd(122, [4, 4, 0, 1, 9]), // writes var 4, reads var 9
          cmd(117, [2]), // common event 2
          cmd(111, [0, 6, 0]), // reads switch 6
          cmd(201, [0, 7, 1, 1, 0, 0]), // transfer to map 7
          cmd(0),
        ],
      }),
    ]);

    const refs = collectReferences(event);
    expect(refs.switchesRead).toEqual([5, 6]);
    expect(refs.switchesWritten).toEqual([10, 11, 12]);
    expect(refs.variablesRead).toEqual([3, 9]);
    expect(refs.variablesWritten).toEqual([4]);
    expect(refs.selfSwitchesRead).toEqual(['A']);
    expect(refs.selfSwitchesWritten).toEqual(['B']);
    expect(refs.commonEvents).toEqual([2]);
    expect(refs.transfersTo).toEqual([7]);
    expect(refs.hasDynamicTransfer).toBe(false);
  });

  it('flags variable-driven transfers instead of recording a bogus map id', () => {
    const event = makeEvent([
      makePage({ list: [cmd(201, [1, 20, 21, 22, 0, 0]), cmd(0)] }),
    ]);

    const refs = collectReferences(event);
    expect(refs.transfersTo).toEqual([]);
    expect(refs.hasDynamicTransfer).toBe(true);
  });
});

describe('renderEvent', () => {
  it('includes trigger, conditions, commands, and a reference summary', () => {
    const event = makeEvent(
      [
        makePage({
          trigger: 0,
          conditions: {
            actorId: 1, actorValid: false,
            itemId: 1, itemValid: false,
            selfSwitchCh: 'A', selfSwitchValid: false,
            switch1Id: 4, switch1Valid: true,
            switch2Id: 0, switch2Valid: false,
            variableId: 1, variableValid: false, variableValue: 0,
          },
          list: [cmd(123, ['A', 0]), cmd(0)],
        }),
      ],
      { id: 3, name: 'Shopkeeper', x: 8, y: 6 }
    );

    const text = renderEvent(event);
    expect(text).toContain('Event [3] "Shopkeeper" at (8, 6)');
    expect(text).toContain('Trigger: Action Button');
    expect(text).toContain('Conditions: switch 4 is ON');
    expect(text).toContain('Set self-switch A = ON');
    expect(text).toContain('Writes self-switches: A');
  });

  it('marks a page with no conditions as always eligible', () => {
    const text = renderEvent(makeEvent([makePage()]));
    expect(text).toContain('(none — always eligible)');
  });
});

describe('renderEventOverview', () => {
  it('emits one line per page with trigger and gating conditions', () => {
    const event = makeEvent(
      [
        makePage({ trigger: 3, list: [cmd(121, [1, 1, 0]), cmd(0)] }),
        makePage({
          trigger: 0,
          conditions: {
            actorId: 1, actorValid: false,
            itemId: 1, itemValid: false,
            selfSwitchCh: 'A', selfSwitchValid: true,
            switch1Id: 0, switch1Valid: false,
            switch2Id: 0, switch2Valid: false,
            variableId: 1, variableValid: false, variableValue: 0,
          },
          list: [cmd(0)],
        }),
      ],
      { id: 2, name: 'Gate' }
    );

    const lines = renderEventOverview([event]).split('\n');
    expect(lines[0]).toBe('[2] "Gate" at (0, 0)');
    expect(lines[1]).toBe('    p1: Autorun | when always | 1 command(s)');
    expect(lines[2]).toBe('    p2: Action Button | when self-switch A is ON | 0 command(s)');
  });
});
