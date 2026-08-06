# Roadmap

Goal: grow this server from **data editing** (JSON CRUD over a project's `data/` files)
into **project understanding** — spatial reasoning, flow analysis, consistency checking —
and eventually **live engine interaction**.

The ordering below is deliberate: each phase is useful on its own, and the early phases
build the primitives the later ones need.

| # | Feature | Tier | Status |
|---|---------|------|--------|
| 1 | Map as text grid | Data | ✅ Done |
| 2 | Event flow analysis | Data | ✅ Done |
| 3 | Map connection graph | Data | ✅ Done |
| 4 | Logic consistency checker | Data | ✅ Done |
| 5 | Procedural map generation | Data + autotiles | Planned |
| 6 | Battle simulation | Engine | Exploratory |
| 7 | Live engine automation | Engine | Exploratory |

**Tiers:** *Data* = pure JSON read/write, no engine required (current architecture).
*Engine* = requires driving or reimplementing the RPG Maker MZ runtime — a different
kind of project, tracked here but deliberately fenced off from the CRUD server.

---

## 1. Map as text grid ✅

`get_map_grid` renders a map as ASCII so an AI can reason about layout: walls, ladders,
bushes, counters, damage floors, and event positions, with a coordinate ruler and optional
windowing for large maps.

- `src/schemas/tileset.ts` — models `Tilesets.json`
- `src/core/tileset-reader.ts` — loads passability flags
- `src/core/map-grid.ts` — tile decoding and rendering (pure, unit-tested)
- `src/tools/map-grid-tools.ts` — the MCP tool

Passability is ported from `Game_Map` in the engine source (see [Engine reference](#engine-reference)).

**Known limitation:** passability is computed statically from tileset flags. The engine's
real check (`allTiles`) also includes events standing on a tile, which is runtime state —
a tile reported passable here may still be blocked in-game by an event on it.

---

## 2. Event flow analysis ✅

`describe_event` and `describe_map_events` explain what events actually *do*: per page, the
trigger type, the conditions gating it, and the command flow in readable form.

- `src/core/event-flow.ts` — command-code decoding, condition/trigger naming, reference
  collection (pure, unit-tested)
- `src/tools/event-flow-tools.ts` — the two MCP tools

`src/schemas/event.ts` only converted human-readable → codes; this is the reverse direction.
Command descriptions follow `Game_Interpreter` in the corescript (`command111`, `command122`,
`command201`, ...) so the wording matches engine behavior rather than editor-UI phrasing.

**Built for later phases:** `collectReferences(event)` returns the switches, variables,
self-switches, common events, and transfer destinations an event touches, splitting *reads*
from *writes* — that's the traversal machinery #3 and #4 need. It also flags
variable-driven transfers separately (`hasDynamicTransfer`) rather than recording a
bogus map ID, which is exactly the case #3 has to report as "dynamic".

## 3. Map connection graph ✅

`get_map_graph` builds the world graph from Transfer Player commands (code `201`) and
reports: connections, one-way routes, maps unreachable from `System.json` → `startMapId`,
transfers to maps with no data file, and variable-driven transfers.

- `src/core/map-graph.ts` — graph assembly, common-event resolution, reachability (pure)
- `src/tools/map-graph-tools.ts` — the MCP tool (handles all file loading)

**Transfers can live in common events**, so a map that only calls a common event still gets
an edge — `resolveCommonEventTransfers` walks Call Common Event chains transitively with a
cycle guard. Without this, maps reached only via a common event are falsely reported
unreachable.

**Known limitations**, surfaced in the tool's own output rather than hidden:

- Variable-driven transfers can't be resolved statically, so reachability may be understated.
- Vehicle travel (boat / ship / airship) doesn't use a transfer command and isn't modeled.

## 4. Logic consistency checker ✅

`check_project` runs static analysis across maps, common events, troop pages and tilesets,
reporting findings by severity (filterable with `minSeverity`).

- `src/core/consistency.ts` — the rules (pure, unit-tested)
- `src/tools/consistency-tools.ts` — the MCP tool

| Rule | Severity |
|------|:---:|
| `autorun-cannot-stop` | error |
| `self-switch-never-set` | error |
| `transfer-to-missing-map` | error |
| `missing-common-event` | error |
| `switch-read-never-written` | warning |
| `variable-read-never-written` | warning |
| `unreachable-map` | warning |
| `tileset-passage-unconfigured` | warning |
| `switch-written-never-read` | info |

### Design principle: conservative over clever

A linter that cries wolf gets ignored, so every rule errs toward silence:

- **Script (355/655) and Plugin Commands (356/357) are opaque.** They can set any switch or
  self-switch, so events containing them are skipped by the self-switch and autorun rules,
  and the report states that results are incomplete rather than asserting false confidence.
- **`autorun-cannot-stop` only fires when a page contains none of** Erase Event, Control
  Switch, Control Self Switch, Control Variable, or Transfer Player. Any one of those could
  plausibly end the loop, so their presence silences the rule.
- **`\V[n]` escapes in message text count as variable reads**, otherwise every display-only
  counter would be falsely reported as written-but-never-read.

### Scoping subtleties that would otherwise cause false positives

- **Self-switches are per-(map, event)** — `command123` keys on `[mapId, eventId, ch]`. Only
  the event itself can set its own self-switch, so the rule is per-event, not project-wide.
- **A called common event inherits the caller's `eventId`** (`command117` passes
  `this._eventId`), so its Control Self Switch writes the *caller's* self-switch.
  `resolveCommonEventSelfSwitchWrites` follows those chains transitively with a cycle guard.
- **Switch reads come from more than map events** — common event trigger switches
  (trigger 1/2 use `switchId`) and troop page conditions are reads too. Missing them would
  produce false `switch-written-never-read` findings.

### Still open

Broader database integrity — event commands referencing items, skills, actors, enemies or
troops that no longer exist. The pattern is the same as `missing-common-event`; it just
needs the remaining database files loaded and their valid ID sets checked.

## 5. Procedural map generation

Generate the `data` tile array algorithmically — rooms and corridors, town layouts, interiors.
The generation algorithms themselves (BSP, cellular automata) are well-trodden; the hard part
is **autotiles**.

RPG Maker autotile IDs (≥ 2048) encode which neighbors they connect to, so writing a tile is
not "pick an ID" — every placement has to fix up the shape bits of its neighbors, or the map
renders with broken edges and corners. Worth isolating in its own module (`src/core/autotile.ts`)
with heavy unit tests, independent of any generator that calls it.

Recommended: build and test the autotile fixer *first*, as a tool for painting regions
(`fill_map_region`), then layer generators on top of it.

## 6. Battle simulation *(engine tier)*

Run actual battles to sanity-check difficulty and balance. Two paths:

- **Reimplement** turn order, damage formulas, states/buffs from `Troops.json`, `Enemies.json`,
  `Skills.json`, `Actors.json`. Tractable but only ever approximates the engine, and any
  battle plugin invalidates it.
- **Drive the real engine** (see #7) so plugins are respected by construction.

The second is the honest version of this feature, which is why #7 is its prerequisite rather
than its sibling.

## 7. Live engine automation *(engine tier)*

The biggest lift, and a different discipline from everything above: RPG Maker MZ games run on
NW.js (Chromium), so the game can be driven over the Chrome DevTools Protocol — the same class
of automation as browser tooling.

Capabilities this unlocks: screenshots, simulated input, teleporting the player, reading and
setting live game state (`$gamePlayer`, `$gameSwitches`, `$gameVariables`, `BattleManager`),
and AI test-play.

Notes for whoever picks this up:

- Launch with a remote debugging port, connect over CDP, evaluate JS in the game context.
- This is a *separate transport* from the file I/O the rest of the server uses. Keep it in its
  own module tree and its own tool group so a broken/absent game process can never degrade the
  CRUD tools.
- Process lifecycle (launch, health-check, teardown) is most of the real work, not the
  evaluation itself.

---

## Engine reference

Ground truth for engine behavior is the corescript shipped with the editor, e.g.:

```
C:\Program Files (x86)\Steam\steamapps\common\RPG Maker MZ\corescript\v1.4.4\rmmz_objects.js
```

Prefer reading it over recalling behavior from memory — the bit layouts are easy to get
subtly wrong.

**Map data indexing** (`Game_Map.tileId`):
`data[(z * height + y) * width + x]` — z 0–3 are tile layers (bottom to top), z 4 is shadow,
z 5 is region ID.

**Tileset flags** (`flags[tileId]` in `Tilesets.json`):

| Bit | Meaning |
|-----|---------|
| `0x01` | Impassable from below (down) |
| `0x02` | Impassable from the right (left) |
| `0x04` | Impassable from the left (right) |
| `0x08` | Impassable from above (up) |
| `0x10` | Star `[*]` — no effect on passage, fall through to the next layer down |
| `0x20` | Ladder |
| `0x40` | Bush |
| `0x80` | Counter |
| `0x100` | Damage floor |
| `>> 12` | Terrain tag |

**Passage resolution** (`Game_Map.checkPassage`): walk layers top-down (z3 → z0); skip any
tile whose flag has the star bit; the first non-star tile decides passability and the walk stops.

**Gotcha worth knowing:** in a properly configured tileset, `flags[0]` (the "nothing painted"
tile) is `0x10` — that star bit is what lets empty upper layers fall through to the ground
layer. In a tileset where `flags[0]` is still `0`, the empty upper layers resolve passage
themselves as "open" and any impassability painted on the ground layer has no effect at all,
in this server *and* in the real engine.
