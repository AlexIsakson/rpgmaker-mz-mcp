import { describe, it, expect } from 'vitest';
import {
  buildMapGraph,
  renderMapGraph,
  resolveCommonEventTransfers,
  type CommonEventLike,
  type LoadedMap,
  type MapGraphInput,
} from '../../src/core/map-graph.js';
import { defaultMap, defaultEventPage } from '../../src/templates/defaults.js';
import type { EventCommand, Event, EventPage } from '../../src/schemas/event.js';
import type { MapInfo } from '../../src/schemas/map.js';

const transferCmd = (mapId: number, x = 0, y = 0): EventCommand => ({
  code: 201,
  indent: 0,
  parameters: [0, mapId, x, y, 0, 0],
});

const dynamicTransferCmd = (): EventCommand => ({
  code: 201,
  indent: 0,
  parameters: [1, 20, 21, 22, 0, 0],
});

const callCommonEventCmd = (id: number): EventCommand => ({
  code: 117,
  indent: 0,
  parameters: [id],
});

function makeEvent(id: number, name: string, list: EventCommand[]): Event {
  const page: EventPage = { ...defaultEventPage(), list } as EventPage;
  return { id, name, note: '', x: 0, y: 0, pages: [page] };
}

/** Builds a map whose events are the given list. */
function makeMap(id: number, events: Event[]): LoadedMap {
  const data = defaultMap(10, 10, 1);
  data.events = [null, ...events];
  return { id, data };
}

function makeInfos(ids: { id: number; name: string }[]): (MapInfo | null)[] {
  const infos: (MapInfo | null)[] = [null];
  const max = Math.max(...ids.map((i) => i.id));
  for (let i = 1; i <= max; i++) {
    const found = ids.find((entry) => entry.id === i);
    infos[i] = found
      ? { id: i, expanded: false, name: found.name, order: i, parentId: 0, scrollX: 0, scrollY: 0 }
      : null;
  }
  return infos;
}

function makeInput(overrides: Partial<MapGraphInput> = {}): MapGraphInput {
  return {
    startMapId: 1,
    maps: [],
    mapInfos: [null],
    commonEvents: [],
    ...overrides,
  };
}

describe('resolveCommonEventTransfers', () => {
  it('collects direct transfers from a common event', () => {
    const commonEvents: CommonEventLike[] = [
      { id: 1, name: 'Warp', list: [transferCmd(5)] },
    ];
    const resolved = resolveCommonEventTransfers(commonEvents);
    expect(resolved.get(1)).toEqual({ maps: [5], dynamic: false });
  });

  it('follows Call Common Event chains transitively', () => {
    const commonEvents: CommonEventLike[] = [
      { id: 1, name: 'Outer', list: [callCommonEventCmd(2)] },
      { id: 2, name: 'Inner', list: [transferCmd(7)] },
    ];
    const resolved = resolveCommonEventTransfers(commonEvents);
    expect(resolved.get(1)?.maps).toEqual([7]);
  });

  it('terminates on a cycle instead of looping forever', () => {
    const commonEvents: CommonEventLike[] = [
      { id: 1, name: 'A', list: [callCommonEventCmd(2), transferCmd(3)] },
      { id: 2, name: 'B', list: [callCommonEventCmd(1)] },
    ];
    const resolved = resolveCommonEventTransfers(commonEvents);
    expect(resolved.get(1)?.maps).toEqual([3]);
  });

  it('propagates the dynamic flag through the chain', () => {
    const commonEvents: CommonEventLike[] = [
      { id: 1, name: 'Outer', list: [callCommonEventCmd(2)] },
      { id: 2, name: 'Inner', list: [dynamicTransferCmd()] },
    ];
    const resolved = resolveCommonEventTransfers(commonEvents);
    expect(resolved.get(1)?.dynamic).toBe(true);
  });
});

describe('buildMapGraph', () => {
  it('builds edges from direct transfers', () => {
    const graph = buildMapGraph(makeInput({
      maps: [
        makeMap(1, [makeEvent(1, 'Door', [transferCmd(2, 5, 6)])]),
        makeMap(2, []),
      ],
      mapInfos: makeInfos([{ id: 1, name: 'Town' }, { id: 2, name: 'Inn' }]),
    }));

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ from: 1, to: 2, x: 5, y: 6, eventId: 1, eventName: 'Door' });
  });

  it('flags transfers to maps with no data file as dangling', () => {
    const graph = buildMapGraph(makeInput({
      maps: [makeMap(1, [makeEvent(1, 'Broken Door', [transferCmd(99)])])],
      mapInfos: makeInfos([{ id: 1, name: 'Town' }]),
    }));

    expect(graph.edges).toHaveLength(0);
    expect(graph.danglingEdges).toHaveLength(1);
    expect(graph.danglingEdges[0].to).toBe(99);
  });

  it('reports maps with no inbound path as unreachable', () => {
    const graph = buildMapGraph(makeInput({
      maps: [
        makeMap(1, [makeEvent(1, 'Door', [transferCmd(2)])]),
        makeMap(2, []),
        makeMap(3, []), // orphan
      ],
      mapInfos: makeInfos([
        { id: 1, name: 'Town' }, { id: 2, name: 'Inn' }, { id: 3, name: 'Secret' },
      ]),
    }));

    expect(graph.unreachable).toEqual([3]);
  });

  it('treats maps reached only through a common event as reachable', () => {
    const graph = buildMapGraph(makeInput({
      maps: [
        makeMap(1, [makeEvent(1, 'Portal', [callCommonEventCmd(1)])]),
        makeMap(2, []),
      ],
      mapInfos: makeInfos([{ id: 1, name: 'Town' }, { id: 2, name: 'Shrine' }]),
      commonEvents: [{ id: 1, name: 'Warp', list: [transferCmd(2)] }],
    }));

    expect(graph.unreachable).toEqual([]);
    expect(graph.edges[0]).toMatchObject({ from: 1, to: 2, viaCommonEvent: 1 });
  });

  it('follows reachability transitively', () => {
    const graph = buildMapGraph(makeInput({
      maps: [
        makeMap(1, [makeEvent(1, 'A', [transferCmd(2)])]),
        makeMap(2, [makeEvent(1, 'B', [transferCmd(3)])]),
        makeMap(3, []),
      ],
      mapInfos: makeInfos([
        { id: 1, name: 'One' }, { id: 2, name: 'Two' }, { id: 3, name: 'Three' },
      ]),
    }));

    expect(graph.unreachable).toEqual([]);
  });

  it('collects variable-driven transfers separately from edges', () => {
    const graph = buildMapGraph(makeInput({
      maps: [makeMap(1, [makeEvent(4, 'Teleporter', [dynamicTransferCmd()])])],
      mapInfos: makeInfos([{ id: 1, name: 'Town' }]),
    }));

    expect(graph.edges).toHaveLength(0);
    expect(graph.dynamicTransfers).toEqual([
      { from: 1, eventId: 4, eventName: 'Teleporter' },
    ]);
  });

  it('identifies one-way connections but not mutual ones', () => {
    const graph = buildMapGraph(makeInput({
      maps: [
        makeMap(1, [makeEvent(1, 'Out', [transferCmd(2)])]),
        makeMap(2, [makeEvent(1, 'Back', [transferCmd(1)])]),
        makeMap(3, []),
        // 1 -> 3 with no return
        makeMap(4, []),
      ],
      mapInfos: makeInfos([
        { id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }, { id: 4, name: 'D' },
      ]),
    }));

    // 1<->2 is mutual, so not one-way
    expect(graph.oneWay).toEqual([]);
  });

  it('flags a connection with no return transfer as one-way', () => {
    const graph = buildMapGraph(makeInput({
      maps: [
        makeMap(1, [makeEvent(1, 'Pit', [transferCmd(2)])]),
        makeMap(2, []),
      ],
      mapInfos: makeInfos([{ id: 1, name: 'Ledge' }, { id: 2, name: 'Pit Bottom' }]),
    }));

    expect(graph.oneWay).toEqual([{ from: 1, to: 2 }]);
  });

  it('deduplicates identical transfers from the same event', () => {
    const graph = buildMapGraph(makeInput({
      maps: [
        makeMap(1, [makeEvent(1, 'Door', [transferCmd(2, 3, 4), transferCmd(2, 3, 4)])]),
        makeMap(2, []),
      ],
      mapInfos: makeInfos([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]),
    }));

    expect(graph.edges).toHaveLength(1);
  });

  it('marks every map unreachable when the start map has no data file', () => {
    const graph = buildMapGraph(makeInput({
      startMapId: 99,
      maps: [makeMap(1, [])],
      mapInfos: makeInfos([{ id: 1, name: 'Orphan' }]),
    }));

    expect(graph.unreachable).toEqual([1]);
  });
});

describe('renderMapGraph', () => {
  it('renders connections, unreachable maps, and caveats', () => {
    const graph = buildMapGraph(makeInput({
      maps: [
        makeMap(1, [makeEvent(1, 'Door', [transferCmd(2, 5, 6)])]),
        makeMap(2, []),
        makeMap(3, []),
      ],
      mapInfos: makeInfos([
        { id: 1, name: 'Town' }, { id: 2, name: 'Inn' }, { id: 3, name: 'Attic' },
      ]),
    }));

    const text = renderMapGraph(graph);
    expect(text).toContain('Start map: [1] Town');
    expect(text).toContain('-> [2] Inn at (5, 6)');
    expect(text).toContain('[3] Attic');
    expect(text).toContain('Unreachable from the start map');
    expect(text).toContain('Vehicle travel');
  });

  it('notes understated reachability when dynamic transfers exist', () => {
    const graph = buildMapGraph(makeInput({
      maps: [makeMap(1, [makeEvent(1, 'Teleporter', [dynamicTransferCmd()])])],
      mapInfos: makeInfos([{ id: 1, name: 'Town' }]),
    }));

    expect(renderMapGraph(graph)).toContain('reachability may be understated');
  });
});
