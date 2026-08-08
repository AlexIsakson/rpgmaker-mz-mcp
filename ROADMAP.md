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
> resulting maps need work before this can be called finished. The specific problems are now
> written down — see [Visual review findings](#visual-review-findings).

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

### Visual review findings

Method: every map below was built by driving the real server over stdio MCP, then rendered to
a PNG by a script that ports `Tilemap._addAutotile` / `_addNormalTile` from `rmmz_core.js` and
reads `FLOOR_/WALL_/WATERFALL_AUTOTILE_TABLE` straight out of the corescript, so the render is
what the engine would draw. Ground truth for "what a good map looks like" is the 293 hand-made
sample maps shipped with the editor (`RPG Maker MZ/samplemaps/`), which are readable map JSON
and can be measured, not just looked at.

Ordered by how much each one costs the finished map.

**1. Transparent A2 materials written to layer 0 leave holes.** Only some A2 kinds are opaque
ground; the rest are overlays whose edge pieces are transparent and are meant to sit on an
upper layer above a ground tile. Painted on layer 0 they render as the map background — which
is black in game. Measuring edge-piece alpha in `Outside_A2`: kinds 16-19, 24-27, 32-35, 40-43
and 45 are opaque; 20, 22, 28, 30, 36-39, 44, 46, 47 are overlays; 21, 23, 29, 31 are nearly
empty. **The split is per-tileset, not a fixed column rule** — `World_A2` has overlays in
completely different slots and `Dungeon_A2` is almost all opaque — so this cannot be hardcoded.
The server would have to read the tileset PNG from `img/tilesets/`, or ship a per-tileset
material catalogue. This is the direct cause of the black streets in the earlier hand-built
"City Level 5" test map.

**2. The shadow plane (z=4) is never written, and cannot be.** 285 of the 293 sample maps use
it. Across 16,829 sample shadow tiles, **81.6% use bit pattern `5`** (the left half of the tile
darkened) and **83.7% sit immediately to the right of a wall tile** — that is the editor's
auto-shadow, and it is a dozen lines to reproduce:

> for every tile that is not itself an A3/A4 tile but whose left neighbour is one, set
> `data[(4 * height + y) * width + x] = 5`.

`fill_map_region` caps `layer` at 0-3, so the shadow plane is unreachable through the tools at
all. Adding shadows to a generated town was the single largest visual improvement of anything
tried here.

**3. No walls means no buildings.** Already listed under "Still open", and confirmed as the
biggest gap: a town is roof blocks sitting on wall blocks, both A3. The shape rule is
straightforward and was verified by rendering — `WALL_AUTOTILE_TABLE`, shape bits left `1`,
up `2`, right `4`, down `8`, set on each side whose neighbour is a different material.

**4. A3 pairs each roof with the wall 8 kinds below it.** The sheet is laid out as
roof row / wall row / roof row / wall row, and the sample maps follow the pairing
overwhelmingly: kind 49 sits above 57 (105 tiles), 52 above 60 (74), 67 above 75 (119), 50
above 58 (37). `wallKind = roofKind + 8` is the right default; picking the two independently
is what makes hand-assembled buildings look mismatched.

**5. Only layer 0 is used.** Sample town maps carry 10-60% of their tiles on layers 2 and 3 —
tree canopies, props, awnings, anything the player walks behind. A single-layer map cannot
have depth no matter how good the layout is.

**6. Cave and dungeon silhouettes.** The cave defaults (`fillProbability 0.45`,
`smoothingSteps 4`) over-smooth into one large open blob with a nearly convex outline; there is
no interior structure and nothing to navigate around. The dungeon is axis-aligned rectangles
joined by one-tile corridors, all at one elevation, with no doorways, no variation in room
shape and no dead ends worth exploring.

**7. Everything the generator emits is a hard-edged rectangle.** Hand-made maps have almost no
straight material boundaries. Ground patches want ragged edges, roads want to bend and change
width, and rooms want to be something other than perfect rectangles.

**8. Nothing frames the map edge.** Generated maps run to the border and stop. Sample maps are
enclosed by trees, cliffs or water so the player never sees the boundary.

**9. There is no decoration pass and there are no events.** A layout with no props and nobody
standing in it does not read as a place. Both are mechanical to add once layers 2/3 and a
per-tileset prop catalogue exist.

### Second review — what a closer look at the town turned up

**10. The tileset's passage flags were never configured, so nothing was solid.** `flags[0]`
was `0` instead of `0x10`, and only the A3 range carried flags at all (1536 of 8192 entries).
With no star bit on tile 0, passage resolves on the empty upper layers and returns "open"
everywhere — the player walks straight into buildings and gets stuck inside them.
`get_map_grid` rendered the entire 40x30 town as open floor, which is correct output for a
broken tileset and exactly the symptom to look for.

**`check_project` already detects this** — rule `tileset-passage-unconfigured` tests precisely
`(flags[0] & 0x10) === 0`. The rule was right; nothing in the map-building path consulted it.
Any generator that writes a map should run that check first and refuse, or at least warn,
rather than emit a map where geometry has no effect.

Fixed here by copying the flags array from the reference database at
`RPG Maker MZ/newdata/data/Tilesets.json`, which has all 8192 entries. **No tool can write
tileset flags**, so that had to be done outside the server.

**11. Roofs need the nine-slice sets from the B/C sheets, not a rectangle of A3 texture.** The
A3 roof materials are uniform textures — `Outside_A3` kind 52's whole 2x2 block is shingle with
no edge art, so a correctly-shaped A3 rectangle still renders as a flat slab. Real roofs come
from `Outside_C` as 3x3 blocks with sloped left/right sides and a shingled eave, addressed as
`topLeft + row * 8 + col`. Verified by rendering: **384** (green), **389** (white), **408**
(gold), **413** (brown). Two neighbouring columns of each set are inner-corner pieces for
L-shaped roofs.

**12. The dense "many trees" tile is interior-only.** `Outside_B` 178/179/186/187 draw a canopy
that runs off the tile edges so it can overlap its neighbours; placed on its own it is a green
blob with a hard cut edge. A tree mass has to be drawn with the *single* tree's quadrants
(176/177/184/185) around the rim and the dense tile only where every neighbour is also woodland.

**13. Doors are events, not tiles.** The tile used for them (`Outside_B` 114/122) is a pair of
shuttered windows — it floats above the wall base and never reaches the ground. RPG Maker doors
are events carrying a `!Door1` / `!Door2` character sprite, whose three frames are the opening
animation. Any town generator has to emit events, not just tiles.

**14. Nothing validated placement.** Props, tree quadrants and NPCs were landing on top of
building walls and roofs — a log on a bakery wall, a tree canopy across a roof, border trees
cutting through two buildings. Two passes fix it and both belong in the generator:

- an occupancy grid of building footprints, so decoration can only go where nothing is built
  (with an explicit exception for windows, signs and doors, which *should* be on the wall);
- a walkability audit implementing `Game_Map.checkPassage` and `Game_CharacterBase.canPass`,
  flood-filling the map and reporting events on impassable tiles, events walled off from the
  rest of the map, and doors with no reachable tile in front of them.

After both, the town reports 834 of 838 standable tiles reachable, every door approachable and
no event stranded. The four unreachable tiles are canopy squares boxed in between a building
and the tree line, which the player can never see.

### Robustness

Three of 508 `fill_map_region` calls failed transiently during one run and all three succeeded
when replayed immediately afterwards; a 300-call stress run afterwards produced none. Every
call rewrites the whole map file, and `FileHandler.writeJson` does copy-to-`.bak` →
write-`.tmp` → `rename` each time, so a Windows lock/rename race is the obvious suspect. Not
reproduced often enough to be sure — but a retry around the rename would cost nothing, and
batching writes would remove the exposure entirely.

### What has been built from these findings

| Finding | Now in the server |
|---|---|
| 1 — transparent materials on layer 0 | `src/core/tileset-image.ts` measures the A2 sheet; `fill_map_region` refuses an overlay material on layer 0 unless `allowOverlayOnGround` |
| 1b — seamless fills have no boundary | same classifier; `fill_map_region` warns when a seamless material is used for a patch rather than a whole-map fill |
| 2 — no shadow plane | `apply_wall_shadows` (`src/core/shadows.ts`) |
| 10 — passage flags unconfigured | `describe_tileset_materials` warns when `flags[0]` has no star bit; `check_project` already had the rule |
| 14 — nothing validated placement | `check_map_walkability` (`src/core/walkability.ts`); `fill_map_region` gained `skipOccupied` and reports upper-layer overwrites |
| 3 — no wall shape computation | `src/core/wall-autotile.ts`; `fill_map_region` now takes A3/A4 kinds and dispatches to the right table |
| 4, 11, 13 — roof/wall pairing, nine-slice roofs, doors as events | `place_building` (`src/core/blueprint.ts`) — see [Building blueprints](#building-blueprints) |
| ergonomics — 440 of 526 calls were 1x1 rectangles | `paint_tiles` (`src/core/tile-batch.ts`) — see [Batched tile writes](#batched-tile-writes) |
| 12 — per-tileset prop knowledge | `list_tileset_props` / `place_prop` (`src/core/props.ts`) — see [The prop catalogue](#the-prop-catalogue) |
| 5, 8, 9, 14 — upper layers, framing the edge, decoration and events, validated placement | `generate_town` (`src/core/towngen.ts`) — see [The town generator](#the-town-generator) |
| doors that led nowhere | `generate_interior` / `generate_interiors` (`src/core/interiorgen.ts`) — see [Interiors](#interiors) |
| robustness — transient rename failures | `FileHandler.writeJson` retries the rename on EPERM/EACCES/EBUSY |
| verification caveat | `scripts/render-map.mjs` renders any map to a PNG |

**Still not in the server:**

- findings 6 and 7 — `generate_map_layout` is unchanged. Its caves still over-smooth into one
  convex blob, its dungeons are axis-aligned rooms on one elevation, and both write layer 0
  only. The town generator addressed 5, 8 and 9 on its own path; nothing has been carried back
  to the cave and dungeon algorithms.
- Nothing can write tileset passage flags; the tools can only detect that they are missing.

Still to build: NPCs, and carrying any of this back to the cave and dungeon generators.

### The town generator

`generate_town` puts the whole stack together — ground, streets, buildings with door events, a
tree line, a decoration pass — in one reproducible call.

- `src/core/towngen.ts` — `planTown`, pure and unit-tested
- `src/tools/towngen-tools.ts` — the MCP tool
- `src/core/building-placement.ts` — the building application `place_building` and the town
  generator share, extracted so a house is assembled the same way whether one was asked for or
  forty were

**The layout is dictated by a constraint of the building primitive,** which is worth stating
plainly because it shaped everything else: a door sits on a building's bottom wall row and is
entered from the tile below it, so a house only functions with a street directly beneath it. The
town is therefore bands — a row of buildings sitting on the street it faces — rather than
free-standing plots. Cross streets run the full map height and intersect every road, so the
network is **connected by construction**, the same argument the dungeon generator makes for its
corridors; they also cut the tree line at four points, so the town has entrances instead of
being sealed inside its own frame.

**Everything the earlier findings asked for is enforced before anything is written**, rather
than audited after:

| Finding | How the planner handles it |
|---|---|
| 5 — only layer 0 used | ground and walls on 0, props on 1, roofs on 2 |
| 8 — nothing frames the map edge | a tree line fills the border band |
| 9 — no decoration, no events | props on free ground; a door event per building |
| 14 — nothing validated placement | props can only go where nothing is built, and never on the tile in front of a door |

Those are asserted across 25 seeds against the *plan*, with no map file involved: no two
buildings overlap, none sits on a street, every door's approach tile is road, the street network
floods to a single component, and no prop lands on a building or in a street.

**Two things the render changed.** Props scattered uniformly over free ground put a lone crate
in the middle of a field, so they are now drawn from tiles beside a wall or a street before the
open middle of a block. And the tree line does not run to the map edge: a tree's canopy tile is
passable and its trunk is not, so a line flush against the border seals the strip outside it —
exactly the isolated-area the `paint_tiles` verification turned up. Leaving the outermost ring
clear keeps that strip joined to the streets that cut through the trees, and the audit now
reports one connected area for the whole map.

**Still open here:**

- **Buildings only line one side of a street.** A band faces the road below it, so the ground
  above each row is open. Housing both sides needs a door on a building's *top* edge, and
  `place_building` has no such thing — the door sprite, the movement route and the approach tile
  all assume the player walks in from below.
- **No NPCs.** The generator emits door events and nothing else.
- **Blocks are rectangles.** Finding 7 applies here too: streets are straight, plots are grids,
  and nothing meanders.

### Interiors

`generate_interiors` makes a room for every door on a map and wires both directions;
`generate_interior` does one room against a named door.

- `src/core/interiorgen.ts` — `planInterior` and the exit event (pure, unit-tested)
- `src/tools/interior-tools.ts` — the two MCP tools
- `setDoorDestination` in `src/core/blueprint.ts` — fills in the transfer a door was built without

**The shape of a room is measured, not designed**, from the 113 interiors that ship with the
editor:

| Fact | Evidence |
|---|---|
| The space around a room is A5 tile 1536 | 436 of 452 sample-map corners |
| The room is ringed by an A4 wall *top*, with the wall *face* drawn beneath it | every sample room |
| The face that belongs to a top is `+8` | 2,066 of 2,704 top-over-face columns — the same pairing the A3 roofs use |
| The face is two rows tall | 2,504 runs of 3,660 (1 row: 620, 3 rows: 532) |
| The exit is an invisible player-touch event playing an SE and transferring | 144 of 147 sample exit events, command sequence `250, 201, 0` |

The front wall is drawn like the back one but below the room, and the doorway is a channel cut
straight down through all three of its rows.

**The round trip is the part that is easy to get backwards.** The door lands the player on the
room's doorway tile; the room's exit lands them on the tile *in front of* the door, not on the
door itself, which is a wall. Landing on the exit event does not re-fire it — `updateNonmoving`
only calls `checkEventTriggerHere([1, 2])` when the player finished a walking step, and
`performTransfer` sets the position with `locate()` rather than by moving. That is read out of
the corescript rather than assumed, because getting it wrong would bounce the player straight
back out of every house.

**Two defects fell out of building this**, both in code that already existed:

- **`refreshAutotileShapes` never shaped A4 wall tops.** `Tilemap._addAutotile` draws A4 kinds
  on an *even* block row with `FLOOR_AUTOTILE_TABLE`, but the refresh pass only looked at A2, so
  every wall top stayed at shape 0 — a field of centre pieces with no edges. It had gone
  unnoticed because nothing had painted one until now. `usesFloorAutotileTable` fixes it, and
  the test that asserted the old behaviour was itself asserting the bug.
- **`generate_town` never cleared a map's events.** It rewrites every tile, so running it twice
  left the previous run's door events behind: thirteen buildings, thirty-six doors, and every
  door but the newest pointing at a building that no longer existed. Found by running
  `generate_interiors` over a map that had been generated three times.

**And one false positive in `check_map_walkability`.** Passage flags are per tile *shape*, not
per material, and a room's wall tops are passable *along themselves* — so the ring around a room
is a larger connected area than the room, and the player can never stand on it. Taking the
largest area as "reachable" therefore reports the room as cut off and its own exit as
unreachable. That is not a generator bug: **the interior maps that ship with the editor produce
the identical complaint.** The tool now takes `startX`/`startY`, and with the arrival tile given
both a shipped room and a generated one come out clean.

**Still open here:** a room is one rectangle — no NPCs, shops, stairs or upper floors, and
nothing varies but the furniture. Rooms are only made for doors that lead nowhere, so hand-made
links survive unless `relink` is passed.

### The prop catalogue

`list_tileset_props` and `place_prop` address objects by name — 1,628 of them across the twelve
object sheets the editor ships.

- `scripts/build-prop-catalogue.mjs` — the generator
- `src/core/prop-catalogue.ts` — generated data, committed
- `src/core/props.ts` — resolution, search, sub-rectangles (pure, unit-tested)
- `src/tools/prop-tools.ts` — the two MCP tools

**The names did not have to be invented, which is the whole reason this is tractable.** RPG
Maker ships a `.txt` beside every tileset PNG holding one line per tile id — the editor's own
label, in English and Japanese. A prop is a connected run of tiles sharing a label, computed in
the sheet's *drawn* layout rather than in tile-id order, because that is where adjacency means
anything. Spot-checked by rendering the props the labels name — barrel, well, palm tree, tent,
INN sign, snowman — and they match.

**Projects do not ship those files; only the editor's `newdata` does.** So the catalogue is
generated once and committed, and the generator takes a path so DLC or custom sheets can be
folded in. A tileset naming a sheet the catalogue has never seen contributes nothing rather
than failing, and the listing says which sheets those were.

Addressing is the same `topLeft + row * 8 + col` the nine-slice roofs use, and for the same
reason — the object sheets are 16 tiles wide but read as two 8-wide halves. No prop straddles
that boundary; the generator asserts it, and a test re-checks every prop against the
corescript's own source-rect formula.

**What the labels revealed that tile ids hide:** a name often covers an object *together with
its filler variants*. `Tree` is a 2x2 box holding a 1x2 tree and a canopy filler beside it —
with a hole, because the fourth cell belongs to `Bush`. `Large Tree` is 4x2: a 2x2 tree plus
the mass that fills the middle of a grove. That is the correct reading of finding 12, and a
better one than the roadmap previously had: the "dense many-trees tile" is not a separate
material to be used where neighbours are woodland, it is `Large Tree`'s own interior filler.
Rendering `place_prop "Tree"` whole against `part={x:0,y:0,width:1,height:2}` shows the
difference directly — the first leaves a canopy square floating beside the trunk. Where a prop
has a hole, the result names the prop that owns it, so `Tent A`'s gap reports as
`Tent A (Entrance)`.

**It also corrected earlier work.** `OUTSIDE_C_ROOF_SETS` recorded brown as having no
inner-corner pieces, because an earlier pass looked for them in the columns the other three
sets use. The labels put `Roof D (Wood)` in one 3x5 group whose extras sit *below* the block
instead, and rendering that region confirmed the corners are there — 446 and 447. The two
derivations are independent, so a test now asserts every roof set's block and corners fall
inside the group the sheet labels for it.

Object tiles are cut out around their edges, so `place_prop` runs the same "is there anything
beneath this?" check `place_building` runs for a roof's sloped corners. That check now lives in
one place (`hasTileBelow` in `src/core/map-layers.ts`) rather than being written a third time.

**Not covered:** the A5 sheet, whose tiles are ground textures rather than objects, and the
A1-A4 name files, which label autotile *materials* — those would let
`describe_tileset_materials` say "Grass" instead of "kind 16", and the generator already knows
how to read them.

### Building blueprints

`place_building` takes a footprint, a roof and a wall material and writes the roof tiles, the
wall tiles, a door event and the shadows in one call.

- `src/core/blueprint.ts` — sheet geometry, the roof set catalogue, `planBuilding`, the door
  page (pure, unit-tested)
- `src/tools/blueprint-tools.ts` — the MCP tool
- `findTransparentTiles` in `src/core/tileset-image.ts` — which roof cells are cut away

This is where findings 4, 11 and 13 stopped being prose. Each of them is per-tileset *content*
rather than an engine rule, so each had to be measured rather than derived, and the numbers are
recorded beside the code:

**The `+8` pairing (finding 4).** The A3 sheet runs roof row / wall row / roof row / wall row,
so block rows 0 and 2 are roofs and 1 and 3 are walls. Counting every sample-map column where
an A3 roof run has an A3 run directly beneath it: 497 of 614 (81%) use `roofKind + 8`. Passing
`roofKind` derives the wall; passing a wall from the wrong row, or a mismatched pair, is
reported rather than silently built. Two rows is the default height for both parts because that
is what the samples use most (roof runs: 2 rows 304 times, 1 row 225, 3 rows 127; wall runs:
2 rows 774, 1 row 423, 3 rows 121).

**Nine-slice roofs (finding 11).** `roofSet` takes `green` (384), `white` (389), `gold` (408)
or `brown` (413) on `Outside_C`; any other sheet's block can be given as `roofTopLeftTileId`.
The addressing is `topLeft + row * 8 + col` because `Tilemap._addNormalTile` computes the
source column as `(floor(tileId / 128) % 2) * 8 + tileId % 8` — the object sheets are 16 tiles
wide but read as two 8-wide halves, so a block starting within two columns of a half's edge
wraps to the other side of the sheet, and that is refused. `tests/core/blueprint.test.ts`
checks the nine-slice arithmetic against that formula for all 1024 object tile ids rather than
against a restatement of itself.

The catalogue also records each set's **inner-corner pieces**, which are what an L-shaped roof
needs. Nothing uses them: footprints are rectangles.

**Roof corners are cut away.** The sloped corner pieces are diagonally transparent, so they
show whatever is on the layer below — on layer 0 that is the map background, black in game.
This is finding 1 in a second place, and it is handled the same way: measure the sheet, and
refuse. But only the cut cells need ground, not the whole roof, so `findTransparentTiles`
measures which ones they are — for a 5x3 green roof that is exactly 2 tiles, the two top
corners, and the refusal names them. Nine-slice roofs default to layer 2, which also matches
the samples: of 537 roof-corner tiles, **0 are on layer 0**, 58 on layer 2 and 477 on layer 3,
and 98.1% have something painted beneath them. (Layer 2 rather than 3 so that layer 3 stays
free for anything that should draw in front of the roof.)

**Doors as events (finding 13).** The emitted page is the one the shipped maps use — 60 of the
107 sample door pages are the exact command sequence `250, 205, 505×6, 205, 505, 250, 201`:
play `Open1`, step the sprite through its opening frames, turn Through on, walk the player
forward, play `Move1`, transfer. A door sprite stores its three frames as *directions*, so the
animation is three turn commands, not a graphic change. A Set Movement Route is also stored
twice — inside the 205 command and again as one 505 line per step, minus the end marker — and
writing only the 205 leaves the editor showing an empty route. The door goes on the bottom wall
row, where 98 of 107 sample doors stand, and the player approaches from the tile below. Without
`interiorMapId` the door still animates, and the result says it leads nowhere.

**Verified by rendering, not only by tests.** A map of nine buildings — all four roof sets, a
2-row roof, a 9-wide one, the minimum 2x2, an A3 roof for comparison, and a deliberately
mismatched pair — was built by driving the real server over stdio and rendered with
`scripts/render-map.mjs`. The buildings read as buildings; the A3 roof reads as the flat slab
finding 11 predicted; the mismatched pair reads as mismatched; `check_map_walkability` reports
every door approachable and one connected area.

**Still open here:** roofs are rectangles, so no L-shapes and no inner corners. The dormer and
window variants that sit beside each roof set on the sheet are not offered. Interiors are not
generated, so `interiorMapId` has to point at a map you made yourself.

### Batched tile writes

`paint_tiles` takes a list of `{x, y, tileId, layer}` and writes all of it at once — the
counterpart to `fill_map_region` for the scattered work that made up 440 of a hand-built town's
526 calls.

- `src/core/tile-batch.ts` — `applyPlacements` (pure, unit-tested)
- the tool lives beside `fill_map_region` in `src/tools/map-paint-tools.ts`

**It is deliberately not a new behaviour.** Because every single-tile paint already fixes up its
neighbours, a sequence of them converges on the same grid a batch produces, and a test asserts
that equivalence directly. What a batch removes is one whole-map file write and one shape
refresh per tile: the roadmap's own robustness note recorded three transient Windows rename
failures across 508 `fill_map_region` calls, and batching removes that exposure rather than
retrying past it.

Two details that are easy to get wrong:

- **Both shape tables are run**, not one picked from the material. A layer can hold ground and
  wall autotiles at once, each pass ignores what the other owns, and a batch that touches both
  families only comes out right if both run. A1 water belongs to a third table and passes
  through untouched.
- **`skipOccupied` applies within the batch**, not only against what was already on the map.
  Its whole purpose is that a later object cannot clobber an earlier one, and batching would
  quietly change the meaning of the flag if the batch's own writes did not count.

Refusals cover the whole batch or none of it — a partial application would leave no way to tell
which tiles landed. That is what the A2-overlay-on-layer-0 check does: it validates every entry
before writing anything.

**Verified by driving the server:** a 144-tile decoration pass — tree lines framing both map
edges, a woodland block, shuttered windows on two buildings, plus two deliberately
out-of-bounds entries — went in as one call, and the two bad entries were discarded and
reported rather than throwing. `check_map_walkability` then caught something real about the
test map rather than the tool: the tree line runs flush to the map border, and because a tree's
canopy half is passable while its trunk half is not, the strip of grass above it is a walkable
area cut off from everything else.

`describe_tileset_materials` classifies by comparing **mean colours** rather than pixels.
That detail matters: a cobblestone texture differs from itself pixel by pixel about as much as
it differs from grass, so a per-pixel metric calls it "outlined" against its own middle. The
mean is stable under noise, and on the real RTP sheets the separation is clean — seamless
fills score 0.000-0.002 edge contrast, outlined patches 0.10-0.17.

### Tool ergonomics, from building a town by hand

A 40x30 town assembled through the tools took **526 calls**, roughly 440 of them 1x1 rectangles.
That is the honest measure of what is missing:

- ~~`fill_map_region` paints one tile id per call, so every non-A2 object — every door, window,
  sign, barrel, half of every tree — is its own call.~~ *Fixed:* `place_building` replaces the
  dozen-odd calls a house used to take, and `paint_tiles` takes a list of
  `{x, y, tileId, layer}` for everything else — a decoration pass of 144 tiles across a whole
  map is now one call.
- ~~A3 shapes had to be computed outside the server and written as raw tile ids, because shape
  computation is A2-only.~~ *Fixed:* `src/core/wall-autotile.ts`.
- `autotileKind`'s description says "columns 1-4 are patch materials with visible outlines".
  Column 4 is the first *overlay* material, so a caller following the description lands
  directly in finding 1.
- ~~The shadow (z=4) plane has no tool at all.~~ *Fixed:* `apply_wall_shadows`, and
  `place_building` runs it. The region plane (z=5) still has none.
- A1 (water, waterfalls) is not supported, so a generated map can have no water.

### Still open

- **Passability is not generated.** The generator paints materials; whether the player can
  walk on them comes from the tileset's passage flags, which are a tileset setting rather
  than map data. A generated "wall" only blocks if that material is configured impassable.
  `get_map_grid` shows what is actually walkable, and `check_project` flags tilesets whose
  passage was never configured.
- **The generators still don't use any of this.** `fill_map_region` handles A3/A4 walls and
  `place_building` assembles them into houses, but `generate_map_layout` writes A2 on layer 0
  only — its dungeons and caves still read as floor-vs-surround rather than rooms with raised
  walls.
- **Town and interior generators.** Building plots, roads, and furnished rooms are a
  different problem from cave/dungeon carving and were left out. `place_building` is the
  primitive a town generator would place; nothing chooses *where* to place them yet, and
  interiors are not generated at all, so a door's destination has to be a map you made.

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
engine's tables — and are — but "does the map actually look right" needs someone looking at it.

That no longer means opening the editor. A standalone renderer that ports `Tilemap`'s drawing
from `rmmz_core.js` turns any map file into a PNG, which closes the loop: generate, render,
look, change something, render again. It is worth landing as a dev script — every finding above
came out of that loop, and several of them (the transparent-material holes especially) are
invisible in a text grid.

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
