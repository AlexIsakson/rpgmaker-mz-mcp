import { describe, it, expect } from 'vitest';
import {
  checkProject,
  renderConsistencyReport,
  resolveCommonEventSelfSwitchWrites,
  type CommonEventFull,
  type ConsistencyInput,
  type Finding,
} from '../../src/core/consistency.js';
import { buildMapGraph, type LoadedMap } from '../../src/core/map-graph.js';
import { defaultMap, defaultEventPage } from '../../src/templates/defaults.js';
import type { Event, EventCommand, EventPage } from '../../src/schemas/event.js';
import type { MapInfo } from '../../src/schemas/map.js';

const cmd = (code: number, parameters: unknown[] = [], indent = 0): EventCommand => ({
  code,
  indent,
  parameters,
});

const setSwitch = (id: number, on = true) => cmd(121, [id, id, on ? 0 : 1]);
const readSwitch = (id: number) => cmd(111, [0, id, 0]);
const setVariable = (id: number, value = 1) => cmd(122, [id, id, 0, 0, value]);
const readVariable = (id: number) => cmd(111, [1, id, 0, 1, 1]);
const setSelfSwitch = (ch: string) => cmd(123, [ch, 0]);
const callCE = (id: number) => cmd(117, [id]);
const eraseEvent = () => cmd(214, []);
const showText = (text: string) => cmd(401, [text]);
const END = cmd(0);

function page(overrides: Partial<EventPage> = {}): EventPage {
  return { ...defaultEventPage(), ...overrides } as EventPage;
}

function selfSwitchCondition(ch: string) {
  return {
    actorId: 1, actorValid: false, itemId: 1, itemValid: false,
    selfSwitchCh: ch, selfSwitchValid: true,
    switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false,
    variableId: 1, variableValid: false, variableValue: 0,
  };
}

function switchCondition(id: number) {
  return {
    actorId: 1, actorValid: false, itemId: 1, itemValid: false,
    selfSwitchCh: 'A', selfSwitchValid: false,
    switch1Id: id, switch1Valid: true, switch2Id: 1, switch2Valid: false,
    variableId: 1, variableValid: false, variableValue: 0,
  };
}

function makeEvent(id: number, name: string, pages: EventPage[]): Event {
  return { id, name, note: '', x: 0, y: 0, pages };
}

function makeMap(id: number, events: Event[]): LoadedMap {
  const data = defaultMap(10, 10, 1);
  data.events = [null, ...events];
  return { id, data };
}

function makeInfos(count: number): (MapInfo | null)[] {
  const infos: (MapInfo | null)[] = [null];
  for (let i = 1; i <= count; i++) {
    infos[i] = { id: i, expanded: false, name: `Map${i}`, order: i, parentId: 0, scrollX: 0, scrollY: 0 };
  }
  return infos;
}

/** A tileset with passage configured, so R7 stays quiet unless a test wants it. */
const configuredTileset = { id: 1, name: 'Default', flags: [0x10] };

function makeInput(overrides: Partial<ConsistencyInput> = {}): ConsistencyInput {
  return {
    startMapId: 1,
    maps: [],
    mapInfos: makeInfos(1),
    commonEvents: [],
    troopCommandLists: [],
    troopConditionSwitches: [],
    tilesets: [configuredTileset],
    ...overrides,
  };
}

const rulesOf = (findings: Finding[]): string[] => findings.map((f) => f.rule);

describe('switch and variable usage rules', () => {
  it('flags a switch that is checked but never set', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [makeEvent(1, 'Gate', [page({ list: [readSwitch(7), END] })])])],
    }));

    expect(rulesOf(report.findings)).toContain('switch-read-never-written');
    expect(report.findings.find((f) => f.rule === 'switch-read-never-written')?.message).toContain('7');
  });

  it('does not flag a switch that is both set and checked', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [
        makeEvent(1, 'Setter', [page({ list: [setSwitch(7), END] })]),
        makeEvent(2, 'Reader', [page({ list: [readSwitch(7), END] })]),
      ])],
    }));

    expect(rulesOf(report.findings)).not.toContain('switch-read-never-written');
  });

  it('counts a page condition as a read', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [makeEvent(1, 'Gated', [page({ conditions: switchCondition(9) })])])],
    }));

    expect(rulesOf(report.findings)).toContain('switch-read-never-written');
  });

  it('counts an autorun common event switch as a read, not a dead write', () => {
    const commonEvents: CommonEventFull[] = [
      { id: 1, name: 'Ambient', trigger: 2, switchId: 4, list: [END] },
    ];
    const report = checkProject(makeInput({
      maps: [makeMap(1, [makeEvent(1, 'Trigger', [page({ list: [setSwitch(4), END] })])])],
      commonEvents,
    }));

    expect(rulesOf(report.findings)).not.toContain('switch-written-never-read');
  });

  it('counts a troop page condition switch as a read', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [makeEvent(1, 'Setter', [page({ list: [setSwitch(11), END] })])])],
      troopConditionSwitches: [11],
    }));

    expect(rulesOf(report.findings)).not.toContain('switch-written-never-read');
  });

  it('flags a variable that is read but never assigned', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [makeEvent(1, 'Reader', [page({ list: [readVariable(3), END] })])])],
    }));

    expect(rulesOf(report.findings)).toContain('variable-read-never-written');
  });

  it('treats a \\V[n] escape in message text as a variable read', () => {
    // Without this, a display-only variable looks written-but-never-read.
    const report = checkProject(makeInput({
      maps: [makeMap(1, [
        makeEvent(1, 'Counter', [page({ list: [setVariable(5), showText('You have \\V[5] coins.'), END] })]),
      ])],
    }));

    expect(rulesOf(report.findings)).not.toContain('variable-read-never-written');
  });
});

describe('self-switch rules', () => {
  it('flags a page gated on a self-switch the event never sets', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [
        makeEvent(1, 'Chest', [
          page({ list: [END] }),
          page({ conditions: selfSwitchCondition('A'), list: [END] }),
        ]),
      ])],
    }));

    const finding = report.findings.find((f) => f.rule === 'self-switch-never-set');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('error');
  });

  it('does not flag when the event sets the self-switch itself', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [
        makeEvent(1, 'Chest', [
          page({ list: [setSelfSwitch('A'), END] }),
          page({ conditions: selfSwitchCondition('A'), list: [END] }),
        ]),
      ])],
    }));

    expect(rulesOf(report.findings)).not.toContain('self-switch-never-set');
  });

  it('does not flag when a called common event sets it (it runs with the caller\'s event id)', () => {
    const commonEvents: CommonEventFull[] = [
      { id: 1, name: 'Finish Quest', trigger: 0, switchId: 1, list: [setSelfSwitch('A'), END] },
    ];
    const report = checkProject(makeInput({
      maps: [makeMap(1, [
        makeEvent(1, 'Chest', [
          page({ list: [callCE(1), END] }),
          page({ conditions: selfSwitchCondition('A'), list: [END] }),
        ]),
      ])],
      commonEvents,
    }));

    expect(rulesOf(report.findings)).not.toContain('self-switch-never-set');
  });

  it('skips the rule for events containing a Script command', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [
        makeEvent(1, 'Scripted', [
          page({ list: [cmd(355, ['$gameSelfSwitches.setValue([1,1,"A"], true)']), END] }),
          page({ conditions: selfSwitchCondition('A'), list: [END] }),
        ]),
      ])],
    }));

    expect(rulesOf(report.findings)).not.toContain('self-switch-never-set');
    expect(report.hasOpaqueCommands).toBe(true);
  });
});

describe('autorun rules', () => {
  it('flags an autorun page with no way to stop', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [
        makeEvent(1, 'Cutscene', [page({ trigger: 3, list: [showText('Forever...'), END] })]),
      ])],
    }));

    const finding = report.findings.find((f) => f.rule === 'autorun-cannot-stop');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('error');
  });

  it.each([
    ['erase event', eraseEvent()],
    ['self-switch', setSelfSwitch('A')],
    ['switch', setSwitch(3)],
    ['transfer', cmd(201, [0, 2, 0, 0, 0, 0])],
    ['variable', setVariable(1)],
  ])('does not flag an autorun page that can stop via %s', (_label, stopper) => {
    const report = checkProject(makeInput({
      maps: [
        makeMap(1, [makeEvent(1, 'Cutscene', [page({ trigger: 3, list: [stopper, END] })])]),
        makeMap(2, []),
      ],
      mapInfos: makeInfos(2),
    }));

    expect(rulesOf(report.findings)).not.toContain('autorun-cannot-stop');
  });

  it('does not flag non-autorun pages', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [makeEvent(1, 'NPC', [page({ trigger: 0, list: [showText('Hi'), END] })])])],
    }));

    expect(rulesOf(report.findings)).not.toContain('autorun-cannot-stop');
  });
});

describe('reference rules', () => {
  it('flags a call to a common event that does not exist', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [makeEvent(1, 'Caller', [page({ list: [callCE(42), END] })])])],
    }));

    expect(rulesOf(report.findings)).toContain('missing-common-event');
  });

  it('flags a transfer to a map with no data file', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [
        makeEvent(1, 'Door', [page({ list: [cmd(201, [0, 88, 0, 0, 0, 0]), END] })]),
      ])],
    }));

    expect(rulesOf(report.findings)).toContain('transfer-to-missing-map');
  });

  it('flags a map with no path from the start map', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, []), makeMap(2, [])],
      mapInfos: makeInfos(2),
    }));

    expect(rulesOf(report.findings)).toContain('unreachable-map');
  });
});

describe('tileset rules', () => {
  it('flags a used tileset whose tile 0 lacks the star bit', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [])],
      tilesets: [{ id: 1, name: 'Broken', flags: [0] }],
    }));

    expect(rulesOf(report.findings)).toContain('tileset-passage-unconfigured');
  });

  it('ignores tilesets no map uses', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [])],
      tilesets: [configuredTileset, { id: 2, name: 'Unused', flags: [0] }],
    }));

    expect(rulesOf(report.findings)).not.toContain('tileset-passage-unconfigured');
  });
});

describe('renderConsistencyReport', () => {
  it('filters findings below the requested severity', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [
        makeEvent(1, 'Cutscene', [page({ trigger: 3, list: [showText('stuck'), END] })]),
        makeEvent(2, 'Dead', [page({ list: [setSwitch(50), END] })]),
      ])],
    }));

    const errorsOnly = renderConsistencyReport(report, 'error');
    expect(errorsOnly).toContain('autorun-cannot-stop');
    expect(errorsOnly).not.toContain('switch-written-never-read');

    const all = renderConsistencyReport(report, 'info');
    expect(all).toContain('switch-written-never-read');
  });

  it('warns that results are incomplete when script commands are present', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [makeEvent(1, 'S', [page({ list: [cmd(355, ['x']), END] })])])],
    }));

    expect(renderConsistencyReport(report)).toContain('Script / Plugin Commands');
  });

  it('reports a clean project as having no issues', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [makeEvent(1, 'NPC', [page({ list: [showText('Hello'), END] })])])],
    }));

    expect(renderConsistencyReport(report)).toContain('No issues found');
  });
});

describe('flag range and naming', () => {
  // setValue is guarded by `id > 0 && id < $dataSystem.<kind>.length`, so an id
  // from the array length up is silently unwritable.
  const flagNames = {
    switches: ['', 'Met the mayor', '', ''],   // ids 1-3 usable
    variables: ['', '', ''],                   // ids 1-2 usable
  };

  it('flags a write the engine will ignore', () => {
    const report = checkProject(makeInput({
      flagNames,
      maps: [makeMap(1, [makeEvent(1, 'Gate', [page({ list: [setSwitch(9), readSwitch(9), END] })])])],
    }));

    const finding = report.findings.find((f) => f.rule === 'switch-out-of-range');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('reaches 3');
    expect(finding?.message).toContain('does nothing');
  });

  it('flags a read of an id nothing could ever set', () => {
    const report = checkProject(makeInput({
      flagNames,
      maps: [makeMap(1, [makeEvent(1, 'Gate', [page({ list: [readSwitch(40), END] })])])],
    }));

    expect(report.findings.find((f) => f.rule === 'switch-out-of-range')?.message)
      .toContain('always false');
  });

  it('bounds variables against their own array', () => {
    const report = checkProject(makeInput({
      flagNames,
      maps: [makeMap(1, [makeEvent(1, 'Count', [page({ list: [setVariable(5), readVariable(5), END] })])])],
    }));

    expect(rulesOf(report.findings)).toContain('variable-out-of-range');
  });

  it('says nothing about ids inside the array', () => {
    const report = checkProject(makeInput({
      flagNames,
      maps: [makeMap(1, [makeEvent(1, 'Gate', [page({ list: [setSwitch(3), readSwitch(3), END] })])])],
    }));

    expect(rulesOf(report.findings)).not.toContain('switch-out-of-range');
  });

  it('stays silent when System.json was not supplied', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [makeEvent(1, 'Gate', [page({ list: [setSwitch(900), readSwitch(900), END] })])])],
    }));

    expect(rulesOf(report.findings)).not.toContain('switch-out-of-range');
  });

  it('names the flag in the usage findings when it has one', () => {
    const report = checkProject(makeInput({
      flagNames,
      maps: [makeMap(1, [makeEvent(1, 'Gate', [page({ list: [readSwitch(1), END] })])])],
    }));

    expect(report.findings.find((f) => f.rule === 'switch-read-never-written')?.message)
      .toContain('Switch 1 ("Met the mayor")');
  });

  it('leaves an unnamed id bare rather than padding it with "(unnamed)"', () => {
    const report = checkProject(makeInput({
      flagNames,
      maps: [makeMap(1, [makeEvent(1, 'Gate', [page({ list: [readSwitch(2), END] })])])],
    }));

    expect(report.findings.find((f) => f.rule === 'switch-read-never-written')?.message)
      .toMatch(/^Switch 2 is checked/);
  });
});

describe('shop goods rule', () => {
  // command302's own parameters are the first goods row; each 605 that follows
  // is one more. [kind, dataId, priceType, price] with kind 0/1/2.
  const shop = (rows: [number, number][]): EventCommand[] => [
    cmd(302, [...rows[0], 0, 0, false]),
    ...rows.slice(1).map((r) => cmd(605, [...r, 0, 0])),
    END,
  ];

  const databaseIds = {
    items: new Set([7, 8]),
    weapons: new Set([3]),
    armors: new Set([9]),
  };

  it('flags a row pointing at an entry that is not in the database', () => {
    const report = checkProject(makeInput({
      databaseIds,
      maps: [makeMap(1, [makeEvent(1, 'Shop', [page({ list: shop([[0, 7], [0, 99]]) })])])],
    }));

    const finding = report.findings.find((f) => f.rule === 'shop-sells-missing-entry');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('99');
    expect(finding?.where).toContain('Shop');
  });

  it('checks each row against its own database', () => {
    // weapon 7 and armour 7 do not exist even though item 7 does.
    const report = checkProject(makeInput({
      databaseIds,
      maps: [makeMap(1, [makeEvent(1, 'Shop', [page({ list: shop([[0, 7], [1, 7], [2, 9]]) })])])],
    }));

    const found = report.findings.filter((f) => f.rule === 'shop-sells-missing-entry');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('weapon 7');
  });

  it('stays quiet on a shop that sells only things that exist', () => {
    const report = checkProject(makeInput({
      databaseIds,
      maps: [makeMap(1, [makeEvent(1, 'Shop', [page({ list: shop([[0, 7], [1, 3], [2, 9]]) })])])],
    }));

    expect(rulesOf(report.findings)).not.toContain('shop-sells-missing-entry');
  });

  it('only reads a 605 that continues a shop, not one that continues something else', () => {
    // 605 is a generic continuation code. A stray one outside a shop run must
    // not be read as goods.
    const report = checkProject(makeInput({
      databaseIds,
      maps: [makeMap(1, [makeEvent(1, 'Odd', [page({ list: [cmd(605, [0, 99, 0, 0]), END] })])])],
    }));

    expect(rulesOf(report.findings)).not.toContain('shop-sells-missing-entry');
  });

  it('checks shops in common events and troop pages too', () => {
    const report = checkProject(makeInput({
      databaseIds,
      maps: [makeMap(1, [makeEvent(1, 'NPC', [page({ list: [showText('Hi'), END] })])])],
      commonEvents: [{ id: 1, name: 'Travelling merchant', trigger: 0, switchId: 1, list: shop([[0, 42]]) }],
      troopCommandLists: [shop([[2, 77]])],
    }));

    const found = report.findings.filter((f) => f.rule === 'shop-sells-missing-entry');
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.where)).toEqual(
      expect.arrayContaining([expect.stringContaining('common event 1'), 'a troop page'])
    );
  });

  it('says nothing at all when the databases could not be loaded', () => {
    // An absent database must lose the rule, not report every reference missing.
    const report = checkProject(makeInput({
      maps: [makeMap(1, [makeEvent(1, 'Shop', [page({ list: shop([[0, 99]]) })])])],
    }));

    expect(rulesOf(report.findings)).not.toContain('shop-sells-missing-entry');
  });
});

describe('held-item branch rule', () => {
  // command111 cases 8/9/10: hasItem($dataItems[params[1]]) and the equipment
  // pair, which take includeEquip as params[2].
  const holdsItem = (dataId: number) => cmd(111, [8, dataId]);
  const holdsWeapon = (dataId: number) => cmd(111, [9, dataId, false]);
  const holdsArmor = (dataId: number) => cmd(111, [10, dataId, false]);

  const databaseIds = {
    items: new Set([7, 8]),
    weapons: new Set([3]),
    armors: new Set([9]),
  };

  it('flags a lock whose key is not in the database', () => {
    const report = checkProject(makeInput({
      databaseIds,
      maps: [makeMap(1, [makeEvent(1, 'Cellar door', [page({ list: [holdsItem(35), END] })])])],
    }));

    const finding = report.findings.find((f) => f.rule === 'branch-checks-missing-entry');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('item 35');
    expect(finding?.where).toContain('Cellar door');
  });

  it('checks each branch against its own database', () => {
    const report = checkProject(makeInput({
      databaseIds,
      maps: [makeMap(1, [makeEvent(1, 'Gate', [
        page({ list: [holdsItem(7), holdsWeapon(7), holdsArmor(9), END] }),
      ])])],
    }));

    const found = report.findings.filter((f) => f.rule === 'branch-checks-missing-entry');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('weapon 7');
  });

  it('ignores branches that test something other than a held entry', () => {
    // A switch branch's params[1] is a switch id, not a database id — reading it
    // as one would condemn every flag in the project.
    const report = checkProject(makeInput({
      databaseIds,
      maps: [makeMap(1, [makeEvent(1, 'Gate', [
        page({ list: [readSwitch(99), readVariable(99), setSwitch(99), END] }),
      ])])],
    }));

    expect(rulesOf(report.findings)).not.toContain('branch-checks-missing-entry');
  });

  it('says nothing when the databases could not be loaded', () => {
    const report = checkProject(makeInput({
      maps: [makeMap(1, [makeEvent(1, 'Gate', [page({ list: [holdsItem(35), END] })])])],
    }));

    expect(rulesOf(report.findings)).not.toContain('branch-checks-missing-entry');
  });
});

describe('resolveCommonEventSelfSwitchWrites', () => {
  it('follows call chains and survives cycles', () => {
    const commonEvents: CommonEventFull[] = [
      { id: 1, name: 'A', trigger: 0, switchId: 1, list: [callCE(2), END] },
      { id: 2, name: 'B', trigger: 0, switchId: 1, list: [setSelfSwitch('B'), callCE(1), END] },
    ];

    const resolved = resolveCommonEventSelfSwitchWrites(commonEvents);
    expect([...(resolved.get(1)?.writes ?? [])]).toEqual(['B']);
  });
});
