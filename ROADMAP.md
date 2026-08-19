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

**Started.** `checkProject` now takes an optional `databaseIds`, and the first rule to use it
is `shop-sells-missing-entry`. Shops went first because they are the case with *no* runtime
symptom at all: `Window_ShopBuy.goodsToItem` returns undefined for a missing id and
`makeItemList` skips the row, so the shop simply sells one thing fewer and nothing anywhere
says why. `branch-checks-missing-entry` followed, for the conditional branches that ask
whether the party holds an item, weapon or armour — a key deleted after a door was locked
with it leaves a branch that can never be taken, which is strictly worse than a shop losing a
row: whatever the branch guards leaves the game. The remaining commands that name a database
id — Change Items/Weapons/Armors, Change Party Member, Battle Processing, Change
Skill/Class/State — follow the same shape and can reuse the same input.

`databaseIds` is optional on purpose: a caller that cannot load the database files loses the
rule rather than reporting every reference in the project as missing. `flagNames`, added
alongside it for `switch-out-of-range` and for naming flags in findings, works the same way
and for the same reason — a missing array would read as a bound of zero and condemn every
flag in the project.

## 5. Procedural map generation 🚧

> **Status: in progress.** Steps 1 and 2 are done and confirmed against the editor. Step 3
> generates connected, correctly-shaped layouts; a visual review then found the maps were not
> good enough to call finished, and most of what it turned up has since been built — see
> [Visual review findings](#visual-review-findings) and the table of
> [what came out of them](#what-has-been-built-from-these-findings). Towns, interiors, NPCs,
> dungeon dressing, stairs between maps and writable passage flags all came from that list.
> What is left is collected under [Still open](#still-open-1): everything the generators emit
> is a rectangle, and nothing has any game logic behind it.

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

Fixed at the time by copying the flags array from the reference database at
`RPG Maker MZ/newdata/data/Tilesets.json` by hand, because no tool could write tileset flags.
`configure_tileset_passage` now does exactly that copy from a committed catalogue — see
[Writing passage flags](#writing-passage-flags).

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
| 10 — passage flags unconfigured | `configure_tileset_passage` / `set_tileset_passage` (`src/core/passage.ts`) — see [Writing passage flags](#writing-passage-flags); `describe_tileset_materials` and `check_project` detect the case |
| 14 — nothing validated placement | `check_map_walkability` (`src/core/walkability.ts`); `fill_map_region` gained `skipOccupied` and reports upper-layer overwrites; `decorate_dungeon` refuses a prop that would seal part of the map |
| 3 — no wall shape computation | `src/core/wall-autotile.ts`; `fill_map_region` now takes A3/A4 kinds and dispatches to the right table |
| 4, 11, 13 — roof/wall pairing, nine-slice roofs, doors as events | `place_building` (`src/core/blueprint.ts`) — see [Building blueprints](#building-blueprints) |
| ergonomics — 440 of 526 calls were 1x1 rectangles | `paint_tiles` (`src/core/tile-batch.ts`) — see [Batched tile writes](#batched-tile-writes) |
| 12 — per-tileset prop knowledge | `list_tileset_props` / `place_prop` (`src/core/props.ts`) — see [The prop catalogue](#the-prop-catalogue) |
| 5, 8, 9, 14 — upper layers, framing the edge, decoration and events, validated placement | `generate_town` (`src/core/towngen.ts`) — see [The town generator](#the-town-generator) |
| doors that led nowhere | `generate_interior` / `generate_interiors` (`src/core/interiorgen.ts`) — see [Interiors](#interiors) |
| 9 — nobody in the places built | `place_npc` / `populate_map` (`src/core/npcgen.ts`) — see [NPCs](#npcs) |
| 6, 7 — cave and dungeon silhouettes | `generate_map_layout` (`src/core/mapgen.ts`) — see [Layout shape](#layout-shape) |
| 9 — generated dungeons had no props and no events | `decorate_dungeon` (`src/core/dungeon-dressing.ts`) — see [Dungeon dressing](#dungeon-dressing) |
| a generated dungeon connected to nothing | `place_stairs` / `link_dungeon_floors` (`src/core/stairs.ts`) — see [Stairs and entrances](#stairs-and-entrances) |
| no shops; every chest holding the same item | `place_shop` (`src/core/shop.ts`) and a real loot table for `decorate_dungeon` (`src/core/loot.ts`) — see [Commerce and loot](#commerce-and-loot) |
| nothing with a switch behind it | `allocate_switch` / `list_switches` / `release_switch` (`src/core/switches.ts`) — see [Switches and variables](#switches-and-variables) |
| nothing gated behind anything; no locked doors | `place_locked_door` (`src/core/locked-door.ts`) — see [Locked doors](#locked-doors) |
| nothing joined the pieces up into a quest | `create_key_item` / `place_key_for_door` (`src/core/quest.ts`) — see [Quests](#quests--joining-the-pieces-up) |
| a switch-locked door with nothing to open it | `place_lever` (`src/core/lever.ts`) — see [Levers](#levers--the-thing-that-sets-a-switch) |
| the caller had to choose where every piece went | `lock_dungeon_floor` (`src/core/chokepoint.ts`) — see [Locking a generated floor](#locking-a-generated-floor) |
| a locked door with no reason to exist | themed rooms and a generated inscription (`src/core/vault.ts`) — see [Why the door is there](#why-the-door-is-there) |
| robustness — transient rename failures | `FileHandler.writeJson` retries the rename on EPERM/EACCES/EBUSY |
| verification caveat | `scripts/render-map.mjs` renders any map to a PNG |
| the region plane (z=5) was unreachable | `paint_regions` (`src/core/regions.ts`) and `get_map_grid showRegions` — see [The region plane](#the-region-plane--the-sixth-layer) |

**Still not in the server:**

- ~~Shops~~ *(done: `place_shop`)*, ~~switches~~ *(done: `allocate_switch`)*,
  ~~locked doors~~ *(done: `place_locked_door`)* and ~~the key that opens one~~
  *(done: `place_key_for_door`)*. What is left is everything a quest needs beyond one key and
  one door: chains, state, and something that *sets* a switch. See
  [Commerce and loot](#commerce-and-loot), [Switches and variables](#switches-and-variables),
  [Locked doors](#locked-doors) and [Quests](#quests--joining-the-pieces-up).

### Layout shape

Connectivity was asserted from the start, and it was never the problem: a fully connected map
can still be a featureless blob, which is what the visual review found. The fix was to stop
arguing about it and **measure**.

Three shape metrics, taken the same way over the 55 dungeon-tileset maps the editor ships and
over 30-40 generated seeds:

| | hand-made (median [p10..p90]) | before | after |
|---|---|---|---|
| floor fraction | 0.219 [0.130..0.797] | cave 0.781, dungeon 0.343 | cave 0.360, dungeon 0.367 |
| edge density | 0.676 [0.452..0.800] | cave 0.154, dungeon 0.629 | cave 0.465, dungeon 0.678 |
| dead ends per 100 | 5.178 [0.000..9.040] | dungeon 0.000 | dungeon 4.329 |
| interior islands | 5 [0..21] | cave 2 | cave 10 |

**Edge density** — the share of floor tiles touching a wall — is the one that matters. It turns
"one large open blob with nothing to navigate around" into a number, and the cave was at 0.154
against a hand-made floor of 0.452. Every default below was chosen by sweeping against these
ranges, not by eye, and `tests/core/mapgen.test.ts` asserts the medians stay inside them.

**Cave.** Two changes. The early cellular-automata passes carry a second clause that keeps walls
ragged; and because nothing in the automata puts anything *inside* the cave, a **pillar pass**
drops solid clumps into open space afterwards. A pillar is kept only if the cave stays exactly
as connected with it as without — the same test NPC placement uses, for the same reason.

**Dungeon.** A share of rooms are carved as two overlapping rectangles inside the same envelope,
so they come out L- or T-shaped; corridors run between per-room *anchors* rather than envelope
centres, because the centre of an L-shaped room can land in the notch and a corridor ending on
rock joins nothing. And short passages are cut into the rock that arrive nowhere: carving only
ever adds floor so it cannot disconnect anything, but a stub that brushes another passage stops
being a dead end, so every tile is checked to be walled on all sides but the one it came from.

**Walls have height now.** `layoutToGrid` runs both shape tables, so the surround can be an A3/A4
wall material rather than a second ground material; and where a wall mass meets floor below it,
the paired wall *face* is drawn. Running one table was the reason a generated map could only ever
be floor against a differently-coloured floor.

### Dungeon dressing

`decorate_dungeon` furnishes what `generate_map_layout` carves: torches on the wall faces,
treasure in the dead ends, clutter on the floor and the walls.

- `src/core/dungeon-dressing.ts` — the two event kinds and the placement plan (pure, unit-tested)
- `src/tools/dungeon-dressing-tools.ts` — the MCP tool

**Both events are measured.** A torch is decorative and stands *on the wall*: 623 of the 635
`!Flame` events in the shipped maps sit on a solid tile, and 499 use the same page — Action
Button, `stepAnime` on so the flame flickers, `directionFix` on so it never turns, and no
commands at all. A pickup is `250, 101, 401, 126, 123, 0` in 16 of the 20 one-shot pickup events
found across every shipped project, with a second page behind self switch A that does nothing.
The `!Chest` sprite **opens by direction, not pattern** — the `!Door1` trick again — which was
read off the sheet, since nothing shipped actually uses that sprite.

**Treasure only goes in dead ends**, and that is a correctness argument rather than a taste one: a
chest blocks its tile, and a dead end has one way in with nothing beyond it, so it is the only
placement that provably cannot cut anything off. Ask for more chests than there are dead ends and
you get fewer chests. It also pays off the dead ends the dungeon generator only just learned to
cut.

**The render caught the real bug.** The first pass told floor from wall by passability, and the
chests all ended up in a line along the map's top edge with props scattered outside the dungeon.
Cause: in the RTP tilesets an A4 wall *top* is passable (`flags 0xe00`) while its face is not, so
88% of the map read as floor and the "dead ends" found were the map border. The tool now takes
`floorKind` and tells floor from wall by material, and warns when a map without it looks
suspiciously walkable.

**A scatter prop is not always something you can walk over.** `Rubble` is one of the four
default floor props and on `Dungeon_B` it is tile 120, flags `0x60f` — impassable from all four
directions. Scattered at the default density it walled tiles off: on two generated floors it
made 5 and 4 tiles solid, each cutting exactly one floor tile out of the map. It surfaced
because it sealed a dungeon *entrance*, and the two features collide by construction —
`planStairEnds` picks the extreme of the layout, which sits at the end of the longest thinnest
passage, the most fragile tile there is.

`rejectSealingSlots` now makes the guarantee `addPillars` and `place_npc` already made: a
placement is accepted only if everything reachable before it is still reachable after. Three
details matter and each is tested:

- **Only solid props are checked**, and which those are is read from the tileset flags rather
  than from the name — `Rubble` is solid, `Gravel A` beside it is not. Anything walkable is
  kept without a flood fill, which is most of them.
- **The check is incremental**, because two props that are each harmless alone can pinch a
  corridor shut together. A ring corridor is the test: closing one tile leaves a way round,
  closing the far side splits it.
- **The test is relative — no tile *becomes* unreachable — not "the map is fully connected"**,
  so a map that already had an isolated pocket is measured against what it actually was
  instead of having every placement refused.

The chests are marked solid in the mask before the props are judged, since a chest is priority
1 and genuinely blocks its tile.

Verified by driving the real server in **both tool orders** — decorate then link, and link then
decorate — across two floors each. All four maps: the entrance reaches 100% of the walkable
floor (508/508, 466/466, 507/507, 466/466), where before the fix the same seed stranded a tile
at 506 of 507. The rejected props are named in the tool's output rather than silently dropped.

**And one more stale-state bug, the same shape as the town generator's.**
`generate_map_layout` replaces one tile layer and leaves the others — so regenerating over a
decorated map strands the old torches and chests where the previous layout put them. It now says
so rather than leaving treasure floating in solid rock.

**Still open here:**

- ~~Nothing places stairs or an entrance, so a generated dungeon connects to nothing.~~
  *Fixed:* [Stairs and entrances](#stairs-and-entrances).
- ~~Chests all hand over the same item, and there are no enemies, switches or locked doors.~~
  *Mostly fixed:* chests are dealt from a real loot table ([Commerce and loot](#commerce-and-loot)),
  flags can be allocated ([Switches and variables](#switches-and-variables)) and doors can be
  locked ([Locked doors](#locked-doors)). Enemies are still absent, and nothing the *generator*
  emits is gated — a locked door has to be placed on a generated floor by hand.
- Pillars are single tiles, so they read as regular studs rather than rock formations. Growing
  them into clumps would look better and would need the sweep redone.
- The generator itself writes one layer; `decorate_dungeon` is a separate pass over the result.
- **Passability comes from the tileset, not the layout.** A generated wall only blocks if that
  material is configured impassable, so `check_map_walkability` on a map painted with passable
  materials reports the surround as walkable — correct output, not a generator bug.
  `configure_tileset_passage` is what makes the tileset say so in the first place.

### Writing passage flags

`configure_tileset_passage` writes a tileset's flags from the configuration the editor ships
for the same sheets; `set_tileset_passage` edits chosen tiles for art the catalogue has never
seen. `list_passage_catalogue` says what is covered.

- `scripts/build-passage-catalogue.mjs` — the generator
- `src/core/passage-catalogue.ts` — generated data, committed
- `src/core/passage.ts` — slot ranges, planning, flag edits (pure, unit-tested)
- `src/tools/passage-tools.ts` — the three MCP tools

**This was the gap the whole generator stack sat on.** A generated wall only blocks if its
material is configured impassable, and that lives in `Tilesets.json` rather than in map data —
so a project whose tileset was never set up produces maps where geometry has no effect at all.
`check_project` has reported that as `tileset-passage-unconfigured` since phase 4, and until now
nothing could act on it. The scratch project used for every visual check had to have its flags
pasted in from a reference database by hand.

**Which materials are solid cannot be derived.** It is authored art direction, not something
measurable from the image — a cliff face and a cobbled floor are both opaque rectangles of
pixels. Unlike `tileset-image.ts`, which *can* measure opacity and edge contrast, there is
nothing here to compute. So the flags are taken from the tilesets the editor itself ships.

**What makes that transferable is that flags are a property of the sheet, not of the tileset,
and that was measured rather than assumed.** Across 68 configured tilesets from 9 databases,
56 of 62 sheets carry byte-identical flags everywhere they appear. The six that vary are named
in the catalogue's header with the source that won, so the ambiguity is visible rather than
buried — they are sheets two tilesets share, like `Inside_A1` used by both `Inside` and
`SF Inside`, which disagree on one material.

**Choosing between conflicting sources needed a rule, and the obvious one was wrong.** Taking
the first database in sorted order put the Card Game Combat demo — a third-party DLC project
whose author had retuned the Dungeon tileset on 96 tiles — ahead of the editor's own template,
purely because `dlc/Card…` sorts before `newdata`. The rule is now explicit: `newdata` is what
the editor writes for a new project and therefore *is* the default; then the official sample
packs; then anything else. Within one database the lowest tileset id wins, so a sheet is taken
from the tileset it is named after rather than one that merely borrows it.

**The catalogue is checked against its own sources.** For every configured tileset the editor
ships, planning must ask for zero changes on every sheet that tileset owns — and the only
divergence anywhere is `SF Inside`, at exactly the 98 tiles (48 + 48 + 2) it borrows from
`Inside` and `SF Outside`. Run-length encoding makes it cheap to commit: 5,980 runs for 57,856
tiles, 10.3%, because flags repeat across all 48 shapes of an autotile material.

**Passability is stated positively and stored inverted.** In the file a *set* bit means blocked,
which reads backwards every time, so `set_tileset_passage` takes `passable: false` and does the
inversion. Tiles are chosen by autotile material (all 48 shapes, which is what the editor
does — passage is per material, not per shape), by prop name from the existing catalogue, or by
raw id.

**Verified by driving the real server** against the scratch project's genuinely unconfigured
tileset 1: 8192 flags all zero and `check_project` complaining, then 2,816 tiles written, tile 0
carrying the star bit, and the complaint gone. Running it again reports zero changes. A tileset
built with invented sheet names gets its one known sheet configured, the two unknown ones named
and left alone — and, because tile 0 belongs to the unknown slot, a warning that it is *still*
unconfigured rather than a success message.

**Still open here:**

- **Custom art gets no defaults**, only `set_tileset_passage` tile by tile. Nothing infers
  passability from an image, and nothing could without knowing what the art depicts.
- **The catalogue can only restore slots that name a sheet.** Tiles 1024-1535 — the gap MZ
  leaves between the object sheets and A5 — and any empty slot keep whatever they had. Neither
  is addressable from a map, so neither affects play.
- Terrain tags are copied along with passability. They are project-specific labels, so a
  project using them for its own purposes should configure passage first and tag afterwards.

### Stairs and entrances

`place_stairs` joins any two maps; `link_dungeon_floors` takes generated floors in order and
wires the whole staircase, optionally back out to a map outside the dungeon.

- `src/core/stairs.ts` — the transfer page and `planStairEnds` (pure, unit-tested)
- `src/tools/stairs-tools.ts` — the two MCP tools

**The event was measured, and it came back unanimous.** Across the 720 shipped maps, 157
transfer pages stand on a tile the editor labels a stair, ladder or hole, and all 157 are the
same page: player touch, priority 0 (below characters), no sprite, one page, commands
`250, 201, 0` — play `Move1`, transfer — with the transfer direct and fading to black. Not one
exception. The contrast is what tells a stair from a door: of the 167 pages standing on an
*entrance* tile, 122 carry a `!Door1` sprite at priority 1 with the full opening animation,
which is what `place_building` already emits.

**That page is byte-identical to an interior's exit**, measured separately a phase earlier
(144 of 147). So `interiorgen` now builds its exit from `stairs.ts` instead of keeping a second
copy — a stair and a way out of a house are the same object. The 20 interior tests passing
unchanged is the proof the two really were identical.

**Priority 0 is why placement needs no connectivity argument.** A chest has to go in a dead end
because it blocks its tile; a stair blocks nothing, so it can go on any floor tile. Landing the
player on one does not re-fire it either — `updateNonmoving` only calls `checkEventTriggerHere`
when `wasMoving` is true, and `performTransfer` uses `locate()` — which is what lets a
down-stair put the player straight onto the up-stair that leads back.

**The textbook diameter algorithm was not good enough, which the test caught.** The two ends
should be as far apart as the layout allows, and the standard double sweep — BFS from anywhere
to find one end, then from that end to find the other — is exact only on a tree. Generated
dungeons have loops: against the true diameter it returned 66 where the answer was 79, and 54
where it was 65, putting the stairs a sixth of the map closer together than they needed to be.
Iterating the sweep to a fixed point fixed some seeds and none of the others. Sweeping instead
from **every fringe tile** — every floor tile with two or fewer open neighbours — hit the exact
diameter on all 16 layouts, dungeons and caves alike. It is a heuristic rather than a proof,
and what makes it the right trade is that the fringe is the map's *perimeter* rather than its
area, so it is cheapest exactly where checking every pair would be dearest: an open cave offers
40-120 sources against 570 floor tiles. The test checks the result against a brute-force
all-pairs diameter so a layout change that breaks the assumption is caught.

Of the two ends, the one nearer the map border is the entrance — a convention, not geometry,
but the alternative reads backwards.

**A stair tile is not reliably one the player can stand on, and which ones are varies per
tileset.** This is finding 1 in a third place. Measured over the shipped flags: `Dungeon` has
every stair fully passable, but `Inside`'s "Stairs C (Up)" and "Stairs D (Down)" and
`SF Outside`'s "Stairs A (Up)" are `0x0f`, blocked from all four directions. Painted on an
upper layer that makes the tile impassable outright — passage resolves top-down and only a star
tile falls through — so the player can never touch the event. The check is worth making because
the shipped maps never get this wrong: **323 of 323** stair and entrance transfer events stand
on a standable tile, no exceptions. So the tool paints, then checks, and says so.

It caught a real mistake immediately: the first end-to-end run put the surface entrance on
`Cave Entrance`, which is impassable in `Outside`, and the tool reported the link dead.
`Entrance A` — the tile 75 of the shipped events use — is the standable one.

**And it turned up a bug in `decorate_dungeon`.** The first linked dungeon put its entrance on a
tile the player could not reach, because `Rubble` is one of that tool's four default floor props
and is solid, and it had landed in the one-tile corridor leading to the dead end. The two
interact by construction: `planStairEnds` picks the extreme of the layout, and the extreme sits
at the end of the longest thinnest passage — the most fragile tile on the map.

Fixed on both sides, because either alone would leave a hole. Stair placement takes the floor
mask as *painted with the floor material **and** standable*, so a stair never lands on a tile
something above has blocked, whatever put it there; and `decorate_dungeon` no longer places a
prop that would wall anything off — see [Dungeon dressing](#dungeon-dressing).

**Verified by driving the real server**: a surface map and two generated, decorated dungeon
floors, linked in one call. `get_map_graph` reports `Hillside -> Crypt B1 -> Crypt B2` with
return edges; `check_map_walkability` started at each floor's reported entrance reaches **all**
506 and 464 walkable floor tiles with no stair unreachable. Rendering confirms the art: the
up-stair and down-stair read as staircases, and the dark wedge on the up-stair is opaque sprite
art rather than a transparency hole — checked against the source alpha, since that is exactly
what finding 1 looks like.

**Still open here:**

- **The check is standability, not reachability.** An A4 wall top is passable in the RTP
  tilesets, so `place_stairs` will accept a stair placed on one and it will still be walled off.
  `link_dungeon_floors` is safe by construction — both ends come from one connected floor mask —
  but the explicit tool can only point at `check_map_walkability`.
- **Nothing generates what a cave mouth needs to sit in.** The RTP entrance tiles are doorway
  art meant to sit against a cliff face; on the flat grass of a generated surface map, one
  renders as a black rectangle in a field. The tile is correct and the surroundings are missing.
- The deepest floor's far end is left clear, and nothing puts a boss, a locked door or anything
  else there.
- Reachability is computed on the floor mask with plain 4-adjacency, so a tileset with
  directional passage flags on the floor material could still surprise it.

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
- **The generator itself emits no NPCs.** `populate_map` is a separate pass over a finished map.
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

**Still open here:** a room is one rectangle — no shops or upper floors, and nothing varies but
the furniture. Rooms are only made for doors that lead nowhere, so hand-made links survive
unless `relink` is passed. Stairs to an upper floor would now be `place_stairs`, but nothing
generates the floor above.

### NPCs

`populate_map` scatters people over a finished map; `place_npc` puts one somewhere specific.

- `src/core/npcgen.ts` — sheet naming, dialogue, the page, and placement (pure, unit-tested)
- `src/tools/npc-tools.ts` — the three MCP tools

**The ground truth is elsewhere this time.** `samplemaps` is scenery templates and contains not
one talking NPC, so the numbers come from the 70 talking pages in the DLC demo projects: Action
Button, priority "same as characters", fixed movement, `walkAnime` and `stepAnime` both on so the
sprite idles in place (28 of 70; Player Touch with everything else identical is next at 21).
Show Text carries MZ's five-parameter list and a box holds four lines — 31 pages use
`["", 0, 0, 2, ""]`. Sheet naming follows `ImageManager`: `$` means one big character, anything
else eight in a 4x2 grid, `!` means an object drawn without a shadow.

**Placement is a connectivity problem.** An NPC blocks its tile, so one in a doorway seals off
what is behind it. Each candidate is accepted only if the reachable area stays exactly as
connected with it as without, and door approach tiles are excluded outright — the guarantee is
enforced per placement and asserted across seeds, not audited afterwards.

**The interesting bug was in the model of "connected".** The first version flooded on plain
adjacency and cheerfully put villagers on top of an interior's walls. Passage flags are
directional, so two adjacent standable tiles can be mutually unreachable: a room's wall top is
standable and sits right beside the floor, but nothing can step onto it. `check_map_walkability`
reported them as `event-unreachable`, which is how it was caught. Reachability now goes through
the engine's own `canPass`, exported from `walkability.ts` for the purpose, and candidates are
restricted to the area the reference tile can actually reach.

**Deliberately not guaranteed:** `movement=random`. A wandering NPC can walk into a doorway at
runtime, and no static check can see that — the tool says so rather than pretending otherwise.

**Still open here:** the dialogue is placeholder text, and apart from the shopkeeper
`place_shop` emits there are no quest givers or anything with a switch behind it — every NPC
`populate_map` produces is one page that says one thing.

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

### Commerce and loot

`place_shop` puts a working shop on a map; `decorate_dungeon` now fills its chests from the
project's own database instead of handing over the same id every time.

- `src/core/shop.ts` — goods encoding, stock selection (pure, unit-tested)
- `src/core/loot.ts` — loot tables and dealing (pure, unit-tested)
- `src/tools/shop-tools.ts` — the MCP tool

**This is the first phase where counting sample events was not available.** Every project on
hand holds just **4 shop pages**, all in one project — nothing like the 157 stair pages or 635
torches earlier phases rested on. Four events cannot settle what a shop page looks like, and
pretending otherwise would have been the first invented rule in the codebase.

**So the ground truth moved from the sample maps to the corescript**, which ships with every
*project* rather than only with the editor. An interpreter is not a matter of taste the way art
direction is, so what it defines is settled exactly:

- `Game_Interpreter.command302` builds `goods = [params]` and then absorbs the parameters of
  every `605` that immediately follows. **The 302's own parameters are the first goods row**,
  not a list of rows — which is what the existing `shop_processing` converter had already got
  right, and what a reading of the docs alone would probably get wrong.
- It passes `params[4]` to the scene as `purchaseOnly`, so that flag belongs to the shop and
  exists only on the first row.
- `Window_ShopBuy.goodsToItem` switches on `goods[0]` — 0 items, 1 weapons, 2 armours — and
  `makeItemList` prices a row as `goods[2] === 0 ? item.price : goods[3]`.

The 4 measured pages agree with all of it, and two of the four are exactly `101, 401, 302, 605`
— greet, then sell. That is the shape emitted, but the *page settings* come from `npcgen`'s
talking-NPC page, which rests on 70 samples: a shopkeeper is an NPC who then opens a shop, so
`npcEventPage` gained an optional `commands` list rather than the page being copied.

**What a shop sells is filtered by the engine's own test.** `Window_ShopSell.isEnabled` is
`item && item.price > 0`, so a price of zero already means "not tradeable" to MZ — which is
exactly what excludes the `-----Recovery Items` separator rows the RTP database is full of
(23 named items in a default project, only 19 priced). Key items go too, since
`Window_ItemCategory` splits `itypeId === 2` off from goods. That filter is shared with the
loot table, because "a real, tradeable entry" is the same question in both places.

**The chest bug this turned up.** `treasureEventPages` documented a `kind` field selecting the
database and had no such field: it always emitted command 126, so a weapon id handed the player
whichever *item* shared that number. `command126` gains `$dataItems`, `127` `$dataWeapons`,
`128` `$dataArmors`, and the two equipment ones take a fifth `includeEquip` parameter — the
reward now carries its database and the command follows it.

The default reward was worse than wrong: id 1, which in the RTP database is `-----Reserved`.
Every chest in every generated dungeon handed over a nameless nothing.

**Chests are dealt, not rolled.** With six chests and independent draws, two the same is
likelier than not, and two identical chests in one dungeon reads as a bug even though each draw
was fair — so a shuffled bag is dealt from and only cycles once exhausted. Rewards come from a
price band (the middle half by default), banded per database rather than over the three
combined: armours outnumber items four to one in the RTP database, so a shared band would be
almost entirely armour.

**`shop-sells-missing-entry` exists because nothing else would ever tell you.** `goodsToItem`
returns undefined for an id that is not there and `makeItemList` skips the row, so a shop that
has lost an item just sells one thing fewer, silently, forever. See
[phase 4's Still open](#still-open) for how it opens up database integrity generally.

**Verified by driving the real server** against a copy of a real project: three shops written
and read back out of the map file as `101, 401, 302, 605...` with the price override landing as
`[0, 7, 1, 25, true]` and a mixed-database shelf as `[2, 2, 0, 0]`; a shop asked for item 9999
refused before writing; six chests on a generated floor coming out as six *different* rewards
across all three databases with commands 126/127/128 matching; the same seed reproducing them;
and `check_project` naming the map and event after an item a shop sold was deleted.

**Still open here:**

- ~~Nothing allocates a switch.~~ *(done — see [Switches and variables](#switches-and-variables).)*
- **A shop is one page with one greeting.** No stock that changes, nothing gated behind a
  switch, no haggling, and the shopkeeper says the same line forever.
- **Nothing decides *where* a shop goes.** `generate_town` builds buildings and `place_shop`
  needs a coordinate; the two do not know about each other, so a generated town has no
  merchant in it unless one is placed by hand.
- **The loot band is stated, not measured.** Nothing in a project's data says "this is
  treasure", so which slice of the price range belongs in a chest is a judgement — unlike the
  filters around it, which are the engine's.

### Switches and variables

`allocate_switch` gets an id for a named flag; `list_switches` says what exists and what is
free; `release_switch` gives a slot back.

- `src/core/switches.ts` — allocation, growth, naming (pure, unit-tested)
- `src/tools/switch-tools.ts` — the three MCP tools

**The thing that makes this more than a naming convenience is a guard in the engine.**
`Game_Switches.setValue` is:

```js
if (switchId > 0 && switchId < $dataSystem.switches.length) { ... }
```

and `Game_Variables.setValue` is the identical test on `variables`. So the names array in
System.json is **not decoration — its length is the bound on which flags work at all.** And
going outside it fails silently in both directions, because `value()` is unguarded and
answers `false` for any id: a write does nothing, a read is false forever, and nothing at
runtime says a word. That is the worst shape a bug can have, and it is invisible in the
editor too, which simply does not list the id.

Allocation therefore has one hard rule: **never hand out an id the array does not already
cover.** `allocate_switch` extends it first, in the `20n + 1` blocks the shipped projects
use — a new project has 21 slots, and the two larger projects on hand have 101 and 201, the
odd slot in each being the unusable index 0.

Self switches are deliberately not managed here: `Game_SelfSwitches` is a plain keyed
dictionary with no bound at all, which is exactly why chests and doors can use one without
allocating anything.

**Reuse by name is what makes it callable from a generator.** Asking twice for "Village gate
open" returns the same id — matching is trimmed and case-insensitive, since the editor stores
free text and a caller who varies the case means the same flag. Claiming an id that already
carries a different name is refused outright: renaming a flag silently repoints every event
that uses it, which is how two features end up sharing one switch. Where a new flag goes was
taken from the projects rather than assumed — naming is sparse (one project names 28 of its
200 slots), so the first gap is the natural slot and the array only grows once it is full.

**Two new consistency rules come out of the same guard.** `switch-out-of-range` and
`variable-out-of-range` report ids past the end of their array, which is the one rule here
that can catch a bug nothing else could surface. Neither fired on any project on hand, which
is the right result for a rule about a silent failure — it means the rule is not noisy, not
that the failure is imaginary.

And now that flags have names, findings use them: `switch 12 ("Met the mayor") is checked but
never turned on` instead of a bare id. Unnamed ids are left bare rather than padded with
"(unnamed)", which would only add noise to a project that names nothing. That is most of what
makes allocating worth doing — otherwise naming is write-only plumbing.

**Verified by driving the real server**: a fresh 21-slot project taken through allocation,
case-insensitive reuse, an explicit id of 45 growing the array to 61 slots, both conflict
cases refused, and `check_project` catching an event that sets switch 900.

**Still open here:**

- **Almost nothing reads a flag's name back into the tools that use one.**
  `place_locked_door` takes `switchName` and allocates behind it, but `add_event_commands`
  still takes `control_switches` by id, so a caller has to allocate, remember the number and
  pass it — the same treatment applied to the command converter is the next step.
- **Nothing populates a flag's *meaning*.** An allocated switch is a name and an id; what
  turns it on and what it gates is still entirely up to the caller.

### Locked doors

`place_locked_door` puts a door on a map that asks for a key item or a switch first, says so
when the player has neither, and stops asking once it has been opened.

- `src/core/locked-door.ts` — the branch primitive and the two pages (pure, unit-tested)
- `src/tools/locked-door-tools.ts` — the MCP tool

This is the piece the previous section said was missing: the smallest thing that needs a
condition, a second page and a memory of what the player already did.

**The sample is one event.** Across every project on hand there is exactly one locked door —
`Wicked Heart` map 13, event 18 — and it is `111 [8, 35]` → SE, call the door common event;
else → SE, "Locked." One event settles nothing about wording or sound, so both are parameters
and the module says as much rather than dressing a single sample up as a convention.

**What the corpus does settle is which mechanism gets used**, and there it is not thin at all.
The engine offers two ways to gate on holding an item: a conditional branch, or `itemValid`,
the page condition built for exactly this. **`itemValid` is used on 0 of the 544 event pages
measured.** Branches on a held item appear 4 times, switch page conditions 59 times. So an
item lock is a branch, and that is a measurement rather than a preference.

Three things about the branch are exact, because the interpreter defines them:

- **The parameter shape differs per database.** `command111` case 8 is
  `hasItem($dataItems[params[1]])` and takes no third parameter, but cases 9 and 10 pass
  `params[2]` to `hasItem` as `includeEquip`. A weapon key can therefore count while it is
  equipped, and an item key cannot — the option exists on one and not the other, which is
  not something a docs-first reading would produce.
- **A branch body ends with a `0` at the body's own indent** — all 32 branches measured
  across the projects do this. `skipBranch` is
  `while (this._list[this._index + 1].indent > this._indent) this._index++`, purely
  indent-driven, so a body written flat is a body the engine runs unconditionally. That is
  why `conditionalBranch` is a function rather than three commands written inline anywhere
  they are needed.
- **Nothing may follow a transfer.** `Game_Player.performTransfer` calls `Game_Map.setup`,
  which rebuilds `_events` — the running `Game_Event` and its interpreter go with it. So the
  self switch that remembers the door is open is written *before* the 201, unlike a chest,
  which has no transfer and writes its own last. Getting this backwards would produce a door
  that asks for the key every single time, with nothing in the data looking wrong.

**The asking page is Action Button**, where an ordinary door is Player Touch. That is what the
measured locked door uses, and it is the only trigger that makes sense for a refusal: a
touch-triggered locked door announces itself every time the player brushes past. The second
page is an ordinary door conditioned on self switch A, and it goes *after* the asking page
because `findProperPageIndex` scans `for (let i = pages.length - 1; i >= 0; i--)` and takes
the first match — a conditioned page placed first can never win.

**Both ways of getting the lock wrong are silent, so both are refused before anything is
written.** A key that is not in the database makes `hasItem` false forever; a switch past the
end of System.json's array can never be turned on, because `setValue` is bounded by the array
length. Either way the door simply never opens, and nothing at runtime says why. A
`switchName` with no flag behind it is allocated exactly as `allocate_switch` would — which is
the first tool to take a flag by name rather than by id, and the gap the previous section
listed as still open.

`branch-checks-missing-entry` covers the same failure after the fact, for a key deleted later.
It is a strictly worse bug than the shop rule it sits beside: a shop missing a row still sells
everything else, but a branch that can never be taken takes whatever it guards out of the game.

**Verified by driving the real server** against a copy of a real project: an item-locked door
written and read back out of the map file as `111 [8, 7]` with the branch body at indent 1,
the `126` and `123` before the `201` and the transfer last in its body; the unlocked page
following it with the self-switch condition and a Player Touch trigger; a `switchName`
allocating switch 1 and the same name in different case reusing it; and four refusals — item
9999, switch 900, a destination map with no data file, and (after deleting the key) a
`check_project` naming the map and event whose lock can no longer be opened.

**Still open here:**

- ~~**Nothing puts the key anywhere.**~~ *Done:* `place_key_for_door` — see
  [Quests](#quests--joining-the-pieces-up) — and ~~a switch lock has nothing to open it~~
  *(done: `place_lever`, see [Levers](#levers--the-thing-that-sets-a-switch))*.
- **`remember` is all or nothing.** A door either forgets its lock forever after one opening
  or re-tests it every time; there is nothing in between, such as a door that relocks at night.
- **The refusal is one line of text.** No guard who stops you, no hint about where the key is.

### Quests — joining the pieces up

`create_key_item` puts a proper key in the database; `place_key_for_door` puts a particular
door's key in a chest, and refuses when that would make the game unwinnable.

- `src/core/quest.ts` — the key row and the graph walk (pure, unit-tested)
- `src/tools/quest-tools.ts` — the two MCP tools

Chests, shops, flags and locked doors all existed separately by this point, and **nothing
decided that *this* chest holds the key to *that* door.** That is the whole of what a quest is
at this scale, and it is one relationship, not a new subsystem.

**The bug being ruled out is a key placed behind the door it opens.** The game is unwinnable
and nothing says so: the player explores, finds nothing, and no rule in the engine or the
editor mentions it. It is the same class of failure as everything else in this phase — silent,
total, invisible in the editor — which is why it is a refusal rather than a note in the output.

**The check is a graph walk, and the graph was already there.** `map-graph.ts` builds the
world's transfer edges; drop the ones belonging to the locked door, walk forward from
`startMapId`, and ask whether the key's map is still in the set. Three details matter and are
tested:

- **Only the door's own edges are dropped**, not every edge between the two maps. A second,
  unlocked way through means the key is reachable, and refusing that placement would be wrong.
- **A key on the door's own map passes.** Standing in front of a locked door is not the same as
  being through it, and the check is about the maps the door *leads to*.
- **Edges are one-way**, because transfers are. A way in is not a way out.

**Where it cannot prove the answer it says so** rather than refusing. A project with
variable-driven transfers has routes static analysis cannot see, so the verdict downgrades from
"unwinnable" to "no route found, and this project has transfers I cannot resolve" — the same
conservatism phase 4 is built on. `allowBehindDoor` exists for the case that is deliberate: a
door meant to be opened from the far side, as a shortcut back.

**A key made with `create_entity` is a key the player can destroy**, which is why
`create_key_item` exists at all. The default item row is `occasion 0` and `consumable true`;
`Game_BattlerBase.isOccasionOk` accepts occasion 0 outside battle, so the key is usable from
the menu, and `Game_Party.consumeItem` spends one of anything consumable when it is used. The
player can eat the key and lock themselves out of the game for good.

So the fields come from what the engine does with each, not from the corpus:

| Field | Value | Why |
|---|---|---|
| `itypeId` | 2 | `Window_ItemList.includes` splits the Key Items category on exactly this |
| `occasion` | 3 | "Never" — `isOccasionOk` is false in *both* branches, in battle and out |
| `consumable` | false | closes the same door from the other side |
| `price` | 0 | `isTradeable` needs a price above zero, so shops and loot tables both skip it |

**This is a deliberate departure from the one key the corpus contains.** `Wicked Heart`'s "Inn
Key" is `itypeId 1`, `consumable true`, `occasion 0` — an ordinary item that happens to open a
door, and exactly the combination described above. Where a single sample disagrees with four
engine guarantees, the engine wins, and the departure is recorded rather than quietly made.

The chest is not new code: it is the measured pickup shape `decorate_dungeon` already emits,
with the key as its loot, and the placement gets the same connectivity test a treasure chest
gets — it is priority 1 and blocks its tile.

**Verified by driving the real server**: a key item written to Items.json as
`itypeId 2, occasion 3, consumable false, price 0`; a door locked with it leading to a cellar;
the key refused inside that cellar with the reachable maps listed, then placed there anyway
under `allowBehindDoor` with the cost stated; the same key accepted outside the door; and three
more refusals — an event that tests nothing, a switch-locked door (which has no key to place),
and a second key of the same name.

**Still open here:**

- ~~**A switch lock has no counterpart.**~~ *Done:* `place_lever` — see
  [Levers](#levers--the-thing-that-sets-a-switch). An NPC who throws the flag for you, a
  pressure plate, or a battle that sets it are all still missing.
- ~~**Nothing chooses the placement.**~~ *Done for a dungeon floor:* `lock_dungeon_floor` picks
  the door tile and the dead end the key goes in — see
  [Locking a generated floor](#locking-a-generated-floor). A key for a *hand-made* map still
  needs a coordinate.
- **One key, one door.** No multi-step chains, no quest that needs two things, and nothing
  tracks a quest's state as a whole.

### Levers — the thing that sets a switch

`place_lever` puts an object on a map that turns a switch on. It is the other half of a
switch-locked door: `place_key_for_door` refuses one, correctly, because a switch has no key
to find.

- `src/core/lever.ts` — the two pages and the Control Switches command (pure, unit-tested)
- `src/tools/lever-tools.ts` — the MCP tool

**There is no lever anywhere in the corpus.** Of 422 events, 38 pages set a switch and not one
is an object the player pulls — they are cutscenes, autoruns, parallel processes and NPCs. So
unlike the shop (4 samples) or the locked door (1), this had *nothing* to copy, and saying so
is the point: the shape is assembled from parts that were measured elsewhere, and from the
engine.

**The art was measured off the sheets**, which is where the strongest finding came from.
`!Switch1` and `!Switch2` are 576x384 — eight 48x48 character slots — and in every slot the
four *direction* rows are four frames of one movement rather than four facings. Rendering them
and looking settles what they are: `!Switch1` slot 0 is a handle swinging from one side to the
other, slot 4 a button pressing flat, `!Switch2` slot 0 a wall lever whose handle drops from
top to bottom. The three pattern columns differ by 2-3%, an idle bob rather than a state. That
is the same layout `!Chest` uses, so **direction 2 is resting and direction 8 is thrown**.

**Which makes `directionFix` load-bearing rather than decorative — and explains an older
mystery.** `Game_Event.start` calls `lock()` for triggers 0, 1 and 2, and `lock()` calls
`turnTowardPlayer()`. On a sheet whose direction axis carries *state*, that means the engine
changes the lever's frame the instant the player uses it. The guard is in `setDirection`:

```js
if (!this.isDirectionFixed() && d) { this._direction = d; }
```

so `directionFix: true` makes the turn a no-op. The measured chest and torch pages both set it,
which until now read as a stylistic habit and is in fact the same necessity.

**The thrown page is gated on the switch, not on a self switch.** A lever is the flag's
display: if a quest or another lever turns that flag off, the lever should spring back to
resting, and a self switch would freeze it thrown forever. That is exactly the opposite of the
chest, whose self switch is right because "already looted" is a fact about the chest rather
than about the world — the two cases look identical and are not, which is worth stating
because getting it backwards produces a lever that lies about the state of the game.

**One way by default.** Without `toggle` the thrown page has no commands at all, and
`Game_Event.start` needs `list && list.length > 1` before an event will even start — so a
thrown lever is inert in the engine's own terms rather than by convention. A toggle's thrown
page writes `[id, id, 1]`, the off value, which 9 of the 38 measured switch writes also use.

**Setting a switch does not cut the page short**, unlike the transfer case in
[Locked doors](#locked-doors). `Game_Map.setupStartingMapEvent` hands `event.list()` to the
interpreter, which keeps its own reference (`this._list = list`), so the page change the switch
triggers cannot truncate the run already in flight — a lever can say a line after throwing
itself. The two rules are opposite and both are the interpreter's, not a matter of taste.

**It reuses the key's reachability walk.** A lever behind the only door it opens can never be
thrown, which is the same dead end as a key behind its own door, so `checkOpenerPlacement`
serves both and differs only in wording. The deliberate case — find another way in, open the
gate from inside — passes the check, because it only fails when *no* other route exists.

The tool also reports which doors the switch opens, by scanning every map with `readLock`, and
says plainly when nothing reads the flag yet.

**Verified by driving the real server**: a switch-locked gate to a walled garden; the key tool
refusing it; the lever refused *inside* the garden and named the door that traps it; the same
lever accepted outside, listing the door it opens; a toggle on `!Switch2` writing `[2,2,0]` on
one page and `[2,2,1]` on the other; and refusals for switch 900 and for no switch at all.
Afterwards `check_project` reports nothing at all — the `switch-read-never-written` warning the
gate produced on its own is gone, because something now writes it.

**Still open here:**

- **A lever is the only thing that throws a flag.** An NPC who opens the gate when you have
  done them a favour, a pressure plate, a switch thrown by finishing a battle — none exist.
- ~~**Nothing places it.**~~ *Done on a generated floor:* `lock_dungeon_floor` with
  `lockKind=switch` puts the lever in a dead end on the near side — see
  [Locking a generated floor](#locking-a-generated-floor).
- **No lever puzzles.** Two levers that must both be on, or a sequence — anything needing more
  than one flag has to be assembled by hand, and nothing checks such a combination is solvable.

### Locking a generated floor

`lock_dungeon_floor` takes a map id and produces a quest: it finds the tile that divides the
floor, locks a door onto it, creates the key, and puts the key — or a lever — in a dead end on
the side the player starts.

- `src/core/chokepoint.ts` — articulation points and how a floor splits (pure, unit-tested)
- `src/tools/floor-lock-tools.ts` — the MCP tool

This is the first tool where **nobody chooses where anything goes**. Everything before it
placed what it was told to place; the shops, doors, keys and levers of the previous sections
all take a coordinate. That is what kept a generated dungeon scenery-with-props rather than
somewhere to play.

**The tile it needs was already being computed, with the verdict reversed.** `rejectSealingSlots`
drops any prop whose tile, made solid, would cut part of the map off. A locked door wants
exactly those tiles for exactly that reason — they are the ones that separate the floor into
before and after. The existing test is a chokepoint detector read backwards, and the new module
is the other half of it.

**Brute force would have worked and would not have scaled.** Blocking each floor tile in turn
and flooding is O(n²): fine on the 400-tile floors the generator makes at 40x30, ruinous at
120x120. Candidates come from Tarjan's articulation points in a single pass — iteratively,
because a dungeon is exactly the long-thin-corridor shape that makes a recursive DFS deep —
and only those few are flooded to measure the split, which is what the caller needs anyway.

**What a generated floor actually offers was measured, and it is the opposite of the
intuition.** Across 40 seeds of each:

| Layout | Floors with a chokepoint | Best split (median) | ≥5% | ≥15% |
|---|---|---|---|---|
| dungeon 40x30 | 40/40 | 7.1% | 30/40 | 7/40 |
| dungeon 60x45 | 40/40 | 4.7% | 17/40 | 0/40 |
| cave 40x30 | 40/40 | 2.2% | 14/40 | 9/40 |

**Bigger floors split worse**, because more corridors means more loops and a loop has no cut
vertex at all. The first default written here was 0.15, chosen by eye; it rejects 33 of 40 small
dungeons and *all* 40 large ones. The measurement moved it to 0.05 — and the refusal now names
the fraction actually available and the value to pass to take it, because "lopsided" without a
number is not something a caller can act on.

**Locking the same floor twice needed one more rule.** The second call originally put its door
one tile from the first, gating the same region behind two keys. An existing locked door is now
treated as a *wall* while searching, so a second lock divides the part of the floor the player
can still reach — which is also the only place its key could sensibly go.

**And one refusal turned out to be a lie worth fixing.** A floor with no chokepoint at all was
reported as "wide open chambers, try a dungeon layout". Driving it against a real project showed
the actual cause was the surround material being a *walkable* one, so the map was one open room
and nothing could ever divide it. The message now says both possibilities and points at
`configure_tileset_passage` and `describe_tileset_materials` — passability lives in
Tilesets.json, and no amount of layout will fix a wall that is not a wall.

**Verified by driving the real server** against a generated 40x30 dungeon: a door at (7, 11)
guarding 27 of 412 tiles with its key in a dead end at (33, 22) clear across the floor; a second
call adding a lever-locked door at (16, 8) in a different region, reporting that it treated the
first as a wall; refusals for a lopsided split, for a map with no entrance event, and for the
open field with its walkable surround. `check_project` reports nothing on the result.

### What is behind the door

A lock with nothing behind it is a lock the player resents, so `lock_dungeon_floor` fills the
far side as well: a chest in its **deepest dead end**, drawn from the top quarter of the
tradeable price range.

Three decisions, and only two of them are measurable.

**Deepest dead end, not nearest.** A chest one step past the door is a chest you can see
through the doorway, and the walk is the point. Dead ends for the reason treasure already uses
them — one way in, nothing beyond, so a chest that blocks its tile cannot cut anything off.

**The top quarter of the price band is stated, not measured**, and the module says so. An
ordinary chest draws from the middle half; nothing in a project's data says what belongs behind
a lock, so "better than the corridor" is a judgement. Recording it as a judgement is the point —
this is the same class of claim as the loot band itself, and it sits beside claims that *are*
the engine's.

**That the reward is new, however, is enforced.** Everything the map already hands out is read
off its own events and excluded from the draw, because a prize that duplicates a chest in the
corridor outside is worse than a small prize. `dealLoot` has always guaranteed no repeat within
one deal; `withoutEntries` is the same guarantee across separate calls. Only *gains* count — a
Change Items with operation 1 takes something away (a door consuming its key) and must not stop
that entry being used as a reward, which `operateValue` settles: it negates the value when the
operation is 1.

**The chest looks different, and that is as far as the art goes.** Rendering the `!Chest` sheet
shows its eight slots are colour variants rather than tiers — 0-3 and 7 ornate with gold and
cloth, 4-6 plain wood and steel — so which slot reads as "better" is not a fact about the sheet.
What matters is that the reward chest differs from the 0 `decorate_dungeon` uses, so it does not
read as one more of the same.

**Verified by driving the real server**: a single reward behind a door coming out as armour 70
"Master Circlet" (5860) in the deepest dead end; then `decorate_dungeon` scattering four
ordinary chests and a third lock drawing three more rewards — 11 things handed out across the
floor, **all 11 different**, the vault chests on slot 1 and the ordinary ones on slot 0, and
each with the gain command its database requires (126/127/128).

### Why the door is there

A door that divides a floor and guards a good chest was still missing the thing that makes a
lock a lock: the key was called "Key to map 2", the door said "It's locked.", and nothing in
the game told the player a key existed at all. A player meeting that walks away — which makes
the lock a wall rather than a thing to solve.

- `src/core/vault.ts` — the themes, the direction wording and the sign event (pure, unit-tested)

**A theme is three strings that have to agree with each other**: what the room is, what its key
is called, what the door says. Treasury, armoury, storeroom, cell, crypt. It also decides which
databases the reward comes from — an armoury holds weapons and armour, a storeroom supplies —
so the fiction reaches the loot table instead of stopping at the text, which is the only part
of it the player can act on.

**Themes rotate per lock for a mechanical reason, not for variety.** A key is reused by name,
so two treasuries on one floor would want one "Treasury Key" between them and the second door
would open for free.

**The inscription is generated, and that is the point.** It goes beside the door and names the
direction the opener *actually* went:

> Scratched into the stone: 'What we took, we keep. The steward holds the key.'
> The key lies a long way to the east.

Everything else in this module is writing; that sentence is read off the placement the tool
just made, which makes it the one claim on the map a player could catch out and the one that
cannot be wrong. Diagonals are only named when both axes are worth naming — "north-east" for a
key that is barely north reads as a wrong answer even though it is a true one.

**A lever-locked door gets different copy**, because the armoury's "no key, no blade" beside a
door with no keyhole is a sign arguing with the mechanism. Coherence was the whole reason for
the feature, so a hole in it would be worse than none.

**The sign shape is measured, and the tie-break is the engine's.** Across the projects there are
39 single-page events whose commands are nothing but Show Text, and **37 are Action Button** —
settled. Only 4 have no sprite at all, the true inscription case, and they split 2/2 between
priority 1 and priority 0. With the sample tied, the argument comes from where this event goes:
beside a locked door, which stands on a chokepoint, where a priority-1 event blocks its tile and
could seal the floor. Priority 0 cannot, and `Game_Player.triggerButtonAction` starts it through
`checkEventTriggerHere([0])` when the player stands on it and presses — the safe choice is also
a working one.

Text runs through `dialogueCommands`, the wrapping the NPC pages already use: a message box is
four lines and the engine measures text in pixels, so an inscription emitted as a single `401`
runs off the window. That was a real bug in the first version of this, caught by reading the
tool's own output rather than by a test.

**Verified by driving the real server**: three locks on one generated floor coming out as a
treasury (mixed loot, `Treasury Key`), an armoury (weapon 29 "Dragon Spear", opened by a lever,
with the lever-specific notice) and a storeroom (three items, item-only) — each with its own
key or switch, its own door name, and an inscription wrapped to three lines whose direction
clause matches where the opener was put.

**Still open here:**

- **A reward is a chest, and nothing else.** No boss, no set piece — the far side is a room
  with better loot in it and a name.
- **Five rooms is five rooms.** The copy is a table; a sixth theme is five more strings, and
  nothing generates prose that fits the *project* rather than the genre.
- **Nothing connects one floor's fiction to the next.** Each lock is themed on its own, so a
  three-floor dungeon is a treasury, an armoury and a storeroom with nothing between them.
- **One door per call.** A floor with three good chokepoints has to be locked three times, and
  nothing reasons about the sequence — which is the difference between a locked floor and a
  dungeon that unfolds.
- **The caves are barely lockable.** A median best split of 2.2% says most cave floors have no
  meaningful division at all, which is a fact about the cave generator rather than about this
  tool.

### The region plane — the sixth layer

`data[(z * height + y) * width + x]` has six planes. Five were reachable: 0-3 through
`fill_map_region` and `paint_tiles`, 4 through `apply_wall_shadows`. **z=5, the region id, had
no tool at all** — so a generated map could not carry an encounter zone, and none of the very
many plugins keyed on region id could see anything.

**What the engine does with it** — the strongest kind of claim here, straight from v1.9.0
`rmmz_objects.js`:

- `Game_Map.regionId(x, y)` is `this.isValid(x, y) ? this.tileId(x, y, 5) : 0`. The raw stored
  value, no decoding, no tileset. Every other plane needs the tileset to mean anything; this
  one does not, which is why the tool is small.
- `Game_Player.meetsEncounterConditions` returns
  `encounter.regionSet.length === 0 || encounter.regionSet.includes(this.regionId())`. That is
  the entire mechanism for "wolves in the woods, not on the road".
- Get Location Info (interpreter command 285) reads it into a variable at its `default:` case.

**What the corpus says: nothing — and that is the finding.** Counted over all 293 sample maps:
**0 write a single non-zero region tile**, and **all 293 ship an empty `encounterList`**. Across
the user's own projects, 1 map of 64 uses the plane (Wicked Heart Map025: region id 1, 335 tiles
in 11 disconnected areas, 5 of them a single tile), and 0 of 64 have an encounter list either.

So the corpus cannot say how big a region should be, which ids mean what, or whether an area
ought to be contiguous. `src/core/regions.ts` therefore invents no convention: it writes what
the caller asks for and reports what it wrote. The one bound that is **stated, not measured** is
the id range 1-255 — that is the editor's region palette, not an engine limit (`regionId` would
happily return 4096), and it is refused because a value the editor cannot display is a value
nobody can maintain by hand afterwards.

**What `paint_regions` refuses**, each naming what was wrong:

- an id outside 0-255, before writing anything;
- a rectangle lying *entirely* off the map — clipping it to nothing and reporting success would
  be the silent no-op this repo exists to avoid. A rectangle that merely *overruns* the edge is
  clipped, matching `fill_map_region`, and the clipped bounds come back in the result;
- a tile list with any entry off the map — all-or-nothing, like `paint_tiles`, because a partial
  write leaves the caller unable to tell which half landed;
- both a rectangle and a tile list in one call, or neither.

**What it surfaces rather than hides:** how many of a region's tiles are impassable, computed
with the same `Game_Map.checkPassage` port `check_map_walkability` uses. This is the failure
mode nothing else catches — an encounter `regionSet` over tiles the player cannot stand on never
fires, and neither the editor nor the engine complains. Driving the real server over stdio MCP
against a generated 17x13 dungeon, an 8x5 region painted across it came back
`3 of region 3's 40 tile(s) are impassable`; a single tile painted onto a wall came back as the
stronger `all 1 tile(s) ... the player can never stand in it`.

`get_map_grid` gained `showRegions`, which prints the plane as a second grid — a separate grid
rather than a glyph in the first, because a region is orthogonal to terrain and a tile commonly
has both. Ids 1-9 print as themselves so the usual case reads directly; higher ids get a letter
and a legend line, since a cell is one character wide and an id can reach 255. When a map has
regions and the caller did not ask to see them, the output says so rather than staying silent.

**Verification note:** this is the one map-writing feature a PNG cannot check. The region plane
is not drawn — `Tilemap` never reads z=5 — so `scripts/render-map.mjs` renders a map with
regions identically to one without. The text grid *is* the visual check here, and the read-back
above was done by driving the real server, not a test harness.

**Still open here:** nothing generates regions. `generate_map_layout`, `generate_town` and
`lock_dungeon_floor` all know exactly where their floor, streets and rooms are and could mark
them without being told — tracked as P5-27. And no tool writes `encounterList`, so even a
correctly regioned map has nothing to gate: that half belongs with P5-17.

### A2 columns predict nothing

A documentation fix, but the measurement behind it changes what the docs are allowed to say.

The repo carried a shortcut in prose: *"columns 1-4 are patch materials with visible
outlines"*. It appeared in `autotileKind`'s description, in the verification caveat above and
in CLAUDE.md's advice on picking a test material. Finding 1 had already established that the
opaque/overlay split is per-tileset — but the shortcut survived anyway, in the one place a
caller would read it, and following it lands directly in finding 1's black holes.

**Measured** with `scripts/measure-a2-columns.mjs`, which runs the existing classifier
(`src/core/tileset-image.ts`) over every A2 sheet the RTP ships and joins the result to the
editor's own tile-label `.txt` files — 4 sheets, all 32 kinds each, 128 kinds total:

| column | ground | overlay | empty | of the ground ones: outlined / seamless |
|---|---|---|---|---|
| 0 | 16 | 0 | 0 | 4 / 12 |
| 1 | 12 | 4 | 0 | 4 / 8 |
| 2 | 16 | 0 | 0 | 13 / 3 |
| 3 | 12 | 4 | 0 | 12 / 0 |
| 4 | 5 | 10 | 1 | 5 / 0 |
| 5 | 7 | 5 | 4 | 7 / 0 |
| 6 | 3 | 11 | 2 | 3 / 0 |
| 7 | 3 | 9 | 4 | 3 / 0 |

The old sentence is wrong for **30 of the 64 kinds in columns 1-4** — and wrong in both
directions. Column 4 is an overlay 10 times out of 16 (`Bush` in `Outside_A2`,
`Hole A (Orange Cave)` in `Inside_A2`), so a caller painting it on layer 0 gets the background
showing through. Column 1 is a *seamless* ground 8 times out of 16 (`Ground B (Grass Maze)`,
`Ground F (Stone Floor Brick)`), so a caller using it for a path gets no visible boundary.

The stronger result is that **no column rule can be right**. The columns that are opaque *and*
outlined in every row of their own sheet are:

| sheet | safe columns |
|---|---|
| `Outside_A2` | 1, 2, 3 |
| `Inside_A2` | 3 |
| `Dungeon_A2` | 2, 3, 4, 5 |
| `World_A2` | 0 |

The intersection is empty. `World_A2` is the sheet that breaks every candidate: its column 0
(`Grassland A`) is the only safe material it has, and it is the one column every other sheet
uses for a seamless fill. Column 3 comes closest — 12 ground, all 12 outlined — but the other
4 are `World_A2` overlays.

**What changed:** the sentence is gone from every tool schema, from the module header and from
CLAUDE.md, replaced by a pointer to `describe_tileset_materials`, which reads the actual sheet.
`generate_map_layout`'s `floorKind`/`surroundKind` and `generate_interior`'s `floorKind` had no
guidance at all and now carry the warning, since all three paint an A2 material across most of
a map. `tests/core/tileset-image.test.ts` gained a case that classifies a synthetic sheet whose
column 0 is an outlined patch and whose column 4 is a transparent overlay — the inverse of the
old rule — so the shortcut cannot be reintroduced in the classifier without a red test.

**Sample caveat:** 4 sheets is every A2 sheet the RTP ships and every one present in the
user's projects, but it is not a sample of third-party or custom art. The claim proved here is
the negative one — *no column rule holds across the sheets that exist* — which custom art can
only strengthen.

**Still open here:** the descriptions now warn, but `generate_map_layout` and
`generate_interior` still do not *check*. `fill_map_region`, `paint_tiles` and `generate_town`
consult `loadA2Materials`; those two do not, so they will paint an overlay across a whole floor
without a word. That is a refusal the repo's own rule asks for — tracked as P5-26.

### Naming a flag in a command list

`allocate_switch` gave a named flag an id, and both `place_lever` and `place_locked_door` took a
`switchName` and allocated behind it. `add_event_commands` did not — a caller had to allocate
first, remember the number, and hand it back as `startId`. Two ways of naming the same thing, and
the one used to build the *logic* was the one that spoke only in numbers.

**Measured** with `scripts/measure-flag-usage.mjs`, which counts every command code that carries a
global switch or variable id across the sample maps, the `newdata` reference project and the three
projects under `M:/Projects/RPGMZ`:

| | samplemaps (293) | Wicked Heart (64) |
|---|---|---|
| 121 Control Switches | **0** | **43** |
| 111 branch on a switch (type 0) | **0** | **23** |
| switch page conditions | **0** | **62** |
| common event trigger switch | 0 | 40 |
| 122 Control Variables | **0** | **2** |
| 111 branch on a variable (type 1) | **0** | **2** |
| variable page conditions | 0 | 1 |
| self-switch page conditions | 0 | 49 |

Two findings, and the second is the one that decided the design:

1. **The 293 sample maps contain no global switch or variable at all.** Not one 121, one 122, or
   one switch page condition. As with the region plane, the corpus is silent here — the sample
   maps are rooms, not scripts — so nothing about naming can be argued from it, and the command
   shapes come from `Game_Interpreter` instead.
2. **In the one project on hand with real logic in it, every referenced switch is named.** Wicked
   Heart refers to **26 distinct switch ids and all 26 carry a name in System.json** (out of 28
   named in total, so only 2 named flags are unused). Both variable ids it refers to are named as
   well. The name is already the handle a real project works in; the id is bookkeeping the author
   keeps in their head.

So `src/core/command-flags.ts` rewrites `switchName` / `variableName` into ids before conversion,
on the three commands where the traffic is: `control_switches`, `control_variables`, and
`conditional_branch` on the type that actually reads a flag. Variables get the same machinery
because it is the same allocation — but 2 and 2 is **far too thin a sample** to claim anything
about how variables are used, and nothing was invented for them beyond the shape the engine
defines.

Names resolve the way `place_lever`'s does: an existing flag of that name is reused
(case-insensitive, trimmed — the same `findFlag` comparison), otherwise one is allocated exactly
as `allocate_switch` would, growing the array when it is full so the id is one `setValue` can
actually reach. A `startId` alongside a name is the id to *claim*, not a second way of saying
which flag. One name used by several commands in a batch resolves once and yields one id.

**What it refuses**, each naming what was wrong:

- a name on a command that has no flag in it — `{ type: "show_text", switchName: ... }` is a
  caller who believes something is gated when nothing is, so the key is refused rather than
  dropped;
- `switchName` on a `conditional_branch` whose `conditionType` is not 0, or `variableName` on one
  that is not 1. `command111` reads `params[1]` as a switch id only on type 0 and as a variable id
  only on type 1; on type 2 it is a self-switch letter, on type 4 an actor id;
- a name and an `endId` together — a name denotes one flag, and `command121` loops
  `params[0]..params[1]`, so there is no range for a name to cover;
- a branch naming both a switch and a variable;
- renaming a flag that already carries a different name, which `allocateFlag` was already
  refusing.

Resolution runs over the whole list before anything is returned, so a refusal on command 7 leaves
System.json untouched rather than stranding six freshly allocated flags behind a rejected batch.
System.json is only opened when a name is actually used, so an id-only caller is unaffected by a
project whose System.json is missing.

**Two things it surfaces rather than hides:**

- **An id past the end of the array.** `Game_Switches.setValue` is guarded by
  `id < $dataSystem.switches.length` and `value()` is not guarded at all, so `Set switch 90 = ON`
  in a 21-slot project does nothing and every condition reading it is false forever, with no
  error at any point. `add_event_commands` now says so at write time — the only moment anything
  can. Driven against a real project: *"switch 90 is past the end of System.json's switches array,
  which reaches 20."*
- **A conditional branch does not yet gate anything.** `convertCommand` emits every command at
  `indent: 0`, and `Game_Interpreter.skipBranch` advances only `while (this._list[this._index +
  1].indent > this._indent)` — so a false branch skips nothing and the commands after it run
  regardless. Adding a `switchName` to a branch would otherwise be putting a good handle on a
  broken thing. The warning is emitted whenever a 111 is added; the fix needs a nesting model
  (`else`, `end`, per-command indent) and is tracked as **P5-28**.

**One engine bug fixed on the way.** `conditional_branch` emitted three parameters for every
condition type. `command111` case 1 (Variable) reads `params[3]` as the value to compare against
and does `switch (params[4])` to pick the comparison — with three parameters that switch falls
through every case and `result` stays `false`, so **a variable branch built through
`add_event_commands` could never be taken**. It now emits the pair, defaulting to `== 0`, and
accepts `param3` / `param4`. Type 0 still emits exactly the three parameters `command111` case 0
reads, so nothing that worked before changed shape.

**Verified** by driving the real server over stdio MCP against a copy of the `Learn` project:
naming an unknown flag allocated switch 1 and reported it; the same name in the next call was
reused rather than burning id 2; `startId: 3` alongside a new name claimed exactly 3; and the
written JSON is `121 [1,1,0]`, `111 [0,1,0]` and `111 [1,1,0,3,1]` — the parameter shapes
`command121` and `command111` read.

**Still open here:** switch page conditions were the largest single count in the measurement (62)
and no tool wrote one at all, outside the generators that build their own pages — now closed, see
[Making a page respond to a flag](#making-a-page-respond-to-a-flag). `control_variables`'s five
operands collapsing onto one `value` field (the Random one giving `Math.randomInt(NaN)`) is also
now closed, see
[Every control_variables operand gets its own field](#every-control_variables-operand-gets-its-own-field).
The read side of a variable operand (`params[4]` on 122, `params[3]` on a 111 type 1) still takes
an id rather than a name; the corpus shows 0 uses of either, so nothing argues for it yet.

### Indent is the gate

`add_event_commands` emitted every command at `indent: 0`. That looked cosmetic and was not:
**indent is the only thing the engine uses to find the end of a block.**

```js
Game_Interpreter.prototype.skipBranch = function() {
    while (this._list[this._index + 1].indent > this._indent) {
        this._index++;
    }
};
```

`executeCommand` sets `this._indent` from the command it is about to run, and `command111`
calls `skipBranch()` when the condition is false. On a flat list nothing is ever deeper than the
branch, so `skipBranch` advances **zero** commands and the body runs either way. Every
`conditional_branch` this server had ever written was decoration. The same applies to
`command411` (Else, skips when the branch *was* taken), `command402` (When) and `command413`
(Repeat Above, which walks `_index` backwards to a command at its own indent) — all of it is
indent arithmetic.

**Measured over the corpus** — 3014 command lists across the 293 sample maps, the `newdata`
reference project and the three projects under `M:/Projects/RPGMZ`; 11172 commands. Only **37
lists contain a branch, loop or choice at all**, so structure is a thin sample and the code says
so — but inside those 37 the rules hold with no exceptions at all, which is what makes them safe
to encode:

| claim | count | exceptions |
|---|---|---|
| lists ending `{code: 0, indent: 0}` | 3014 / 3014 | 0 |
| block markers at their opener's indent | 82 / 82 | 0 |
| conditional branches closed by a 412 | 34 / 34 | 0 |
| branches and loops followed by a deeper command | 37 / 37 | 0 |
| `show_choices` followed by a 402 at the *same* indent | 9 / 9 | 0 |
| mid-list `{code: 0}` immediately before a shallower marker | 95 / 95 | 0 |

Three of those settled a design question rather than merely confirming one:

- **The terminator is load-bearing.** `skipBranch` reads `this._list[this._index + 1]`
  *unguarded*, so a list ending in a branch with nothing after it throws. All 3014 lists carry
  the `{code: 0, indent: 0}` terminator, which is why nobody has ever seen that crash. A test
  asserts the port throws on an unterminated list, so the reason the tool always appends one is
  recorded rather than folklore.
- **A choice block is the one construct whose body does not start at the opener.** All 34
  branches and all 3 loops are followed by a deeper command; all 9 `show_choices` are followed by
  a `402` at the *same* indent. So commands written between `show_choices` and its first
  `when_choice` run before the player has chosen anything — which is now a refusal.
- **The editor leaves a blank line at the end of every block body.** All 95 mid-list `code: 0`
  commands sit immediately before a marker at a shallower indent — 34 before an `End If`, 27
  before a `When` or `End Choices`, 9 before an `Else`, 3 before a `Repeat Above`, the rest
  before battle-result markers. It costs nothing at runtime (there is no `command0` method) and
  it makes the output a file the editor would have written, so `assignIndents` emits it.

Deepest indent anywhere is **3** (10225 commands at 0, 829 at 1, 113 at 2, 5 at 3). That is a
fact about hand-made events, not a limit — nothing in the engine caps nesting and neither does
this.

`src/core/command-nesting.ts` holds the model. Indent is **computed, never passed**: a caller
who could set it by hand could write a list the engine walks differently from the way it reads,
which is the entire bug. Three block kinds, one mechanism:

```
conditional_branch … [else] … end_branch
loop … repeat_above                        (break_loop jumps out)
show_choices … when_choice / when_cancel … end_choices
```

`end_branch` (412), `repeat_above` (413), `end_choices` (404), `when_choice` (402), `when_cancel`
(403) and `else` (411) are new command types. Neither `command412` nor `command404` exists in the
interpreter at all — they are pure structure, and what actually ends a block is the indent of
what follows.

**What it refuses**, each naming the block and where it opened:

- a block never closed — *"the conditional_branch at command 2 is never closed. Add end_branch —
  without it the block runs to the end of the list, and every command after it becomes part of
  the branch."*;
- a closer with nothing open, and blocks that cross (`if … loop … end_branch … repeat_above`);
- a divider in the wrong block — an `else` inside a `loop`;
- a second `else` on one branch: `command411` tests the single result stored in
  `_branch[_indent]`, so both arms would test it the same way and run together;
- a `break_loop` with no loop around it. `command113` scans forward for the matching 413 and,
  finding none, runs to the end of the list — silently skipping everything after it;
- a command between `show_choices` and its first `when_choice`, per the 9/9 measurement above;
- an `indent` supplied by the caller.

A source command that expands to several — a message is a `101` plus its `401` body lines —
gets its indent applied to **all** of them. A body line left at indent 0 would fall out of its
own branch and be spoken unconditionally, which is the original bug wearing a different hat.

**Verified against the engine's own walk, not against the emitter.** `walkCommands` ports
`executeCommand`, `skipBranch`, `command111`, `command411`, `command402`, `command403`,
`command413` and `command113` — index arithmetic only, no game state — and reports which
commands ran. Testing `assignIndents` against a restatement of its own rules would prove
nothing, because the bug was that a *self-consistent* flat list is walked by the engine in a way
nobody intended. One test builds that old flat list explicitly and asserts the body runs on a
false condition, so the bug stays pinned.

Then the same walk was run over JSON the **real server** wrote, driven over stdio MCP: a
gatekeeper with a nested branch inside an `else`, three switches allocated by name. The three
paths come back as *"The gate stands open. / Go on through. / And your toll is settled."*,
*"The gate stands open. / Go on through."*, and *"The gate is barred."* — with *"Safe travels."*
on all three.

**One read-back fixed on the way.** `describeCommands` rendered `End If` but silently dropped
`End Choices`, so the command after a choice block read as though it were inside the last `When`.
Now that the tool emits 404, that asymmetry was actively misleading.

#### Battles lead somewhere

`battle_processing` emitted a bare `301` with nothing after it, so a generated battle could not
reward a win or handle a loss — the fight happened and the story carried on identically either
way. The engine has the same indent machinery for it: `command601` / `602` / `603` each
`skipBranch()` unless `_branch[_indent]` matches the result `BattleManager.endBattle` handed to
the callback `command301` installed (0 win, 1 escape, 2 lose), and `604` has no method at all.

So this is a fourth `BlockSpec`, not a new mechanism. Two properties it needed that the other
three did not, both measured over the **13** `battle_processing` commands in the corpus:

- **It is an opener *and* a complete command.** 11 of 13 are immediately followed by a `601` at
  the same indent; the other 2 have no arms whatever. So `battle_processing` opens a block only
  when one is written — `opensOnlyBeforeDividers`. The lookahead steps over plain commands to
  the first structural one, so `battle, show_text, if_win` is read as an armed battle with a
  command in the wrong place and refused as that, rather than as a stray `if_win`.
- **Its arms are ordered.** All 11 armed battles run **Win → [Escape] → Lose → End**, without a
  single exception: 9 are `601 > 603 > 604` and 2 are `601 > 602 > 603 > 604`. Choices are the
  opposite — `when_choice` repeats once per option — so ordering is a per-block flag.

Two more correlations came out of the same count, and **only one of them became a refusal**:

- **`canLose: false` makes an `if_lose` arm unreachable, so it is refused.**
  `BattleManager.updateBattleEnd` does `SceneManager.goto(Scene_Gameover)` when
  `!_escaped && $gameParty.isAllDead() && !_canLose`. `endBattle(2)` does fire the callback, so
  `_branch[_indent]` really is set to 2 — but the scene never returns to the map, the interpreter
  never resumes, and the arm is dead code. All 11 armed battles in the corpus set
  `canLose: true`; both armless ones set it false.
- **`canEscape: false` with an `if_escape` arm is *not* refused**, though the corpus correlation
  is exactly as tight — the escape arm appears in precisely the 2 battles whose `canEscape` is
  true, 11 of 11. Following the count here would have been wrong: result 1 has three routes into
  `endBattle(1)` — `onEscapeSuccess`, `processPartyEscape`, and `checkAbort` after the **Abort
  Battle** command (340) run from a troop page — and only the first consults `canEscape`. An
  escape arm on a no-escape battle is unusual, not unreachable, so it passes. This is the case
  where the measurement and the engine disagreed about what to enforce, and the engine won.

**Verified** by walking JSON the real server wrote: a roadside ambush with all three arms, a
switch allocated by name in the win arm and gold lost in the lose arm. Win, escape and lose each
select exactly one arm, and *"The road goes on."* runs after all three. A fourth case — the troop
id not existing — skips **every** arm, because `command301` only installs the callback inside
`if ($dataTroops[troopId])`, so `_branch[_indent]` is never set and all three comparisons fail.
That behaviour is now pinned by a test, and it is the reason for P5-33.

`describeCommands` gained `If Win` / `If Escape` / `If Lose` / `End Battle`, which previously
rendered as `[code 601]`.

**Still open here:** nothing generates a branch. `place_locked_door`, `lever.ts` and `vault.ts`
build their own pages and gate with *page conditions* rather than in-list branches — which is
what the corpus does too (62 switch page conditions against 23 branches), and P5-29 is the tool
for that half. Nothing checks that a `troopId` exists before writing a battle, which the walk
above shows is silent in every direction — tracked as P5-33.

### The engine guards, then does nothing

P5-32 left a hole it had itself exposed: a `battle_processing` whose troop id is not in
Troops.json writes a `301` that starts no battle — and because
`BattleManager.setEventCallback` sits inside the *same* `if ($dataTroops[troopId])`,
`_branch[_indent]` is never set either, so **every `if_win` / `if_escape` / `if_lose` arm is
skipped too**. The player walks through an ambush that does not happen and nothing anywhere
says a word. That was confirmed by walking a real list with the interpreter port, not argued.

It is not one command's problem. The engine has a consistent habit at every database lookup —
**guard it, then do nothing** — and `add_event_commands` reached ten of them:

```js
command117: const commonEvent = $dataCommonEvents[params[0]]; if (commonEvent) {...}
command301: if ($dataTroops[troopId]) { BattleManager.setup(...); setEventCallback(...); }
command129: const actor = $gameActors.actor(params[0]); if (actor) {...}
command321: if (actor && $dataClasses[params[1]]) {...}
gainItem:   const container = this.itemContainer(item); if (container) {...}
```

So `src/core/database-refs.ts` checks them all rather than only the one the task named — the
same argument P5-26 recorded, where `generate_town` checked `roadKind` and let `groundKind`
through. Covered: troops, common events, items, weapons, armors, actors, classes, skills,
states, and every row of a shop's `goods`.

**Measured** across the databases on hand:

| | troops | common events | actors | classes | items | weapons | armors | skills | states |
|---|---|---|---|---|---|---|---|---|---|
| a new project | **5** | **4** | 8 | 8 | 30 | 50 | 100 | 235 | 30 |
| `Wicked Heart` | 100 | 40 | 10 | 10 | 150 | 50 | 110 | 350 | 40 |

The small tables are where this bites: a new project ships **5 troops and 4 common events**, so
an id picked without looking lands past the end far more easily than the 235-row skill list
would suggest.

**Actor id 0 is the trap in the other direction**, and getting it wrong would have produced
false refusals on working code. `iterateActorId(0)` iterates the whole party instead of looking
anything up, and commands 311, 313, 314, 315, 316, 318 and 326 all reach it through
`iterateActorEx` — so `recover_all` with `actorId: 0` is correct and must pass. Commands 129
(Change Party Member), 320 (Change Name) and 321 (Change Class) call `$gameActors.actor(params[0])`
directly and have no such meaning, so 0 there is a real mistake. The refusal says which group
the command is in rather than just rejecting the number.

**Troops can be named**, and the measurement says that is not a partial answer. In
`Wicked Heart` only 13 of 100 troop rows carry a name — but the split is exactly whether the row
is real: **13 named all have members, 87 unnamed all have zero members, and neither diagonal has
a single row on it.** The unnamed rows are slots the editor allocated and nobody filled. Every
troop that exists is named, in both projects, with no duplicate names in either.

Naming a troop is therefore not like naming a switch, and the difference is the point: **a troop
is content, not a slot.** `allocate_switch` creates a flag that was not there; there is nothing
sensible to create here, so an unknown name is refused — and the refusal lists the names that do
exist, so the caller can pick. An ambiguous name is refused rather than guessed at.

That 87-empty-rows finding turned into a second check. A troop row with no members is *truthy*,
so `command301` starts the battle — and `Game_Unit.isAllDead()` is
`aliveMembers().length === 0`, true on the first frame, so `BattleManager.checkBattleEnd` calls
`processVictory()` immediately. **An empty troop is a battle won before it begins**, silently.
It is refused, citing the engine rather than a house rule.

**What it will not do:** claim anything about a table it could not read. A data file that is
missing or will not parse is left out and simply unchecked — failing a whole command list over
an unreadable Skills.json would be worse than the bug. Tables are loaded only when a command
actually names one, so an id-free list costs nothing.

**Verified** against a real project copied to the scratchpad: `troopId: 9` refused against a
5-troop project; `troopName: "Goblin*2"` matched to id 1 and reported; `troopName: "Dragon"`
refused with all five names listed; `eventId: 40` refused against 4 common events; `itemId: 400`
against 30 items; `recover_all` with `actorId: 0` accepted; `change_party_member` with
`actorId: 0` refused *with the iterateActorId explanation*; a shop stocking armor 900 refused;
and an empty troop added to the copy refused with the `isAllDead` reasoning.

### One place decides whether a material can go on the ground

Visual review finding 1 said an A2 material whose edge pieces are transparent is an *overlay*:
on layer 0 there is nothing beneath it but the map background, and `Tilemap` draws that black.
`fill_map_region` and `paint_tiles` refused it. **The generators, which paint far more of a map
in a single call than either, did not check at all** — `generate_map_layout` would lay an
overlay across every open tile of a dungeon, `generate_interior` across a whole room, and
`generate_town` across the entire ground layer, each without a word.

`generate_town` is the sharpest case of how this happened: it *did* consult `loadA2Materials`,
but only for `roadKind`. `groundKind` — the fill that covers every tile of layer 0, the largest
single paint in the server — went past it unlooked-at. Five near-copies of one check, and the
biggest paint fell through the gap between them.

**How big the trap is, measured** by running the existing classifier (`classifyA2Sheet`) over
all four A2 sheets the RTP ships — 32 kinds each, 128 in all:

| sheet | ground | overlay | empty | share unusable on layer 0 |
|---|---|---|---|---|
| `Dungeon_A2` | 26 | 4 | 2 | 19% |
| `Inside_A2` | 23 | 5 | 4 | 28% |
| `Outside_A2` | 17 | 11 | 4 | 47% |
| `World_A2` | 8 | 23 | 1 | **75%** |
| **total** | **74** | **43** | **11** | **42%** |

**54 of 128 kinds cannot go on layer 0**, and on `World_A2` only 8 of 32 can. A caller choosing a
kind without asking is wrong about two-fifths of the time. That is the argument for a refusal
rather than a note.

The two shipped defaults are safe — kind 16 (`generate_town`'s `groundKind`) and kind 32
(`generate_interior`'s `floorKind`) classify as ground on all four sheets — so the trap only
springs when a caller chooses, which is exactly when nothing else is watching.

`src/core/ground-material.ts` is now the one place that decides. It is pure: handed
already-classified materials, it returns a refusal or a note. Wired into `generate_map_layout`
(`floorKind`, `surroundKind`), `generate_interior` (`floorKind`), `generate_town` (`groundKind`,
`roadKind`) and `fill_map_region`. All four gained `allowOverlayOnGround` as the deliberate
override, matching what `fill_map_region` and `paint_tiles` already had.

`paint_tiles` keeps its own wording and takes only the judgement, through
`overlayKindsAmong`. Its remedy is genuinely different — "move those entries of the batch to
another layer", not "pick a different argument" — and flattening the two into one sentence would
have made the batch message worse. One place decides what is bad; each tool phrases its own fix.

**What the refusals do**, in each case naming the kind, the argument it came from, and the
tileset — driven against a real project on the `Outside` tileset:

- *"A2 kind 22 (floorKind) is an overlay material — in tileset "Outside"."*
- *"A2 kind 23 (roadKind) is an empty slot on the sheet"* — an empty slot is a different fault
  from an overlay and is named as one.
- Every bad argument in one call is listed together, so a caller who got both `floorKind` and
  `surroundKind` wrong is told about both rather than finding the second after fixing the first.
- The check runs **before** anything is written — before `generate_town` clears the map's events
  and before `generate_interior` wipes the tile data — so a refusal leaves the map as it was.

**What it deliberately does not refuse:**

- a non-A2 kind. `surroundKind` takes an A4 wall top as often as a ground material, and walls are
  opaque by construction — there is nothing to check;
- anything above layer 0, which is where overlays belong;
- an unreadable A2 sheet. `loadA2Materials` returns null for a missing PNG, and failing a whole
  generation over that would be worse than the bug. The generators pass `reportUncheckable` and
  say the check did not happen, so a later black patch has a stated cause; the paint tools stay
  quiet, because a line on every call is noise.

**Verified by PNG, which is the only thing that could settle it.** Two 20x15 maps, same seed and
therefore the same layout, differing in one argument. With `floorKind: 22` forced through by
`allowOverlayOnGround`, the render is a black dungeon with fence posts standing in it — kind 22
in `Outside_A2` is a fence. With `floorKind: 17` it is sand with grass edges. Until this commit
the first was what a caller got, with a success message and no warning. `check_map_walkability`
on the accepted map reports 300 of 300 standable in one connected area — unchanged, as expected:
this touches what a material *looks* like, not what the passage flags say.

**Still open here:** the seamless advice is the same judgement in a weaker form and only
`fill_map_region` and `generate_town`'s `roadKind` ask for it. `generate_map_layout` suppresses
it deliberately — floor and surround are different materials, so the boundary reads by colour
whether or not either is seamless, and the note would fire on nearly every valid call.

### A sheet that is not there

The overlay check above answers *is this material safe on layer 0*. It cannot answer a question
one level below it: **is there a sheet behind this material at all.** A tileset is nine image
slots and a slot is allowed to be empty. When it is, a tile id addressing it is not an error the
engine reports — `Tilemap.Layer` binds a blank bitmap and the tile draws nothing, while the map
data goes on saying it is there. Every layer is affected, not just layer 0, and unlike an
overlay there is no situation in which a caller wants it.

**Which slot a tile belongs to is the engine's**, read off `Tilemap._addAutotile` and
`Tilemap._addNormalTile` in `corescript/v1.9.0/rmmz_core.js`: A1 is set 0, A2 set 1, A3 set 2,
A4 set 3, A5 set 4, and every other id is `5 + floor(tileId / 256)` — B, C, D, E. That last
formula leaves **ids 1024-1535 addressing no slot at all**, between the E sheet and A5.

**How often a slot is empty, measured.** Over the six tilesets a new project ships
(`newdata/data/Tilesets.json`):

| tileset | empty slots |
|---|---|
| `Overworld` | A3, A4, A5, D, E |
| `Outside` | D, E |
| `Inside` | A3, D, E |
| `Dungeon` | A3, D, E |
| `SF Outside` | D, E |
| `SF Inside` | A3, D, E |

So **four of the six have no A3**, which is where `place_building`'s `roofKind` and
`generate_town`'s `roofKinds` live, and `Overworld` has neither A3 nor A4 — the range
`generate_map_layout`'s `surroundKind` reaches into. Across the user's own projects the same
slots are the thin ones: of 22 tilesets in `Wicked Heart`, `Foo` and `Learn`, **A3 is empty in
16, D in 19 and E in 20**, against A2 in 3 and C in 3. A3/A4/D/E is where this bites.

**Is a hand-made map ever like this?** Of the 293 sample maps — 441,000 non-empty tiles between
them — 292 write only to slots their tileset fills. The single exception is `Map278`: 51 E-sheet
tiles on tileset 2, `Outside`, which has no E. That is far more likely a tileset-index mismatch
between the shipped sample and `newdata` than the editor permitting it, since the sample maps
carry a bare `tilesetId` rather than the tileset itself — but the sample is one map, so it is
recorded rather than explained away. Either way, 1 in 293 means refusing will not fight normal
authoring. The same sweep found **0 tiles in the unaddressable 1024-1535 band**, so treating
that range as a caller's arithmetic slip is safe.

**Verified by PNG**, and it is the picture the task was raised on: `generate_map_layout` with
`floorKind: 16, surroundKind: 98, seed: 7` on `Overworld` renders as an island of floor on pure
black — the entire A4 surround is absent — while the tool reports *"Surround: A4 wall kind 98"*
as a success. The same call on `Dungeon`, which has an A4 sheet, gives the dungeon the caller
meant. Both renders are in the P5-31 commit's session.

`src/core/tileset-sheets.ts` is the one place that decides, wired into `fill_map_region` (both
`autotileKind` and `tileId`), `paint_tiles` (each distinct value in the batch, labelled with the
first entry that used it), `generate_map_layout`, `generate_town`, `generate_interior` and
`place_building`. **There is deliberately no override flag** — that is the difference from
`allowOverlayOnGround`. An overlay on layer 0 at least draws something, so a caller can mean it;
a tile from an absent sheet can never draw anything, on any layer, for any caller.

Two things it deliberately does *not* check, and why:

- **Derived kinds.** `place_building` and `generate_town` compute a wall as `roofKind + 8`.
  A3 block rows alternate roof/wall, so a roof kind's paired wall is always on the same sheet as
  the roof — checking the roof covers it, and checking the derivation separately would only
  report the same missing sheet twice. The one case where the derivation leaves the families
  entirely (`roofKinds: [120]` on `generate_town`, deriving wall kind 128) was checked over MCP
  and is already refused by `planBuilding`: *"Wall kind 128 is outside the wall families — A3 is
  48-79 and A4 is 80-127."*
- **Read filters.** `decorate_dungeon` and `place_dungeon_stairs` take a `floorKind` to tell
  floor from wall in a map that already exists. Nothing is painted with it, so an absent sheet
  is not a defect there. Their prop placement was already safe: `collectProps` builds its
  catalogue from `tilesetNames` and so cannot offer a prop from a sheet the tileset lacks —
  the gap was only ever in the autotile kinds.

This also turned up the gap P5-40 closes: `generate_town` collected per-building refusals into a
`failures` list and reported the call as a **success** even at *"Buildings: 0 of 2 planned"*.
See [A town with no buildings in it](#a-town-with-no-buildings-in-it).

### A town with no buildings in it

`generate_town` places its buildings one at a time, catching each `BuildingPlacementError` into
a `failures` list so that one bad plot cannot lose the whole town. The cost of that was that a
run where **every** building was refused still reached the end, wrote the file and reported
itself a success. The count `Buildings: 0 of 2 planned` was the only trace, sitting in a result
that otherwise reads exactly like a working town — same streets line, same decoration line, same
closing advice to go and check the doors.

There are two ways to end with nothing, and they want different answers.

**Nothing was planned.** `planTown` warns and carries on when no band segment is wide enough for
`minBuildingWidth` plus its clearance. **Measured over 4356 accepted plans** (widths 17-60,
heights 13-45, 3 seeds each, at `TOWN_DEFAULTS`), the window where a plan is accepted and yields
no building is exactly three widths:

| width | plans yielding 0 buildings |
|---|---|
| 22 | 93 of 93 |
| 23 | 31 of 93 |
| 24 | 31 of 93 |
| 25-60 | 0 of 93 each |

Below 22, `planTown` already throws. So this is a narrow geometry window with a precise cause,
not a normal outcome — worth naming rather than warning about. For scale, the same 4356 plans
place a **median of 8 buildings and at most 25**, so zero is far outside anything an accepted
plan produces. (A separate 1980-plan sweep at coarser resolution found 420 refused outright by
`planTown` and 56 in this warn-only window — 2.8%.)

**Everything planned was refused.** The refusal texts are already good; the first one is the
whole story. That claim is structural rather than impressionistic: of the **8 sites that raise
`BuildingPlacementError`, 6 are argument-driven** — roof-choice arity, roof set against a non-
`Outside_C` C sheet, unknown set name, a nine-slice block wrapping the sheet's half-edge, missing
`wallKind`, and the wall/roof geometry raised through `BlueprintError`. The **2 plot-driven ones
cannot fire from `generate_town` at all**: footprints come from `planTown`, which only emits
rects inside the usable area, and the roof-over-empty-ground check cannot trip because the ground
layer is filled across the whole map before the first building goes down. Hence "these come from
the arguments rather than from the individual plots" in the refusal text, and hence quoting only
the first.

`assessTownBuild` in `src/core/towngen.ts` is the judgement, and the tool calls it **before the
props pass and before the only `writeJson`** — so a refusal leaves the map exactly as it was.
Verified over MCP: a map seeded with one tile and one event, then `roofKinds: [120]` on
`Dungeon` (deriving out-of-family wall kind 128), comes back refused with the marker tile and
marker event both still there. Before this it would have been 660 tiles of ground and the event
gone.

A partial loss is **not** a refusal — a town with 11 of 13 buildings is a town — but the count
moved onto the buildings line itself (`Buildings: 11 of 13 planned — 2 refused and lost`) rather
than living only in a block further down.

**Stated, not measured:** that zero is the right threshold. 1 of 13 buildings is also barely a
town, but any cut-off above zero is a number nothing in the corpus or the engine settles, and a
caller who asked for a small town on a cramped map has a legitimate reason to want the one
building that fitted.

**Honest limit on the verification:** the partial-placement path is unit-tested but was **not**
reproduced end to end. Several attempts to provoke one through ordinary arguments — narrow
buildings, tall wall heights, mixed roof kinds — all came back 10 of 10 or 18 of 18, which is the
same finding as the 6-of-8 count above from the other direction: through `generate_town`'s own
arguments the outcome is all-or-nothing.

### Somebody to talk to

`generate_town` built a complete and completely empty town: streets, buildings, working doors,
a tree line, props, and nobody. `populate_map` existed, but as a *second* pass over a finished
map — it read back something it had not built, told floor from wall by passage flags, and
recognised a door only by whether its sprite name began `!Door`. The planner knew all of it
outright.

So the placement moved into the plan. `planTownPeople` takes a `TownPlan` and returns the tiles
a townsperson may stand on — everything that is not a building footprint, a prop slot or a
door's approach — and the approach tiles as an explicit blocklist. `building.door.approach` was
already in the plan; nothing had ever read it.

**The count is flat, and that is the measured part.** The obvious design is a density: so many
people per hundred tiles. The corpus says no. Over the **26 populated maps of `Wicked Heart`**
(64 maps, 63 NPC events), the Pearson correlation between map area and NPC count is **r = 0.09**
— none at all. The two most crowded maps in the project are its *smallest*:

| map | NPCs | per 100 tiles |
|---|---|---|
| 17x13 | 7 | 3.17 |
| 17x13 | 7 | 3.17 |
| 30x20 | 6 | 1.00 |
| 40x20 | 4 | 0.50 |
| 40x30 | 4 | 0.33 |
| 18x60 | 3 | 0.28 |

Population tracks what a place *is*, not how big it is. So `npcCount` is a flat default of 6 —
inside the measured range (median 2 per populated map, max 7) and at its upper end, because a
town is the populated kind of map rather than the median one. A bigger town does not get more
people unless the caller says so.

**The sample corpus settles nothing here and is labelled as such:** `samplemaps` holds **4 NPC
events across all 293 maps**, because it is a folder of scenery templates. Every number above
comes from one project, `Wicked Heart`, and is that project's habit rather than a rule. The page
settings it does confirm agree with the 70 demo-project pages `npcgen.ts` was already built on:
**52 of 63 fixed movement** (`generate_town` defaults to fixed) and **45 of 63 Action Button**
(the trigger it uses).

**`planNpcPlacement` grew an `allow` option** rather than a second placement routine. The
subtlety is that it narrows only *which tiles are candidates* — the connectivity flood still
runs over the whole walkable map, because standing on an allowed tile can seal off a
disallowed one just as easily. Without that split, a town could wall off its own back alley
and pass its own check.

**Verified over MCP across 4 seeds and 4 map sizes** (30x24 to 50x38), 46 NPCs in 5 towns: **0
on a door tile or its approach, 0 standing under a roof or prop on an upper layer, 0 sharing a
tile.** On a fresh 44x34 town, `check_map_walkability` reports **1133 standable, all 1133 in one
connected area** — the townsfolk cost nothing, which is what the per-placement connectivity
check is for.

**What the render caught that the numbers did not.** The first populated render had a villager
standing on a rooftop. It was not a placement bug — the tile was open ground in the plan, and
the roof under his feet was left over from an *earlier* `generate_town` run on the same map.
`generate_town` says "The map is replaced — its existing tiles and events both go", and that is
only true of layer 0: roofs on layer 2, props on layer 1 and the shadow plane at z=4 all
survive a regeneration. The same map regenerated four times reports **1037 standable with a
7-tile pocket and 0 new shadows**, against **1133 standable, no pocket and 20 shadows** on a
fresh map with the identical seed and arguments — a 96-tile difference, all of it debris. Filed
as P5-41; it is a pre-existing bug this task only made visible.

**Still open here:** the dialogue is the same placeholder set `populate_map` uses, now shared
from `npcgen.ts` so the two agree. P5-12 is the task for making it worth the box it appears in.
And nothing yet distinguishes a townsperson on a street from one on the open ground between
buildings — neither corpus marks which tiles are road, so both are offered and the connectivity
check does the sorting.

### What the last generation left behind

Regenerating a map is the normal way to use a generator — try a seed, look at it, try another.
Three generators answered that three different ways, and only one of them was right:

| tool | events | layer 0 | layers 1-3 | shadow z=4 | region z=5 |
|---|---|---|---|---|---|
| `generate_interior` | cleared | cleared | cleared | cleared | cleared |
| `generate_map_layout` | kept, warned | rewritten | kept, warned | kept, **not counted** | kept, **not counted** |
| `generate_town` | cleared | rewritten | **kept, silently** | **kept, silently** | kept, silently |

`generate_town`'s own description said "the map is replaced — its existing tiles and events both
go". That was true of the events and of layer 0, and of nothing else.

**How much survives, measured.** A 44x34 town generated at seed 5, then regenerated at seed 9,
compared cell by cell against the same seed-9 town on a fresh map:

| plane | differing cells | only on the regenerated map |
|---|---|---|
| layer 0 | 0 | 0 |
| layer 1 (props) | 49 | 47 |
| layer 2 (roofs) | 76 | 76 |
| layer 3 | 0 | 0 |
| shadow z=4 | 16 | 16 |
| region z=5 | 0 | 0 |
| **total** | **141** | **139** |

**The two cells that differ without being extra are the sharp end of it.** Props are written
with `skipOccupied`, so a stale prop does not merely survive beside the new town — it **wins**.
At (12, 12) the regenerated map keeps tile 141 where the fresh town put 144, and at (20, 21)
tile 166 where the fresh town put 170. The debris is not additive; it displaces. The shadow plane
compounds it from the other side: `applyWallShadows` runs with `overwrite: false`, so a
regenerated town reported *"Shadows: 16"* against 20 on a fresh map — under-reporting because the
stale ones were already there.

`src/core/map-reset.ts` is now the one place that decides, and the decision is **not** the same
for all three, because their contracts are not the same:

- **`generate_town` clears everything by default.** Its description already promised that; the
  code now matches the promise rather than the promise matching the code. `keepExistingTiles`
  reaches the old behaviour for laying a town over hand-painted terrain, and then the result
  *says* what it kept, named by plane.
- **`generate_map_layout` keeps its default.** "Replaces the chosen layer" is an accurate
  contract, and a caller who painted terrain on another layer means to keep it. What it owed was
  an accurate account: its old tally walked z 0-3 only, so it silently omitted the shadow and
  region planes. It now uses the shared census, and gained `clearOtherLayers` for the
  regeneration case.
- **`generate_interior` is unchanged in behaviour**, and now routes its wipe through the shared
  `clearMap` so all three mean the same thing by it.

Naming the planes is the point of the report. "139 tiles" tells a caller nothing they can act
on; "76 on layer 2" tells them their roofs are stale.

**Verified over MCP against the task's own condition.** The same experiment after the change:
a map generated at seed 5 then regenerated at seed 9, against a fresh seed-9 map — **0 differing
cells of 8976, and the whole tile array identical**, with the 16 events matching on position,
sprite, page count and name. Shadows now report 20 on both. By PNG, a third generation over two
previous towns is indistinguishable from a fresh one (1112 standable, all 1112 in one connected
area), where the same run with `keepExistingTiles` shows white roof slabs with no walls under
them and a villager standing on one (1020 standable, one tile cut off).

**Still open here:** `decorate_dungeon`, `place_building` and the other additive tools are
untouched and should be — they add to a map by definition. But the same shape shows one level
down, measured while checking this: `decorate_dungeon` run **twice with the same seed** leaves
**16 events** where the caller asked for 8 each time — 12 torches and 4 chests, none sharing a
tile, because the second pass avoids what the first placed rather than recognising it. Seeded
reproducibility means a re-run should arguably be a no-op rather than a doubling.

**Deliberately not filed as a task**, and worth saying why, because the judgement is the useful
part: `decorate_dungeon` is additive by contract and says so in its own description, so "run it
twice, get twice the decoration" is defensible behaviour rather than a broken promise — which is
exactly what separates it from the `generate_town` case above. It is recorded here so that
whoever does decide to change it starts from the measurement instead of rediscovering it. The
same question applies to `populate_map` and `place_dungeon_stairs`, which were not measured.

### Somewhere to spend the money

`place_shop` needed a coordinate; `generate_town` built the buildings. Neither knew about the
other, so a generated town had no merchant unless someone worked out a tile by hand and called
the second tool against it. `planTownShop` closes that the same way `planTownPeople` did: the
planner already knows which building is which and, in `door.approach`, exactly which tile each
door is used from.

**The corpus cannot settle where a shopkeeper stands, and this is the clearest case yet of
saying so rather than dressing a guess as a measurement.** Every shop page on this machine — the
"4 shop pages" the shop module already flagged as a thin sample — turns out to be thinner still:
they are **4 pages of one event**, `EV003` on `Wicked Heart`'s Map013, and that map is an
**interior** called "Inn", 19x15 on the `Inside` tileset. The event carries **no sprite on any of
its 5 pages**; the visible character is a separate `Barkeeper` event one tile above it. So the
single data point is "an invisible trigger on a counter tile inside a building". The 293 sample
maps have no shop at all. Nothing there describes a merchant on a town street.

What the sample *does* confirm is the part that was the engine's anyway, and it agrees with what
`shopCommands` already emitted: Action Button, priority "same as characters", fixed movement, and
2 of the 4 pages are exactly `101, 401, 302, 605`.

So the two placement rules are **stated judgements**, labelled as such in the code:

- **Which building** — the one whose door is nearest the middle of the map, ties to the larger
  footprint then to position. A town's trade sits on its central street. It is deliberately not
  seeded: a shop is a fixed part of a map, the same reasoning `selectStock` gives for not
  randomising the shelf.
- **Where the keeper stands** — beside the door's approach tile, never on it. An NPC has priority
  "same as characters" and so occupies its tile; a keeper on the approach would block the door of
  the very shop it belongs to, and nothing would say why.

The keeper's tile is *offered*, not chosen. `planTownShop` returns candidates in preference order
and the tool runs them through `planNpcPlacement` with `count: 1`, so the shop inherits the same
connectivity guarantee as every villager — a keeper who would seal off an alley is refused, and
the tool says so. The shop is placed **before** the townsfolk, so its tile is already an event by
the time they are placed and none of them can take it.

**Verified over MCP.** One `generate_town` call on a 44x34 map, seed 5: keeper at (18, 19) beside
the door of the 7x4 building at (18, 15), stocked with 6 rows of real items from the project
database (Antidote, Potion, Encounter Decreaser, Dispel Herb, Super Potion, Magic Water — the
cheap half of `Items.json`, which is the default band). The written page is
`101, 401, 302, 605, 605, 605, 605, 605, 0` with the 302's own parameters carrying the first
goods row `[0, 13, 0, 0, false]` — kind 0 items, id 13, price type 0 meaning "whatever the
database says" — which is exactly how `Game_Interpreter.command302` and
`Window_ShopBuy.makeItemList` read it. The nearest door is at (19, 18) and **its approach tile
(19, 19) came back free of events**, so the shop's own door still opens. The keeper has 3
standable neighbours to be talked to from, and the map is 1133 standable in a single connected
area.

**Still open here:** the shop is at the door because there is no interior to put it in —
`generate_town` does not build interiors, which is P5-13. When it does, the honest thing is to
follow the one measured example and move the keeper inside, with the trigger on a counter tile.
The greeting is also still a canned line per preset; P5-12 covers dialogue worth reading.

### What the map points at

`database-refs.ts` covered the ten tables a command list can name. Three references live
*outside* it and were unchecked: the map a `transfer_player` names, the character sheet a page
image names, and a map's own `tilesetId`. P5-34 checks all three — and the interesting part is
that they do **not** all fail the way the database lookups do.

**Two of them crash the game outright.** Both reach the same throw:

```js
DataManager.checkError = function() { if (this._errors.length > 0) { ... throw ["LoadError", url, retry]; } }
ImageManager.isReady   = function() { ... if (bitmap.isError()) { this.throwLoadError(bitmap); } ... }
```

A `transfer_player` to a map with no file reserves the transfer, `DataManager.loadMapData`
requests `Map%03d.json`, the 404 lands in `DataManager._errors`, and the next `isMapLoaded()`
throws — the player gets the engine's error screen mid-transfer, on a black scene. A page image
naming a sheet that is not in `img/characters` is worse in reach if not in kind: `Bitmap._onError`
puts it in the `"error"` state and `Scene_Map` throws the moment it tests `isReady()`, so it is
not the event that breaks, it is **the whole map, on arrival, for every player**.

**One of them is silent**, and it is the guard-then-do-nothing shape again. A `tilesetId` past
the end of Tilesets.json makes `Game_Map.tileset()` undefined, and then:

```js
Game_Map.tilesetFlags     = function() { const t = this.tileset(); if (t) {...} else { return []; } }
Spriteset_Map.loadTileset = function() { this._tileset = $gameMap.tileset(); if (this._tileset) {...} }
```

`setBitmaps` is never called, so nothing is drawn; and `checkPassage` reads `flags[tile]` as
`undefined`, where `(undefined & bit) === 0` is true — the "[o] Passable" branch. **Every tile
becomes passable and invisible.** The map still "works". That asymmetry is asserted rather than
described: `tests/core/map-refs.test.ts` ports `checkPassage` and checks that an empty flag table
answers *passable* for all four direction bits, while the same tile with a real flag answers
*impassable*.

**Measured** with the new `scripts/measure-map-refs.mjs`:

| | 201s | designation 0 | targets that resolve |
|---|---|---|---|
| samplemaps (293 maps) | 658 | 658 | 658 |
| `Wicked Heart` (64 maps) | 108 | 108 | 108 |

| | pages with a sheet | distinct sheets | resolve on disk |
|---|---|---|---|
| samplemaps | 1716 | 14 | 14 of 14, against the RTP's 45 |
| `Wicked Heart` | 162 | 31 | 31 of 31, of its 88 |

Every `tilesetId` in all five projects on hand is a real row. So **a dangling reference of any of
these three kinds appears nowhere in 357 hand-made maps** — it is a shape only a generator
produces, which is why each is a refusal rather than a note.

The samplemaps transfer figure is the weaker of the two and is recorded as such: that folder is
several sample projects' maps merged into one numbering, so its targets land inside 1-293 partly
by construction. `Wicked Heart` is one real project and its 108 of 108 is the measurement that
carries the claim.

**A fourth check came free.** Once the target map is known to exist, its size is two numbers
away, and `Game_Player.performTransfer` calls `locate()` with no bounds check at all. Landing
outside the map leaves `Game_CharacterBase.canPass` returning false for every direction whose
neighbour fails `Game_Map.isValid` — off the map on more than one side, the player cannot move,
and nothing says why. That is refused too.

**One place decides, again.** A character sheet can be named by `create_event`, `update_event`,
`place_lever`, `place_locked_door`, `lock_dungeon_floor`, `place_building`, `decorate_dungeon`,
`place_shop`, `place_key_for_door` and `generate_town` — ten tools, of which only `create_npc`
and `populate_map` checked. `src/tools/map-ref-loaders.ts` is now the single loader they all go
through, the same move P5-26 made for ground materials. `generate_town`'s hardcoded `!Door1` is
checked as well, since a project without the RTP art would otherwise get a town whose every
doorway crashes the map. On the tileset side, `create_map` was rewritten to go through
`createMapFile` rather than duplicating it inline — without that it kept writing unchecked maps
after the check was added, which the stdio run caught.

**Out of reach, recorded rather than checked:** `battle_processing` designation. `command301`
reads `params[0]` as 0 direct, 1 troop from a variable, 2 same as random encounters, and
`convertCommand` hardcodes 0. That matches all 13 corpus 301s (11 on maps, 2 in common events,
none of either other kind), so nothing is broken today — designation 2 is what an
encounter-driven battle needs and belongs with the encounter work (P5-17), not here.
`transfer_player` designation 1 is the same story: 0 of 766 corpus transfers use it. Both are
now P5-35.

**What it will not do:** claim anything it could not read. An unlistable `img/characters`, an
unreadable `Tilesets.json`, a `data/` that will not enumerate — each degrades to *unchecked*, not
to *empty*, the same rule `loadDatabaseTables` follows. Only the maps a command list actually
transfers to are read for their size.

**Verified** by driving the real server over stdio against a scratch copy of `Learn`: a transfer
to map 42 refused naming `Map042.json` and listing the one map that exists; a transfer landing at
(300, 300) on a 17x13 map refused with the `isValid` reasoning; a transfer to (4, 4) on map 1
accepted; `create_event characterName: "NoSuchSheet"` refused; `characterName: "people1"` refused
*with the case hint*, since the name is a URL; `place_lever characterName: "!Switch9"` refused;
`create_map tilesetId: 99` and `update_map tilesetId: 0` both refused against a 6-tileset
project; `create_map tilesetId: 5` accepted. `generate_town` on the same copy still writes its 10
buildings with 10 door events, so the sheet check costs a working call nothing.

### Designation is a fork in the engine

Two commands carry a `params[0]` that decides whether the numbers after it are *values* or
*variable ids*, and `convertCommand` hardcoded 0 on both — so half of each command was
unreachable:

```js
command301: if (params[0] === 0) { troopId = params[1]; }
            else if (params[0] === 1) { troopId = $gameVariables.value(params[1]); }
            else { troopId = $gamePlayer.makeEncounterTroopId(); }

command201: if (params[0] === 0) { mapId = params[1]; x = params[2]; y = params[3]; }
            else { mapId = $gameVariables.value(params[1]); x = ...; y = ...; }
```

The transfer fork is the one worth pointing at: **one flag covers all three numbers.** There is
no mixed mode where the map is literal and the coordinates come from variables, so a partial set
is refused rather than quietly promoted — the two missing numbers would be read as variable ids
either way.

**The corpus settles nothing here, and says so loudly.** Swept across every project on this
machine — 44 data directories, including the 293 sample maps, the `newdata` reference project,
everything under `M:/Projects/RPGMZ`, and the VisuMZ sample — there are **926 maps, and not one
uses designation 1 or 2**: all 13 `battle_processing` commands and all 766 `transfer_player`
commands are designation 0. So the semantics come from the engine, exactly as they did for the
region plane.

**Designation 2 has a silent failure mode, and it is the default state of every map that
exists.** `makeEncounterTroopId` returns 0 when nothing survives its filters, and 0 lands in
`command301`'s `if ($dataTroops[troopId])`, which is null at index 0 — P5-33's failure again: no
battle, no `setEventCallback`, and every win/escape/lose arm skipped, with nothing reported.

```js
makeEncounterTroopId: for (const e of $gameMap.encounterList()) {
                        if (this.meetsEncounterConditions(e)) { list.push(e); weightSum += e.weight; }
                      }
                      if (weightSum > 0) { ...pick one... }
                      return 0;
meetsEncounterConditions: e.regionSet.length === 0 || e.regionSet.includes(this.regionId())
```

Measured with the new `scripts/measure-encounters.mjs`: **all 926 maps ship
`encounterList: []`**, and every one ships `encounterStep: 30`, the editor default. Exactly **1
of the 361 maps in the seven named projects paints a single region tile.** So a "same as random
encounters" battle written today would do nothing, on every map on disk. That is why
`checkEncounterSource` refuses rather than warns, and the refusal names the three ways a table
can be unusable: empty, every row weight 0 (`weightSum > 0` guards the pick), or every row gated
on a `regionSet` the map never paints.

That last one is the P5-02 region plane finally load-bearing: `paint_regions` writes the plane
`meetsEncounterConditions` matches against, and the refusal says so. Verified over stdio — the
same command was refused, then accepted with *"3 of 3 row(s) can be picked"* after one
`paint_regions` call put region 7 on the ground.

A row naming a troop that is not in Troops.json is **warned about, not refused**: it fails only
when the weighted roll lands on it, so the battle happens most times and vanishes occasionally,
which is worse to diagnose than never — but it is the *map's* data rather than this command's,
and refusing a battle over it would be over-reach.

**The checks from P5-33 and P5-34 had to learn about designation**, and this is the part that
would have rotted quietly. `database-refs.ts` was checking `troopId` with a fallback of 1, so a
variable-driven battle would have "passed" a check that read a number the engine never looks at;
it now skips the check and says it is skipping it. `map-refs.ts` was collecting transfer targets
by reading `mapId`, so a dynamic transfer would have been checked against map 1. Both now call
`battleDesignationOf` / `transferDesignationOf`, so one module decides.

`describe_event` had the same bug in reverse: it read `params[1]` as a troop id whatever the
designation, so a designation-2 battle read back as *"Battle Processing: troop 1"* — a troop the
event never mentions. It now names the source. `collectReferences` likewise now counts the troop
variable and a dynamic transfer's three variables as reads, which they are and nothing else in
the list mentions.

**Variable names work here the way P5-03 made them work elsewhere.** `troopVariableName`,
`mapVariableName`, `xVariableName` and `yVariableName` allocate or reuse exactly as `switchName`
does — and a variable holding a return destination is precisely the kind a real project names.
The name-key list moved behind `usesFlagName` so the tool no longer restates it; adding a key
used to mean remembering to widen a condition in `add_event_commands` as well.

**Still open:** nothing in the server writes `encounterList`. Until it does, designation 2 is
reachable only on a map whose encounters were set in the editor — which is the honest position,
and the refusal says as much. That belongs with the encounter work (P5-17), where the table is
the feature rather than a precondition.

**Verified** by driving the real server over stdio against a scratch copy of `Learn` and reading
the JSON back: `301 [2,1,true,true]` with 601/603/604 arms at the right indents, `301 [1,1,...]`
pointing at the variable allocated as "Ambush troop", and `201 [1,2,3,4,8,1]` with the three
destination variables allocated as "Return map"/"Return X"/"Return Y" and direction and fade
still in `params[4]`/`params[5]`. Two sources on one battle refused naming both; a lone
`mapVariableId` refused naming the two it was missing.

### Weight means nothing on its own

`set_map_encounters` fills the other half of designation 2: the map's own `encounterList` and
`encounterStep`. The engine path is small enough to quote whole, and every refusal below points
at one line of it:

```js
makeEncounterCount:       const n = $gameMap.encounterStep();
                          this._encounterCount = Math.randomInt(n) + Math.randomInt(n) + 1;
makeEncounterTroopId:     for (const e of $gameMap.encounterList())
                            if (this.meetsEncounterConditions(e)) { list.push(e); weightSum += e.weight; }
                          if (weightSum > 0) { let v = Math.randomInt(weightSum);
                            for (const e of list) { v -= e.weight; if (v < 0) return e.troopId; } }
                          return 0;
meetsEncounterConditions: e.regionSet.length === 0 || e.regionSet.includes(this.regionId())
executeEncounter:         if ($dataTroops[troopId]) { BattleManager.setup(troopId, true, false); ... }
encounterProgressValue:   let value = $gameMap.isBush(this.x, this.y) ? 2 : 1;
```

**The corpus has nothing to copy, and this time the sweep was total.**
`scripts/measure-troops.mjs` walks every `data/` directory on this machine — the 293 sample
maps, the reference `newdata`, all three `newdata-N` variants and their eleven language
subtrees, the eighteen `resource/patch/stepN` sets, both DLC projects, and all of the user's own
work. That is **64 data directories and 1219 maps, of which 0 carry a single `encounterList`
row.** `encounterStep` is 30 on 1217 of them and 31 on exactly two — `samplemaps/Map212` and
`newdata-2/Map108` — and *both of those still have an empty list*, so the field has been nudged
on this machine and never once paired with a table. There is therefore no measured convention
for row counts, idiomatic weights, or whether a zone should be a region or the whole map, and
`src/core/encounters.ts` invents none. It writes what the caller asks for, refuses what the
engine cannot use, and reports the resulting odds so the caller can judge.

**Weight is not a percentage, and a single number per row would be a lie.** `regionSet` filters
the list *before* `weightSum` is computed, and the filter runs against the region under the
**player**, so the denominator changes as they walk. A row scoped to region 1 does not get its
weight share inside region 1 — it competes there with every empty-`regionSet` row as well. Two
rows, weight 5 everywhere and weight 3 in region 1, come out as:

```
  unpainted      331 tile(s)   troop 1 "Rat1" 100.0%
  region 1        24 tile(s)   troop 1 "Rat1" 62.5%, troop 7 "Crab2" 37.5%
```

So the tool reports **one probability table per zone** — each region id the player can reach,
plus id 0 for bare ground — rather than one percentage per row. That is what "what weights mean
next to each other" turned out to mean, and it is not visible from the row list.

`regionSet: [0]` is a real and different thing from an empty `regionSet`: `regionId()` returns 0
on unpainted ground, so `[0]` means *only* off the marked areas, where `[]` means everywhere
including them. Engine-derived; nothing on disk uses either.

**Three refusals, each naming the guard it saves you from.**

- **An empty troop.** `executeEncounter` guards on `$dataTroops[troopId]`, which is truthy for a
  row with no members; `Game_Unit.isAllDead()` is then true on the first frame and
  `checkBattleEnd` goes straight to `processVictory()` — a victory fanfare for walking. This is
  not a rare shape: of **459 troop rows across the 20 Troops.json files on this machine, only
  173 (37.7%) have a single member.** 286 are slots the editor allocated and nobody filled, and
  in `Wicked Heart` it is 87 of 100. On a table picked by weight that is an *intermittent*
  failure, which is worse to diagnose than a constant one, so it is refused rather than noted.
  Naming works as a handle here: 183 rows carry a name and **all 173 filled rows are among
  them**, so `troopName` can reach every troop that belongs in a table.
- **A region the player can never be standing on.** This is the half a tile view cannot show.
  `meetsEncounterConditions` tests `this.regionId()` — the id under the player — so a region
  painted on walls, or on floor walled off from where the player starts, gates a row exactly as
  hard as a region that was never painted. `encounters.ts` therefore floods the map with the
  same reachability rule `check_map_walkability` uses before accepting a scoped row. Measured on
  `Wicked Heart` map 8: 465 standable tiles of 800, a main area of 355, and two islands of 104
  and 4. A 3x3 region painted into the 104-tile island reports `9 tile(s), 0 of them reachable`
  and the row is refused; pass `startX/startY` inside that island and the same region becomes 6
  reachable tiles (9 painted, 3 of them impassable — `paint_regions` and `set_map_encounters`
  agree on the arithmetic) and the row is accepted.
- **A table that can never produce a pick.** All weights 0 falls through `if (weightSum > 0)` to
  `return 0` forever; a negative weight both understates the sum and makes its own row
  unpickable, since `v -= weight` moves `v` the wrong way. `encounterStep < 1` is the same class:
  `Math.randomInt(0)` is 0, so the count is `0 + 0 + 1` and an encounter fires on every step.

**What the report says about pacing** comes straight from `makeEncounterCount`: the count is
`randomInt(n) + randomInt(n) + 1`, so steps between encounters run **1 to 2n-1 and average
exactly n** — a triangular distribution, not a flat one. `encounterProgressValue` returns 2 on a
bush tile, so tall grass halves the interval. Both are stated in the tool's own output because
neither is guessable from the number 30.

**`checkEncounterSource` now leans on the same reachability rule.** P5-35 built it against the
set of *painted* region ids; that was the weaker half of the same question, and it is now given
the set of ids with at least one reachable tile (`reachableRegions` in `event-tools.ts`, over
`surveyEncounterRegions`). Driven over stdio MCP against `Wicked Heart` map 8, the chain now
runs: `add_event_commands` with `sameAsRandomEncounter` on an empty table is refused and points
at `set_map_encounters`; with a table scoped only to the walled-off island it is refused again
and points at `paint_regions`; with an everywhere-row added it is accepted, and reports
`1 of 2 row(s) on map 8 can be picked, every 30 steps`.

`reachableGrid` was split out of `analyseWalkability` for this, so the encounter check and the
walkability report cannot disagree about which area is the player's.

**Still open.** ~~`checkEncounterSource` has no way to be told where the player arrives, so it
assumes the largest walkable area.~~ *Fixed by P5-38* — see
[The largest area is not where the player is](#the-largest-area-is-not-where-the-player-is).
Nothing here chooses *which* troop suits a floor's depth; total member exp is derivable
(`newdata` runs 20, 20, 30, 30, 100 across its five troops) but the ordering is P5-17's to make.

### The largest area is not where the player is

Every reachability question in the repo so far has answered "where is the player" with "the
biggest connected blob". `analyseWalkability` has always said in its own documentation that this
is wrong on an interior — a room's wall tops are passable *along themselves* in the RTP tilesets,
so the ring around a room out-numbers the room. That was an argument. `scripts/measure-arrival.mjs`
makes it a count, over the **677 maps whose tileset carries real passage flags**:

- **619 of 677 (91.4%) have more than one walkable area.** "Largest" is a real choice on almost
  every map, not a formality.
- **159 maps are transferred into, carrying 394 arrival points** — 2.5 per map, which is why
  `surveyArrival` takes a list and unions the result instead of picking one.
- **36 of those 394 (9.1%), on 20 maps, land outside the largest area.** And when the guess is
  wrong it is not wrong by a little: `Wicked Heart` map 25 has a largest area of 627 tiles
  against 65 reachable from where the player lands; map 59 is 516 against 11; map 19 is 142
  against 24.
- **24 of the 394 land on a tile the player cannot stand on at all.** Those contribute nothing
  rather than dragging a whole area in. (Refusing them outright is P5-36.)
- **Events are not a usable stand-in.** Of 2031 events, 1278 sit outside the largest area and
  **992 of those stand on an impassable tile**, because doors, signs and clutter are events too.
  142 maps have no event in their largest area at all. The cheap local signal is the wrong one.

**What the engine says.** `Game_Interpreter.command201` is the only route on to a map besides the
new game position:

```js
command201: if (params[0] === 0) { mapId = params[1]; x = params[2]; y = params[3]; }
            $gamePlayer.reserveTransfer(mapId, x, y, params[4], params[5]);
```

so a literal transfer names the exact tile, and `DataManager.setupNewGame` uses `System.json`'s
`startMapId` / `startX` / `startY` for the first one. `src/core/arrival.ts` collects both,
`reachableFromAny` in `walkability.ts` unions the areas they land in from a single area survey,
and `surveyArrival` reports what it assumed. `add_event_commands`, `set_map_encounters` and
`get_map_encounters` all take `startX`/`startY` to override it, and all three print the arrival
line, so a refusal always says where its belief came from.

**Two limits, stated because nothing on disk settles them.** A transfer at designation 1 reads
its destination from variables and cannot be resolved from a file — 0 of the 766 transfers
measured in P5-35 use it, so nothing is missed today. And vehicles move the player without a
transfer: `Game_Player.getOffVehicle` can set them down on a shore no `command201` names. A
derived arrival is a strong default, not a proof.

**The two checks now agree.** That was the point of the task. Driven over stdio MCP against
`Wicked Heart` map 8, with region 9 painted into the 104-tile area walled off from the main one
and both calls given `startX: 27, startY: 1`: `set_map_encounters` reports `region 9 — 6
tile(s) — Rat1 71.4%, Crab2 28.6%`, and `add_event_commands` reports `2 of 2 row(s) can be
picked`. Before this, the battle side used the largest area, said `1 of 2`, and warned about a
region that was perfectly reachable from where the player really was.

**What the sweep turned up in the user's own project.** Map 32 of `Wicked Heart` carries
`201 [0,59,0,49,0,0]` — a transfer to map 59 at (0, 49). That tile is passable down, left and
up but **not right**, so `Game_CharacterBase.canPass` blocks every attempt to leave column 0 and
the player can walk 11 tiles of a 13x50 map. The derivation is right and the map is wrong. This
is a class P5-36 does not cover: it checks that a landing square is *inside* the target map, and
P5-36 will add that it can be *stood on*, but neither catches a tile you can stand on and never
leave. Added as P5-39.

Because that failure mode is real, `describeArrival` warns when a **derived** arrival reaches
less than half the largest area, naming both numbers and pointing at `check_map_walkability`. A
start the caller *gave* gets the comparison without the diagnosis — they chose the tile, so a
small area is a decision rather than a symptom. The half is **stated, not measured**: nothing on
disk settles where the line goes, and it is set where it catches 11-of-516 rather than where it
splits hairs.

One cost worth naming: `loadArrivalPoints` reads every map in the project, because a transfer
*into* a map lives on whichever other map holds the door and there is no index of them. Measured
at 14 ms for `Wicked Heart`'s 64 maps and 147 ms for the 293 sample maps, so `add_event_commands`
derives only when a `sameAsRandomEncounter` battle is actually present.

### A landing tile you can stand on and never leave

P5-38 derived where a map's arrivals land; the section above found one, `Wicked Heart` map 59's
(0, 49), that reaches only 11 of the map's 516 reachable tiles. That is a third failure class
alongside P5-34 (off the map) and P5-36 (on a wall): a tile that is inside the map and standable,
and still strands the player, because `Game_CharacterBase.canPass` blocks the one direction that
would let them leave the pocket.

**The check.** `reachableFromLanding` in `walkability.ts` is the same flood `analyseWalkability`
already runs, reduced to the two numbers this needs: how big the area under the landing tile is,
against how big the map's largest connected area is. `requireTransferTarget` in `map-refs.ts`
refuses when the ratio falls under `TRAPPED_LANDING_RATIO`, naming both tile counts. A landing
tile that is not standable at all is a different failure, P5-36's — see the next section.

**Where the threshold comes from — measured, not stated.** P5-38 found 36 arrivals across the
corpus that land outside a map's largest area; this task's whole premise depends on where those
36 actually land, so `scripts/measure-arrival.mjs`'s `reachableDelta` was widened into a full
calibration pass over all of them (44 data directories: `Wicked Heart` and its two mirrors, the
`VisuMZ` sample project, and the RTP/DLC demo projects). Deduplicated to 19 distinct
(map, landing tile) pairs, the reachable-to-largest ratio splits into two clusters with nothing
between them:

| cluster | ratio range | example |
|---|---|---|
| trapped | 0.4% – 16.9% | `Wicked Heart` map 59 (0, 49): 11 of 516 (2.1%); a `VisuMZ` demo map lands 8 arrivals at 21-60 of 4717 (0.4-1.3%) |
| fine | 66.7% – 96.9% | `Wicked Heart` map 22 (15, 4): 54 of 81 (66.7%) — a smaller wing of the same building, not a pocket |

The highest trapped ratio (16.9%, map 19's (3, 0), reaching 24 of 142) sits **4x** below the
lowest fine one (66.7%). `TRAPPED_LANDING_RATIO = 0.25` sits in that gap rather than on either
cluster — the corpus does not say exactly where the line belongs, only that nothing on disk falls
between 17% and 67%, so 25% is a round number inside the silence rather than a measurement of it.

**Refusal, not a warning**, matching the two sibling checks already in `requireTransferTarget`
(missing map, off-map landing) rather than the softer note `add_event_commands` uses for a
designation-1 transfer it cannot resolve at all — the difference is that here the server can
compute the answer, and the codebase's rule is to refuse rather than let a caller write something
broken.

**Loading it.** `loadMapReach` in `map-ref-loaders.ts` reads the target map's JSON and its
tileset's flags — one more step than `loadMapSizes` needs, and one more way to fail, so it
degrades to "unchecked" the same way: an unreadable map or an unresolvable `tilesetId` leaves the
target out of `mapReach` rather than raising. `loadTransferInventory` now loads sizes and reach
data for the same target list in parallel.

**Verified end to end.** A 10x6 map with a 16-tile room and a 3-tile pocket (18.8% of the room,
below the line) was written to disk with real `Map002.json` and `Tilesets.json` files, and
`loadTransferInventory` + `checkMapRefs` run against them from the built `dist/` — not a
hand-built `MapRefInventory` — refused the pocket landing and accepted the room one, confirming
the loader's file reads and the core check agree the way they do in the unit tests.

### A landing tile you cannot stand on at all

P5-34 checks the landing square is *inside* the target map, using only its width and height. This
is the other half of the same idea, and the one that needed the tileset resolved rather than just
the map's dimensions: `locate()` has no passability check, so a tile impassable from every
direction freezes the player exactly as if they had landed off the map — the failure P5-34 already
catches — except this time the tile is sitting inside the map's bounds where that check cannot see
it.

**No new reasoning.** `check_map_walkability` already ports the rule: `readTile(...).isWall` is
true when a tile's passage flags block all four directions, and `reachableFromLanding`'s
`standable` field is exactly `!isWall`. P5-39's work already computes it for every checked
landing, so this is a second branch in `requireWalkableLanding`, not a second flood.

**Measured, in P5-38's arrival sweep**, not newly for this task: of the 394 arrival points found
across every project on this machine, **24 (6.1%) land on a tile the player cannot stand on**. Not
a hypothetical shape.

**Ordering matters.** The bounds check (P5-34, against `mapSizes`) runs first and can throw before
`requireWalkableLanding` is even called; this check runs second, against `mapReach`, and only after
confirming the point is inside the target map using `entry.map`'s own width and height — so an
off-map point that `mapSizes` did not catch (because only `mapReach` was available) is left
unclaimed here too, rather than being misreported as "on a wall". The pocket check from the section
above runs third, on the same `reachableFromLanding` result, so a caller gets at most one of the
three transfer refusals per command, in the order the engine would actually hit them: LoadError,
frozen on arrival, stranded in a corner.

**Verified end to end**, the same way as the section above: a 10x6 room written to real
`Map002.json` / `Tilesets.json` files, read back through `loadTransferInventory` and `checkMapRefs`
from the built `dist/`. A landing on the open floor was accepted; a landing on the wall corner
(0, 0) was refused, naming `canPass` and "frozen in place".

### Making a page respond to a flag

P5-03's own measurement is what set this task up and then left it undone: **switch page
conditions are the single most common way real event logic gates itself** — 62 uses in
`Wicked Heart`, more than Control Switches (43) and conditional branches (23) combined — and
until now nothing wrote one. `create_event`/`update_event` never touched `page.conditions` at all;
only the three generators that build their own pages (`lever.ts`, `locked-door.ts`, `vault.ts`)
ever set one, and each of those sets exactly one kind (`switch1` or self-switch). A caller could
allocate a switch and flip it, but nothing they built could ever notice.

**The engine's shape**, from `Game_Event.prototype.meetsConditions` (byte-identical between
corescript v1.4.4 and v1.9.0, so this is stable across every version on disk): six independent
kinds, each `*Valid` flag gating one check, all ANDed together with no bailout for "nothing set" —
it falls through every `if` and returns `true`. `switch1` and `switch2` are two separate switches,
not a range; `variable` compares `>=`, not `==`; `selfSwitchCh` is a literal `'A'|'B'|'C'|'D'` with
no allocation, since `Game_SelfSwitches` is a plain dictionary; `item`/`actor` read straight into a
truthiness/membership check with no guard of their own.

**Two different failure classes, so two different modules check them.** `switch1`/`switch2`/
`variable` name a *flag* — the same allocation `resolveCommandFlags` already runs for a command
list, so `resolvePageConditions` in `command-flags.ts` reuses `resolveOne` directly rather than
duplicating it. `item`/`actor` name a *database row* — the same guard-then-do-nothing shape
`checkDatabaseRefs` already catches for other commands, so `requirePageConditionRefs` in
`database-refs.ts` reuses `exists`/`rowCount`/`highestId`. Neither function is a drop-in for the
other's job: a page's `conditions` object has no `type` field to dispatch `NAME_KEYS` on, and it is
not a command list `checkDatabaseRefs` can walk — both needed a small resolver of their own rather
than a new entry in an existing one.

**Full replace, not a merge.** `resolvePageConditions` always returns the complete 13-field shape
`meetsConditions` reads — every kind the caller did not name comes back at `blankConditions()`'s
defaults (`*Id: 1`, every `*Valid: false`). A caller clearing a page's conditions later passes
`conditions: {}` rather than needing a second "unset" argument.

**The tool surface had to grow past "one page" to be worth having.** `findProperPageIndex` scans
an event's pages *backwards* and takes the first whose conditions hold — so a conditioned page has
to sit *after* its unconditioned fallback, exactly the two-page shape `lever.ts` and
`locked-door.ts` already build for themselves. `update_event` only ever touched `pages[0]` and
could not add a page at all; a caller could set conditions on an event's only page (which is a
real, useful shape — "this event does not exist until flagged") but could never build the more
common gate-a-*second*-page pattern. `update_event` now takes `pageIndex`, defaulting to 0 and
accepted up to `pages.length` — equal to the count appends a new page (cloned via
`defaultEventPage()`), anything higher is refused for skipping ahead of a dense array. Once
`pageIndex` existed as a targeting mechanism, `characterName`/`characterIndex` (previously
hardcoded to `pages[0]`) and a new `trigger` param were routed through it too — leaving them
pinned to page 0 while conditions could target any page would have made the appended page
unable to look or behave differently from the one it is meant to override.

**What it refuses, each naming what was wrong:** the same flag-naming refusals P5-03 already
covers (an id already carrying a different name, a range mismatch — n/a here since a condition
names exactly one flag) apply through the shared `resolveOne`; a `pageIndex` past the next addable
slot; an `itemId`/`actorId` not in Items.json/Actors.json, with the message naming the row count
and explaining the *silent* failure (`Game_Event.meetsConditions` does not throw — it just makes
the condition permanently false, which for a single-page event looks exactly like an event that
does not exist); and an unnamed switch/variable id past the end of System.json's array, the same
`isUsableId` warning `add_event_commands` already gives, checked only when a name was actually
used and System.json was therefore already read — an id-only caller with no System.json on disk is
unaffected, the same degrade-to-unchecked rule this whole area follows.

**`describe_event` needed no changes.** `describePageConditions` in `event-flow.ts` already
rendered all six condition kinds in plain English — nothing in this task touched it, and `describe_
event`/`describe_map_events` picked up every new field for free.

**Verified end to end**, driven over stdio MCP against a scratch project: `create_event` with
`switch1Name: "Bridge repaired"` allocated switch 1 and reported it; a second event's
`update_event` with `pageIndex: 1` appended a page, *reused* switch 1 for the same name rather than
allocating a second one, and added a self-switch condition; `describe_event` on both events showed
`switch 1 is ON` and `switch 1 is ON AND self-switch A is ON` respectively; and `itemId: 999`
against a fixture with one item row was refused, naming Items.json and "permanently false" rather
than crashing or silently writing a dead condition.

**Not measured, stated instead:** whether item/actor page conditions are common in real projects.
`scripts/measure-flag-usage.mjs`'s existing counter folds `switch1`/`switch2` together and does not
count `itemValid`/`actorValid` at all, so unlike the switch/variable numbers above, "item and actor
conditions are checked the same way" is an application of the codebase's established
guard-then-do-nothing pattern to a new field, not a count-backed claim about how often either kind
is used in the wild.

### Every control_variables operand gets its own field

P5-03's "still open" list named this one directly: `convertCommand` emitted five `params` for
every `control_variables`, regardless of `operand` (`params[3]`). That is exactly right for
operand 0 (Constant), which reads one value from `params[4]` — and silently wrong for the other
four, which `command122` reads differently:

```js
switch (operand) {
  case 0: value = params[4]; break;                                   // Constant
  case 1: value = $gameVariables.value(params[4]); break;             // Variable
  case 2: value = params[4]; randomMax = params[5] - params[4] + 1;   // Random
          randomMax = Math.max(randomMax, 1); break;
  case 3: value = this.gameDataOperand(params[4], params[5], params[6]); break; // Game Data
  case 4: value = eval(params[4]); break;                             // Script
}
```

Random (operand 2) is the one P5-03 measured and named: with only `params[4]` emitted,
`randomMax = undefined - value + 1` is `NaN`, and every variable in the range is set to `NaN`.
Game Data (operand 3) reads three params, not one — `params[6]` was never emitted at all, so
`gameDataOperand`'s third argument was always `undefined`. Script (operand 4) happened to work by
accident, since `eval(params[4])` on whatever `value` held would at least run, if not usefully.
Variable (operand 1) also happened to work by accident — `$gameVariables.value(value)` reads
`value` as if it were meant to be the source variable's id, which is what a caller relying on the
old single-field shape would have had to know without being told.

**The fix gives each operand its own field(s)**, in `controlVariableOperand`
(`src/schemas/event.ts`), and refuses — by name, citing the exact engine computation — when a
required one is missing, rather than emitting a `params` array `command122` reads as a silently
wrong value:

| operand | fields | params\[4..] |
|---|---|---|
| 0 Constant | `value` | `[value]` |
| 1 Variable | `sourceVariableId` | `[sourceVariableId]` |
| 2 Random | `value` (low), `randomMax` (high) | `[value, randomMax]` |
| 3 Game Data | `gameDataType`, `gameDataParam1`/`gameDataParam2` (default 0) | `[type, param1, param2]` |
| 4 Script | `script` (non-empty string) | `[script]` |

`gameDataType`'s nine values (0 item … 8 last action) and what `gameDataParam1`/`gameDataParam2`
mean for each are `Game_Interpreter.prototype.gameDataOperand`'s own nested switch — documented in
the refusal message and the tool description, not re-validated field by field. An operand outside
0-4 is refused too: the engine's `value` stays at its initial `0` for an unmatched case, which is a
silent wrong answer of a different kind (0, not NaN) that nothing at runtime would explain.

**Measured: nothing on disk uses operand 1, 2, 3 or 4 today.** `Wicked Heart`'s 2 `control_variables`
commands (from `scripts/measure-flag-usage.mjs`, cited in
[Naming a flag in a command list](#naming-a-flag-in-a-command-list)) are the only ones anywhere on
this machine, and their operand was never separately counted — this fix closes a bug the corpus
cannot confirm was ever hit, the same shape as the conditional-branch fix P5-03 already made in the
same converter. `startId`/`endId` and `operationType` are untouched; only what fills `params[4]`
onward changed.

**Verified** by driving the real server over stdio MCP against a scratch project: a Random
assignment (`value: 1, randomMax: 6`) wrote `[1,1,0,2,1,6]` — six parameters, both range ends
present, `randomMax` computed as `6` rather than `NaN`; a Game Data assignment
(`gameDataType: 7, gameDataParam1: 2` — Other, Gold) wrote `[2,2,0,3,7,2,0]`; a Script assignment
wrote `[3,3,0,4,"$gameParty.gold()"]`; and the same Random command with `randomMax` left off was
refused before anything was written, naming the exact computation that would have gone `NaN`.

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
- ~~`autotileKind`'s description says "columns 1-4 are patch materials with visible outlines".
  Column 4 is the first *overlay* material, so a caller following the description lands
  directly in finding 1.~~ *Fixed:* see
  [A2 columns predict nothing](#a2-columns-predict-nothing). The claim turned out to be wrong
  in a bigger way than "off by one".
- ~~The shadow (z=4) plane has no tool at all.~~ *Fixed:* `apply_wall_shadows`, and
  `place_building` runs it. ~~The region plane (z=5) still has none.~~ *Fixed:*
  `paint_regions` — see [The region plane](#the-region-plane--the-sixth-layer).
- A1 (water, waterfalls) is not supported, so a generated map can have no water.

### Still open

- **Everything the generators emit is a rectangle.** Finding 7 is the one that has not moved:
  roofs have no L-shapes, an interior room is a single box, and a town's streets are straight
  and its plots a grid. Hand-made maps have almost no straight material boundaries.
- **Game logic is started but thin.** Shops exist, chests hold real varied rewards, switches
  can be allocated by name, and a door can be locked behind either a key or a flag — see
  [Commerce and loot](#commerce-and-loot), [Switches and variables](#switches-and-variables)
  and [Locked doors](#locked-doors); [Quests](#quests--joining-the-pieces-up) joins a key to
  the door it opens with a graph walk that refuses to make the game unwinnable, and
  [Levers](#levers--the-thing-that-sets-a-switch) does the same for the flag side. What is
  still missing is everything past *one* opener and *one* door: nothing chains two steps
  together, nothing tracks a quest's state as a whole, and no puzzle needs two flags at once.
  Gated NPCs, enemies and NPCs who say more than one placeholder line are all still absent too.
  [Locking a generated floor](#locking-a-generated-floor) is the first tool that places a quest
  without being told where — but it locks a door and leaves the far side empty, so what is
  behind the lock is a chest with better loot in it — see
  [What is behind the door](#what-is-behind-the-door) — rather than a reason the door was
  locked.

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

That no longer means opening the editor. `scripts/render-map.mjs` ports `Tilemap`'s drawing
from `rmmz_core.js` and turns any map file into a PNG, which closes the loop: generate, render,
look, change something, render again. Every finding above came out of that loop, and several of
them (the transparent-material holes especially) are invisible in a text grid.

**Pick the test material carefully.** The first visual check used A2 kind 16 — column 0 of
`Outside_A2`, the plain seamless Meadow fill. Its edge pieces are drawn identically to its
middle, so the render could not have revealed an error either way. Use an **opaque, outlined**
material instead; in `Outside_A2` that is kinds 17, 18 and 19 (Dirt, Road, Cobblestones A).
Do not generalise that to a column rule — see
[A2 columns predict nothing](#a2-columns-predict-nothing) — ask
`describe_tileset_materials` on any other tileset. A control shape placed away from the map
border, next to one touching it, makes border behaviour a direct comparison rather than a
judgement call.

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
