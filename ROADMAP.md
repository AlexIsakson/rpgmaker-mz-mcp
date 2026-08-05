# Roadmap

Goal: grow this server from **data editing** (JSON CRUD over a project's `data/` files)
into **project understanding** — spatial reasoning, flow analysis, consistency checking —
and eventually **live engine interaction**.

The ordering below is deliberate: each phase is useful on its own, and the early phases
build the primitives the later ones need.

| # | Feature | Tier | Status |
|---|---------|------|--------|
| 1 | Map as text grid | Data | ✅ Done |
| 2 | Event flow analysis | Data | Planned |
| 3 | Map connection graph | Data | Planned |
| 4 | Logic consistency checker | Data | Planned |
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

## 2. Event flow analysis

A read-only tool summarizing what events actually *do*: per page, the trigger type, the
conditions gating it (switch / variable / self-switch / item / actor), and the command flow
in readable form.

The event command parsing already exists in `src/schemas/event.ts` — this is mostly a new
output shape over data the server already understands, plus page-condition decoding.

Useful on its own, and it's the readable layer that makes #4 diagnosable rather than just
a list of raw findings.

## 3. Map connection graph

Scan every map's events for transfer/teleport commands (code `201`) and build a graph of
how maps link together. Also worth surfacing: which maps are unreachable from the starting
map (`System.json` → `startMapId`), and one-way connections.

Pure static analysis over data already being read. The main subtlety is that transfer
destinations can be specified by variable rather than literal map ID — those can't be
resolved statically and should be reported as "dynamic" rather than silently dropped.

## 4. Logic consistency checker

A linter for RPG Maker-specific footguns. Candidate rules:

- Switches/variables read but never written (and vice versa)
- Self-switches checked but never set (a classic soft-lock: an event whose page condition
  can never become true)
- Transfers targeting a map ID that doesn't exist
- Events with an autorun page and no way to turn it off — locks the player
- Unreachable maps (from #3)
- Items/skills/enemies referencing IDs that no longer exist
- Tilesets whose `flags[0]` lacks the star bit (see [Engine reference](#engine-reference)) —
  ground-layer impassability silently has no effect

Depends on #2 and #3 for the traversal machinery.

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
