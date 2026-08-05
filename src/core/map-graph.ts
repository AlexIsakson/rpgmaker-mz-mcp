import { extractTransfers, extractCommonEventCalls } from './event-flow.js';
import type { MapData, MapInfo } from '../schemas/map.js';
import type { Event, EventCommand } from '../schemas/event.js';

/**
 * Builds a map-to-map connection graph from Transfer Player commands.
 *
 * Transfers can also live inside common events, so a map that only calls a
 * common event still gets an edge — otherwise reachability reports false
 * "unreachable" results.
 */

export interface LoadedMap {
  id: number;
  data: MapData;
}

export interface CommonEventLike {
  id: number;
  name: string;
  list: EventCommand[];
}

export interface MapGraphInput {
  startMapId: number;
  maps: LoadedMap[];
  mapInfos: (MapInfo | null)[];
  commonEvents: CommonEventLike[];
}

export interface MapEdge {
  from: number;
  to: number;
  x: number;
  y: number;
  eventId: number;
  eventName: string;
  /** Set when the transfer was reached through a Call Common Event. */
  viaCommonEvent?: number;
}

export interface DynamicTransfer {
  from: number;
  eventId: number;
  eventName: string;
  viaCommonEvent?: number;
}

export interface MapNode {
  id: number;
  name: string;
}

export interface MapGraph {
  startMapId: number;
  nodes: MapNode[];
  edges: MapEdge[];
  /** Edges whose destination map has no data file. */
  danglingEdges: MapEdge[];
  dynamicTransfers: DynamicTransfer[];
  /** Existing maps with no transfer path from the start map. */
  unreachable: number[];
  /** Connections with no return transfer. */
  oneWay: { from: number; to: number }[];
}

interface ResolvedCommonEvent {
  maps: number[];
  dynamic: boolean;
}

/**
 * Transitive transfer destinations of each common event, following
 * Call Common Event chains. Cycles contribute nothing rather than looping.
 */
export function resolveCommonEventTransfers(
  commonEvents: CommonEventLike[]
): Map<number, ResolvedCommonEvent> {
  const byId = new Map<number, CommonEventLike>();
  for (const ce of commonEvents) byId.set(ce.id, ce);

  const resolved = new Map<number, ResolvedCommonEvent>();
  const inProgress = new Set<number>();

  function resolve(id: number): ResolvedCommonEvent {
    const cached = resolved.get(id);
    if (cached) return cached;
    if (inProgress.has(id)) return { maps: [], dynamic: false }; // cycle guard

    const ce = byId.get(id);
    if (!ce) return { maps: [], dynamic: false };

    inProgress.add(id);

    const maps = new Set<number>();
    let dynamic = false;

    for (const transfer of extractTransfers(ce.list)) {
      if (transfer.dynamic) dynamic = true;
      else if (transfer.mapId !== null) maps.add(transfer.mapId);
    }

    for (const calledId of extractCommonEventCalls(ce.list)) {
      const inner = resolve(calledId);
      for (const mapId of inner.maps) maps.add(mapId);
      if (inner.dynamic) dynamic = true;
    }

    inProgress.delete(id);

    const result = { maps: [...maps].sort((a, b) => a - b), dynamic };
    resolved.set(id, result);
    return result;
  }

  for (const ce of commonEvents) resolve(ce.id);
  return resolved;
}

export function buildMapGraph(input: MapGraphInput): MapGraph {
  const { startMapId, maps, mapInfos, commonEvents } = input;

  const existingMapIds = new Set(maps.map((m) => m.id));
  const commonEventTransfers = resolveCommonEventTransfers(commonEvents);

  const nodes: MapNode[] = maps
    .map((m) => ({ id: m.id, name: mapInfos[m.id]?.name ?? `Map${m.id}` }))
    .sort((a, b) => a.id - b.id);

  const edges: MapEdge[] = [];
  const dynamicTransfers: DynamicTransfer[] = [];
  const seenEdges = new Set<string>();
  const seenDynamic = new Set<string>();

  const addEdge = (edge: MapEdge): void => {
    const key = `${edge.from}|${edge.to}|${edge.eventId}|${edge.x}|${edge.y}|${edge.viaCommonEvent ?? ''}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push(edge);
  };

  const addDynamic = (entry: DynamicTransfer): void => {
    const key = `${entry.from}|${entry.eventId}|${entry.viaCommonEvent ?? ''}`;
    if (seenDynamic.has(key)) return;
    seenDynamic.add(key);
    dynamicTransfers.push(entry);
  };

  for (const map of maps) {
    const events = map.data.events.filter((e): e is Event => e !== null);

    for (const event of events) {
      for (const page of event.pages) {
        // Direct transfers on this page.
        for (const transfer of extractTransfers(page.list)) {
          if (transfer.dynamic) {
            addDynamic({ from: map.id, eventId: event.id, eventName: event.name });
          } else if (transfer.mapId !== null) {
            addEdge({
              from: map.id,
              to: transfer.mapId,
              x: transfer.x,
              y: transfer.y,
              eventId: event.id,
              eventName: event.name,
            });
          }
        }

        // Transfers reached indirectly through common events.
        for (const calledId of extractCommonEventCalls(page.list)) {
          const resolvedCall = commonEventTransfers.get(calledId);
          if (!resolvedCall) continue;

          for (const mapId of resolvedCall.maps) {
            addEdge({
              from: map.id,
              to: mapId,
              x: -1,
              y: -1,
              eventId: event.id,
              eventName: event.name,
              viaCommonEvent: calledId,
            });
          }
          if (resolvedCall.dynamic) {
            addDynamic({
              from: map.id,
              eventId: event.id,
              eventName: event.name,
              viaCommonEvent: calledId,
            });
          }
        }
      }
    }
  }

  const danglingEdges = edges.filter((e) => !existingMapIds.has(e.to));
  const validEdges = edges.filter((e) => existingMapIds.has(e.to));

  // Reachability from the start map over valid edges.
  const adjacency = new Map<number, Set<number>>();
  for (const edge of validEdges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    adjacency.get(edge.from)!.add(edge.to);
  }

  const reachable = new Set<number>();
  if (existingMapIds.has(startMapId)) {
    const queue = [startMapId];
    reachable.add(startMapId);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of adjacency.get(current) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
  }

  const unreachable = nodes
    .map((n) => n.id)
    .filter((id) => !reachable.has(id))
    .sort((a, b) => a - b);

  // One-way connections: an A->B with no B->A.
  const pairs = new Set(validEdges.map((e) => `${e.from}->${e.to}`));
  const oneWaySet = new Set<string>();
  const oneWay: { from: number; to: number }[] = [];
  for (const edge of validEdges) {
    if (edge.from === edge.to) continue;
    if (pairs.has(`${edge.to}->${edge.from}`)) continue;
    const key = `${edge.from}->${edge.to}`;
    if (oneWaySet.has(key)) continue;
    oneWaySet.add(key);
    oneWay.push({ from: edge.from, to: edge.to });
  }

  return {
    startMapId,
    nodes,
    edges: validEdges,
    danglingEdges,
    dynamicTransfers,
    unreachable,
    oneWay,
  };
}

export function renderMapGraph(graph: MapGraph): string {
  const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
  const label = (id: number): string => `[${id}] ${nameOf.get(id) ?? '(missing map)'}`;

  const parts: string[] = [
    `Map connection graph — ${graph.nodes.length} map(s), ${graph.edges.length} connection(s)`,
    `Start map: ${label(graph.startMapId)}`,
  ];

  parts.push('', '── Connections ──');
  if (graph.edges.length === 0) {
    parts.push('(no transfer connections found)');
  } else {
    const byFrom = new Map<number, MapEdge[]>();
    for (const edge of graph.edges) {
      if (!byFrom.has(edge.from)) byFrom.set(edge.from, []);
      byFrom.get(edge.from)!.push(edge);
    }

    for (const id of [...byFrom.keys()].sort((a, b) => a - b)) {
      parts.push(`${label(id)}`);
      for (const edge of byFrom.get(id)!.sort((a, b) => a.to - b.to)) {
        const via = edge.viaCommonEvent !== undefined
          ? ` via common event ${edge.viaCommonEvent}`
          : ` at (${edge.x}, ${edge.y})`;
        parts.push(`    -> ${label(edge.to)}${via}  [event ${edge.eventId} "${edge.eventName || '(unnamed)'}"]`);
      }
    }
  }

  if (graph.oneWay.length > 0) {
    parts.push('', '── One-way connections (no return transfer) ──');
    for (const { from, to } of graph.oneWay) {
      parts.push(`${label(from)} -> ${label(to)}`);
    }
  }

  if (graph.unreachable.length > 0) {
    parts.push('', '── Unreachable from the start map ──');
    for (const id of graph.unreachable) parts.push(label(id));
  }

  if (graph.danglingEdges.length > 0) {
    parts.push('', '── Transfers to maps that do not exist ──');
    for (const edge of graph.danglingEdges) {
      parts.push(
        `${label(edge.from)} -> map ${edge.to} (no data file)  [event ${edge.eventId} "${edge.eventName || '(unnamed)'}"]`
      );
    }
  }

  if (graph.dynamicTransfers.length > 0) {
    parts.push('', '── Variable-driven transfers (destination not statically known) ──');
    for (const entry of graph.dynamicTransfers) {
      const via = entry.viaCommonEvent !== undefined ? ` via common event ${entry.viaCommonEvent}` : '';
      parts.push(`${label(entry.from)}${via}  [event ${entry.eventId} "${entry.eventName || '(unnamed)'}"]`);
    }
  }

  const caveats: string[] = [];
  if (graph.dynamicTransfers.length > 0) {
    caveats.push('Variable-driven transfers are not followed, so reachability may be understated.');
  }
  caveats.push('Vehicle travel (boat / ship / airship) is not a transfer command and is not modeled.');
  parts.push('', '── Caveats ──', ...caveats.map((c) => `- ${c}`));

  return parts.join('\n');
}
