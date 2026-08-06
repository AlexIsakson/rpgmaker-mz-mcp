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
| 5 | Procedural map generation | Data + autotiles | 🚧 In progress |
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

## 5. Procedural map generation 🚧

> **Status: in progress.** Steps 1 and 2 are done and confirmed against the editor. Step 3
> generates connected, correctly-shaped layouts, but a visual review of the output found the
> resulting maps need work before this can be called finished. The specific problems have not
> been written down yet — capture them here before picking this back up.

Generate the `data` tile array algorithmically — rooms and corridors, town layouts, interiors.
The generation algorithms themselves (BSP, cellular automata) are well-trodden; the hard part
is **autotiles**.

A tile id packs *material* and *shape* together: `kind = (id - 2048) / 48`,
`shape = (id - 2048) % 48`. Writing shape 0 everywhere yields a field of centre pieces with
no edges, which renders as hard seams. Worse, placing one tile changes what its neighbours
should look like, so every write needs a fix-up pass around it.

Built in three steps so the riskiest part is proven before anything depends on it:

### Step 1 — autotile module ✅

`src/core/autotile.ts` — `computeFloorShape` (neighbours → shape), `refreshAutotileShapes`
(recompute a whole layer), `fillRect` (paint + refresh).

The shape numbering was derived from `Tilemap.FLOOR_AUTOTILE_TABLE` in the corescript. That
table maps shape → which quadrants of the source image to draw, and the geometry of those
quadrants is what defines each shape's meaning:

- half-tile `x=0` → left edge, `x=3` → right edge, `y=2` → top edge, `y=5` → bottom edge
- `(2,0)` `(3,0)` `(3,1)` `(2,1)` → inner-corner pieces for TL / TR / BR / BL

Which yields: shapes 0–15 corner bits (TL=1, TR=2, BR=4, BL=8), 16–31 single edges plus their
free corners, 32–45 edge combinations, 46 fully isolated.

`tests/core/autotile.test.ts` embeds a copy of that table and checks **all 256 neighbour
configurations** — decoding the shape our code picks back into geometry and asserting it
matches the neighbours. That makes the mapping verified against the engine's own definition,
not merely self-consistent.

### Step 2 — `fill_map_region` tool ✅

Paints a rectangle with a material, computes shapes, and fixes up the tiles already around
the area, writing to a real map file.

- `src/core/map-layers.ts` — read/write one tile layer of the flat `data` array
- `src/tools/map-paint-tools.ts` — the MCP tool

Refresh is scoped to the painted rect plus a one-tile margin: only tiles within one step of
the change can need a new shape, so filling a corner does not rewrite the whole map. A test
asserts the scoped result is identical to a full refresh.

Verified in the editor with a scene built from **seven separate calls** — the case that
matters, since a later paint has to join tiles written by an earlier one. Includes a
three-material junction (stone / sand / grass meeting at a point), which came out correct.

### Step 3 — generators 🚧 needs work

`generate_map_layout` fills a map with a `dungeon` (rooms joined by L-shaped corridors) or a
`cave` (cellular automata).

- `src/core/mapgen.ts` — seeded RNG, both algorithms, layout → tile grid, ASCII preview
- `src/tools/mapgen-tools.ts` — the MCP tool

**Connectivity is guaranteed by construction, not by luck.** The dungeon connects each new
room to the previous one as it places it; the cave discards everything except its largest
connected region, so there are no sealed-off pockets. Tests assert `fullyConnected` across
many seeds for both — the property most likely to break silently and the one that would
produce an unplayable map.

Generation is driven by a seeded mulberry32 RNG, so a given seed always reproduces the same
layout — reproducible for the caller, and testable here.

**What is verified:** layouts are fully connected, shapes are computed correctly, and output
is deterministic per seed. Those are the mechanical properties, and they hold.

**What is not settled:** whether the maps are actually any *good* to look at and play. A
visual review said they are not there yet. Mechanical correctness was never going to
establish that — see the verification caveat below.

**To pick this back up:** get the specific complaints written down first, then decide whether
they are generator-quality problems (room shapes, corridor routing, cave silhouette, density)
or the structural gaps already listed under "Still open" — most likely the missing wall
height, since an A2-only layout reads as a flat floor pattern rather than a room with walls,
which is probably the single biggest reason a generated map looks unlike a hand-made one.

### Still open

- **Passability is not generated.** The generator paints materials; whether the player can
  walk on them comes from the tileset's passage flags, which are a tileset setting rather
  than map data. A generated "wall" only blocks if that material is configured impassable.
  `get_map_grid` shows what is actually walkable, and `check_project` flags tilesets whose
  passage was never configured.
- **No wall height.** True RPG Maker walls are A3/A4, which need `WALL_AUTOTILE_TABLE` and
  vertical top/bottom pairing. A2-only layouts read as floor-vs-surround, not as rooms with
  raised walls.
- **Town and interior generators.** Building plots, roads, and furnished rooms are a
  different problem from cave/dungeon carving and were left out.

### Scope and open questions

- **A2 ground family only.** Walls (A3/A4) use `WALL_AUTOTILE_TABLE` with different rules and
  vertical top/bottom pairing; waterfalls use a third table. Non-A2 tiles pass through
  untouched rather than being mangled.
- **Out-of-bounds handling is confirmed.** `refreshAutotileShapes` treats neighbours outside
  the map as the same material, so a material runs to the map border with no edge drawn
  there. Checked against the editor: painting a block into a map corner by hand produces the
  identical result. (`outOfBounds: 'different'` remains available.)
- **Shape 47 is never emitted.** Isolated tiles use shape 46 (edges on all four sides).
  Shape 47 draws from the template's top-left tile; its role for A2 is unconfirmed.

### Verification caveat

Unlike items #1–#4, this cannot be fully proven from data. Tile ids can be checked against the
engine's tables — and are — but "does the map actually look right" needs a human opening it in
RPG Maker MZ.

**Pick the test material carefully.** The first visual check used A2 column 0, which is the
plain seamless fill — its edge pieces look identical to its middle pieces, so the render could
not have revealed an error either way. Columns 1–4 are patch materials with visible outlines;
use one of those. A control shape placed away from the map border, next to one touching it,
makes border behaviour a direct comparison rather than a judgement call.

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
