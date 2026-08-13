# 🎮 RPG Maker MZ MCP Server

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js)](https://nodejs.org)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.26.0-orange)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/Tests-534%20passed-brightgreen)]()

**English** | [繁體中文](#繁體中文) | [日本語](#日本語)

A **stable, well-tested** [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants like Claude create and edit [RPG Maker MZ](https://www.rpgmakerweb.com/products/rpg-maker-mz) projects through natural language.

> **Why another one?** Existing RPG Maker MZ MCP servers on GitHub suffer from critical issues — stdout pollution breaking the MCP protocol, wrong file extensions, no atomic writes, no tests, and outdated SDKs. This project was built from scratch to fix all of them.

---

## ✨ Features

| Feature | This Project | Others |
|---------|:---:|:---:|
| Atomic file writes (`.tmp` → `rename`) | ✅ | ❌ |
| Auto `.bak` backup before every write | ✅ | ❌ |
| Zod schema validation on reads | ✅ | ❌ |
| stderr-only logging (no stdout pollution) | ✅ | ❌ |
| Correct `.rmmzproject` extension | ✅ | ❌ |
| Generic `DatabaseManager<T>` (no copy-paste) | ✅ | ❌ |
| Unit & integration tests (534 tests) | ✅ | ❌ |
| MCP SDK v1.26+ | ✅ | ❌ |
| Event editing with human-readable commands | ✅ | Partial |
| AI scenario generation tools | ✅ | ❌ |

---

> **This is a fork** of [a951753abc/rpgmaker-mz-mcp](https://github.com/a951753abc/rpgmaker-mz-mcp),
> extended with map/project *understanding* tools on top of the original's data editing.
> See [ROADMAP.md](ROADMAP.md) for what's planned. Licensed GPL-3.0, same as upstream.

---

## 🛠 Available Tools (54 total)

### Project Management (4)
| Tool | Description |
|------|-------------|
| `load_project` | Load an existing RPG Maker MZ project |
| `create_project` | Create a new project with all default data files |
| `get_project_info` | Get project stats (maps, actors, items, etc.) |
| `list_resources` | List images and audio files in the project |

### Database CRUD (6 tools × 8 entity types)
Unified tools that work with **actors, classes, skills, items, weapons, armors, enemies, and states**:

| Tool | Description |
|------|-------------|
| `list_entities` | List all entities of a given type |
| `get_entity` | Get entity details by ID |
| `create_entity` | Create a new entity with Zod validation |
| `update_entity` | Partial update of an existing entity |
| `delete_entity` | Delete an entity (protects system defaults) |
| `search_entities` | Search by keyword across name/description |

### Map Management (22)
| Tool | Description |
|------|-------------|
| `list_maps` | List all maps with hierarchy |
| `create_map` | Create a new map with size, tileset, BGM |
| `get_map` | Get map details including events |
| `update_map` | Update map properties |
| `delete_map` | Delete a map |
| `get_map_grid` | Render a map as a text grid — walls, ladders, bushes, counters, damage floors, and event positions |
| `get_map_graph` | Map connection graph — links, one-way routes, unreachable maps, broken and dynamic transfers |
| `fill_map_region` | Paint a rectangle with a material, computing autotile shapes so edges and corners join correctly |
| `paint_tiles` | Write many individual tiles at once — props, windows, a whole decoration pass |
| `place_building` | Place a whole building — roof, walls and a working door event — in one call |
| `list_tileset_props` | What named objects this tileset offers — barrels, signs, trees, windows |
| `place_prop` | Place a named object by name, however many tiles it is made of |
| `generate_town` | Generate a whole town — streets, buildings with doors, tree line, decoration |
| `generate_interior` | Fill a map with a room, and wire it to a door on another map |
| `generate_interiors` | Give every door on a map a room, wired both ways |
| `generate_map_layout` | Fill a map with a generated dungeon or cave layout |
| `decorate_dungeon` | Torches on the walls, treasure in the dead ends, clutter on the floor |
| `place_stairs` | Join two maps with a stair, ladder or cave mouth — tiles and transfer events, both ways |
| `link_dungeon_floors` | Wire generated floors into a staircase, and out to a map above ground |
| `apply_wall_shadows` | Write the shadow plane the editor's auto-shadow produces |
| `check_map_walkability` | Traverse the map — unreachable NPCs, blocked doors, cut-off areas |
| `describe_tileset_materials` | Which A2 materials are safe on layer 0, and which have a visible outline |

### Characters (3)
| Tool | Description |
|------|-------------|
| `list_character_sheets` | What sprite sheets the project has, and how many characters each holds |
| `place_npc` | Put one character on a map — sprite, dialogue, how it moves |
| `populate_map` | Scatter NPCs across walkable ground without sealing anything off |

### Tileset Passage (3)
| Tool | Description |
|------|-------------|
| `configure_tileset_passage` | Write a tileset's passage flags from the configuration the editor ships for the same sheets |
| `set_tileset_passage` | Set passage and terrain flags on chosen tiles — for custom art, or to correct the catalogue |
| `list_passage_catalogue` | Which tileset sheets the catalogue covers |

**This is what makes a wall actually block the player.** Passability lives in `Tilesets.json`,
not in map data, so a project whose tileset was never configured produces maps where the
geometry has no effect at all — `check_project` reports it as `tileset-passage-unconfigured`.

Which materials are solid cannot be measured from the image: a cliff face and a cobbled floor
are both opaque rectangles of pixels. It is authored art direction, so the flags are taken from
the tilesets the editor itself ships. What makes that transferable was measured rather than
assumed — **flags are a property of the sheet, not of the tileset**: across 68 configured
tilesets from 9 databases, 56 of 62 sheets carry byte-identical flags everywhere they appear.
The six that vary are named in the catalogue header with the source that won.

Passability is stated the way you mean it. The file stores a *set* bit as blocked, which reads
backwards every time, so `set_tileset_passage` takes `passable: false` and does the inversion.
Tiles are named by autotile material (all 48 shapes, as the editor does it), by prop name, or by
raw id.

`get_map_grid` lets the AI reason about **spatial layout** rather than just map metadata.
Passability is decoded from tileset flags exactly as `Game_Map` does in the engine corescript.
Large maps can be windowed with `x` / `y` / `width` / `height`.

```
   00000000001111111
   01234567890123456
 0 #################
 1 #...............#
 2 #......1........#
 3 #...............#
 4 #################

Events:
1 = event [1] "Shopkeeper" at (7, 2)
```

`get_map_graph` answers **"how does this world fit together?"** — and catches structural bugs:
a map nothing links to, a door pointing at a deleted map, a pit with no way out. Transfers
inside called common events are followed transitively, so maps reached only that way aren't
falsely reported unreachable.

`fill_map_region` writes tiles. In RPG Maker you paint a *material*, not a picture — the tile
id packs both the material and which of 48 edge/corner variants to draw, and placing a tile
changes what its neighbours should look like. This computes all of that, including fixing up
the tiles already around the area, so separate calls join together seamlessly:

```
fill_map_region  mapId=1  x=10 y=7  width=9 height=7   autotileKind=18   # a stone plaza
fill_map_region  mapId=1  x=13 y=2  width=2 height=5   autotileKind=17   # a path into it
```

Shapes are computed for the **A2 ground family** (`autotileKind` 16-47) and the **A3/A4 wall
family** (48-127), each with its own table. Walls use `WALL_AUTOTILE_TABLE`, where the four bits
mean "draw an edge on this side" — so a painted rectangle comes out with proper corners and a
building is one call instead of a dozen hand-computed tile ids. Overlapping rectangles of the
same material merge, so an L-shaped building is two calls. Not every A4 kind is a wall: odd
block rows are, even rows are wall *tops* drawn with the floor table, and the tool tells them
apart. A1 water and waterfalls use a third table and aren't supported yet.

Two mistakes are easy to make and invisible in a text grid, so the tool checks for both by
reading the tileset image. Roughly half of an A2 sheet is **overlay material** whose edge
pieces are transparent: painted on layer 0 those edges show the map background, which renders
black in game — that is refused unless you pass `allowOverlayOnGround`. And column 0 of each
row is a **seamless fill** whose edges are drawn identically to its middle, so a patch of it
has no boundary and reads as a floating slab rather than a path — that is reported as advice.
Which slots are which differs between tilesets, so `describe_tileset_materials` measures them
rather than assuming a layout:

```
Ground materials (opaque — safe as the base layer 0 fill):
  seamless, no visible boundary: 16, 24, 32, 40
  outlined, reads as a distinct patch or path: 17, 18, 19, 25, 26, 27, 33, 34, 35, 41, 42, 43, 45
Overlay materials (transparent edges — layer 1 or above): 20, 22, 28, 30, 36, 37, 38, 39, 44, 46, 47
```

`skipOccupied` paints only cells that are currently empty, which is what a decoration pass
wants — without it a later object silently overwrites an earlier one. When a paint does
overwrite something on an upper layer, the result says so.

`paint_tiles` is the other half of painting: not a rectangle of one material, but a few hundred
individual tiles, each a different object — a window here, a barrel there, half of every tree.
Each entry carries its own tile and layer, so one call can span several layers.

```
paint_tiles  mapId=1  tiles=[{x:4, y:8, tileId:114, layer:1},
                             {x:4, y:9, tileId:122, layer:1}, ...]
```

It is deliberately not a new behaviour: painting the same tiles one at a time lands on exactly
the same grid, and a test asserts that. What it removes is one whole-map file write and one
shape refresh **per tile** — a 144-tile decoration pass is one call instead of 144. Both shape
tables are run rather than one being picked from the material, so a batch touching ground and
wall autotiles at once comes out right, and `skipOccupied` counts the batch's own writes so a
later entry cannot clobber an earlier one. A bad entry — an overlay material bound for layer 0 —
refuses the whole batch rather than applying part of it, because a partial write leaves no way
to tell what landed.

`place_building` is the level above painting: a footprint, a roof and a wall material in,
roof tiles, wall tiles, a door event and shadows out.

```
place_building  mapId=1  x=10 y=6  width=5 height=6  roofSet=green  wallKind=57
                interiorMapId=4  interiorX=8 interiorY=11
```

It exists because a building is not a rectangle of texture, and the three facts that make it
one are per-tileset content rather than engine rules — which is why they had to be measured:

- **A roof block sits on a wall block, and the wall is the A3 kind 8 below the roof.** The A3
  sheet runs roof row / wall row / roof row / wall row, and 81% of the sample maps' roof-over-
  wall columns use that `+8` pairing. Give `roofKind` and the wall follows automatically; give
  a mismatched `wallKind` and the tool says so rather than silently building something that
  looks wrong.
- **A3 roof materials are flat texture with no edge art**, so a correctly-shaped A3 rectangle
  still renders as a slab. Real roofs are nine-slice sets on the `Outside_C` sheet with sloped
  sides and a shingled eave — `roofSet` takes `green`, `white`, `gold` or `brown`, and any
  other sheet's block can be given as `roofTopLeftTileId`. Those sheets are 16 tiles wide but
  addressed as two 8-wide halves, so a set is `topLeft + row * 8 + col` and one starting too
  near a half's edge would wrap; that is refused.
- **Doors are events, not tiles.** The tile people reach for is a pair of shuttered windows
  that never touches the ground. A real door is an event carrying a `!Door` sprite whose four
  "directions" are its animation frames, and the emitted page is the one the shipped maps use —
  play the open SE, turn through the three opening frames, switch Through on, walk the player
  in, transfer. 60 of the 107 sample door pages are that exact sequence.

A nine-slice roof's corner pieces are cut away diagonally, so they show whatever is on the
layer beneath — which on layer 0 is the map background, black in game. The tool measures the
sheet to find *which* cells are actually cut and refuses only when those specific cells have
nothing under them, naming the coordinates. Fill the ground first, or pass
`allowRoofOverEmptyGround`.

Not covered: roofs are rectangles. The sets carry inner-corner pieces for L-shaped roofs
(recorded in `src/core/blueprint.ts`) and nothing uses them yet.

`list_tileset_props` and `place_prop` address objects **by name** rather than by tile id:

```
place_prop  mapId=1  name="Shop Sign (Inn)"  x=14 y=9
place_prop  mapId=1  name="Tree"  x=20 y=4  part={x:0, y:0, width:1, height:2}
```

The names are not invented. RPG Maker ships a `.txt` beside every tileset image holding the
editor's own label for each of its 256 tiles, and a prop is a connected run of tiles sharing a
label — 1,628 of them across the twelve object sheets. **Projects do not ship those files**, so
`scripts/build-prop-catalogue.mjs` reads them from the editor and generates
`src/core/prop-catalogue.ts`; run it again to pick up DLC or custom sheets.

One thing the labels reveal that raw ids hide: **a name often covers an object together with
its filler variants.** `Tree` is a 2x2 box holding a 1x2 tree and a canopy filler beside it —
and a hole, because the fourth cell belongs to `Bush`. `Large Tree` is 4x2: a 2x2 tree plus the
mass that fills the middle of a grove. So placing a whole prop is right for the 1x1 objects that
make up most of a sheet, and `part` takes the object out of the bundle for the rest. Where a
prop has a hole, the result says which prop owns it, so `Tent A`'s gap reports as
`Tent A (Entrance)`.

Object tiles are cut out around their edges, so they need something painted beneath them —
the same check `place_building` makes for a roof's sloped corners, and it names the cells that
would show through.

`generate_town` puts the whole stack together: ground, streets, rows of buildings with working
door events, a tree line framing the map edge, and a decoration pass — one call, reproducible
from its seed.

```
generate_town  mapId=1  seed=3  groundKind=16  roadKind=18  wallKind=57
```

The shape of the town comes from a constraint of the building primitive: a door sits on a
building's bottom row and is entered from the tile below, so a house only works with a street
directly beneath it. The layout is therefore bands — a row of buildings sitting on the street
it faces, repeated down the map. Cross streets run the full height and intersect every road,
which makes the network **connected by construction** rather than by luck, and they cut the tree
line at four points so the town has ways in instead of being sealed inside it.

Everything the earlier findings asked for is enforced before anything is written rather than
audited afterwards: buildings never overlap each other or a street, every door opens onto road,
props go only on free ground — and against a wall or a street edge in preference to the middle
of a block, because scattering them uniformly leaves a lone crate standing in a field. The
outermost ring of the map is left clear of trees on purpose: a tree's canopy is walkable and its
trunk is not, so a tree line flush against the edge would seal off the strip outside it.

Those properties are asserted across 25 seeds in `tests/core/towngen.test.ts`, against the plan
rather than against a map file — the planner is pure, and the tool applies its output with
`fill_map_region`, `placeBuildingOnMap` and `place_prop`.

**Not generated:** interiors, so every door animates but leads nowhere until you make a map and
point it there; NPCs; and buildings on both sides of a street, which needs a door on a
building's top edge and the building primitive has no such thing.

`generate_interiors` gives every door on a map somewhere to go — a room each, wired both ways.
It is what turns a generated town from something to look at into something to walk around in.

```
generate_interiors  mapId=55  tilesetId=3
```

The shape of a room is measured from the 113 interiors that ship with the editor, not invented:
the space around it is A5 tile 1536 (436 of 452 sample-map corners), the room is ringed by an A4
wall *top* with the wall *face* drawn beneath it, the face is two rows tall (2,504 runs of 3,660),
and the pairing is `wallTopKind + 8` — the same `+8` the A3 roofs use. The doorway is a channel
cut straight down through the front wall, and the exit is an invisible player-touch event playing
an SE and transferring, which is 144 of the 147 sample exit events exactly.

The round trip is the part that is easy to get backwards: the door lands the player on the room's
doorway tile, and the room's exit lands them on the tile *in front of* the door — not on the door
itself, which is a wall. Landing on the exit event does not re-fire it: the engine only checks
player-touch events when the player finished a walking step, and a transfer sets the position with
`locate()` instead.

**Not generated:** NPCs, shops, stairs or upper floors — a room is one rectangle. Interiors are
made only for doors that lead nowhere, so hand-made links survive unless you pass `relink`.

`populate_map` puts people in the places the other generators build.

```
populate_map  mapId=55  count=14  seed=7
```

The page settings are the ones real projects use, counted across the 70 talking NPC pages in the
demo projects that ship with the editor — the `samplemaps` folder is scenery templates and has
none. Action Button, priority "same as characters", fixed movement, `walkAnime` and `stepAnime`
both on so the sprite idles in place: 28 of 70, with Player Touch and everything else identical
next at 21. Dialogue becomes Show Text with MZ's five-parameter list, wrapped and split into a
new box every four lines.

**Placement is a connectivity problem, not a scattering one.** An NPC has priority "same as
characters", so it blocks the tile it stands on: one in a doorway or a one-tile alley seals off
whatever is behind it, and the player gets no hint why. Each candidate is therefore accepted only
if the walkable area stays exactly as connected with it as without — checked per placement rather
than audited afterwards — and door approach tiles are excluded outright.

Reachability goes through `Game_CharacterBase.canPass`, not adjacency. Passage flags are
directional, so two adjacent standable tiles can be mutually unreachable: a room's wall top is
standable and sits right beside the floor, yet nothing can step onto it. Treating adjacency as
connectivity puts villagers on top of the walls, which is exactly what the first version of this
did until `check_map_walkability` said so.

**Wandering NPCs are the honest exception.** `movement=random` means the guarantee only holds for
where they start; at runtime one can walk into a doorway, and no static check can see that.

`decorate_dungeon` furnishes what `generate_map_layout` carves.

```
generate_map_layout  mapId=77  style=dungeon  floorKind=18  surroundKind=96  seed=12
decorate_dungeon     mapId=77  floorKind=18  torchCount=16  treasureCount=6
```

Both event kinds are measured. **A torch is decorative and stands on the wall**: of the 635
`!Flame` events across the shipped maps, 623 stand on a *solid* tile, and 499 use the same page —
Action Button, `stepAnime` on so the flame flickers, `directionFix` on so it never turns, and no
commands at all. That also explains a `check_map_walkability` finding that looks like a fault and
is not: a torch is *supposed* to be standing in a wall.

**A pickup is `250, 101, 401, 126, 123, 0`** — play a sound, say what you got, hand it over, flip
self switch A — in 16 of the 20 one-shot pickup events across every shipped project, with a second
page behind that switch that does nothing. The `!Chest` sprite **opens by direction, not pattern**,
the same trick the `!Door1` sprite uses; that was read off the sheet, since nothing shipped uses it.

**Each chest holds something different, dealt from the project's own database.** The reward
used to be item id 1 for every chest on every floor — which in the RTP database is
`-----Reserved`, a separator row with no price, so the default chest handed the player a
nameless nothing. Rewards are now drawn from a slice of the price range (`lootBand`, the
middle half by default: the cheap end is what a shop sells, and the dearest gear is not a
corridor find) and dealt without repeating, because with six chests and independent rolls two
the same is likelier than not, and two identical chests in one dungeon reads as a bug even
though each roll was fair. The same seed still gives the same dungeon.

Which command hands the reward over now follows the database it came from: `command126` gains
`$dataItems`, `command127` `$dataWeapons` and `command128` `$dataArmors`, and the two
equipment ones take a fifth `includeEquip` parameter. The old chest always emitted 126, so a
weapon id silently handed the player whichever *item* shared that number.

**Treasure only ever goes in dead ends.** A chest blocks its tile, and a dead end has one way in
and nothing beyond it, so it is the one placement that provably cannot cut anything off. Ask for
more chests than there are dead ends and you get fewer chests, not one dropped where it might seal
a corridor.

Pass the same `floorKind` the layout was generated with. Without it floor and wall are told apart
by passage flags — and in the RTP tilesets an A4 wall *top* is walkable, so most of a dungeon reads
as floor and the decoration lands outside it. The tool says so when it sees a suspiciously walkable
map.

`place_stairs` and `link_dungeon_floors` connect maps to each other. A generated dungeon is
unreachable in game until something links it to the world, and `link_dungeon_floors` does the
whole staircase in one call — floors in order, optionally out to a surface map:

```
link_dungeon_floors  mapIds=[77, 78]  surfaceMapId=1  surfaceX=22 surfaceY=14
```

The event was measured and came back unanimous: of the 720 shipped maps, **all 157** transfer
pages standing on a stair, ladder or hole tile are the same page — player touch, priority 0
(below characters), no sprite, `250, 201, 0`. Priority 0 is why placement needs no connectivity
argument: a stair blocks nothing, so unlike a chest it can go on any floor tile. That page is
byte-identical to an interior's exit, so `generate_interior` builds its exit from the same code.

Each floor's two stairs go at its **furthest-apart pair of tiles**, and getting that right took
more than the textbook algorithm. The standard double BFS sweep is exact only on a tree, and
generated dungeons have loops — it returned 66 where the true diameter was 79. Sweeping from
every *fringe* tile instead (floor with two or fewer open neighbours) hits the exact diameter on
all 16 test layouts, and costs less precisely where an all-pairs search would cost most.

**A stair tile is not reliably one the player can stand on**, and which ones are varies per
tileset — `Inside`'s "Stairs C (Up)" is blocked from all four directions. So the tool paints,
then checks standability, and says so. The shipped maps never get this wrong (323 of 323), which
is what makes the check worth making.

`apply_wall_shadows` writes the shadow plane (z=4), which `fill_map_region` cannot reach. The
rule comes from the 293 sample maps shipped with the editor: 285 of them use shadows, and of
their 16,829 shadow tiles 81.6% carry the value `5` while 83.7% sit immediately right of a
wall. So every non-wall tile with an A3/A4 tile to its left gets its left half darkened.
Without it, buildings read as flat cut-outs pasted onto the ground.

`check_map_walkability` answers the question a tile-by-tile view cannot: **can the player
actually get there?** It floods the map following `Game_CharacterBase.canPass` and reports
NPCs standing in walls, NPCs sealed inside buildings, doors with no reachable tile in front of
them, and areas cut off from the rest of the map.

Pass `startX`/`startY` — a tile the player is known to reach, usually where they arrive.
Without one the *largest* walkable area is assumed to be the reachable one, and on an interior
that is the wrong area: passage flags are per tile *shape*, not per material, and a room's wall
tops are passable along themselves, so the ring around a room is bigger than the room. Analysing
an interior that ships with the editor without a start reports the room as cut off and its own
exit as unreachable; with one, both it and a generated room come out clean.

```
Walkability — 40x30
  Standable tiles: 832 of 1200
  Largest connected area: 832 (from 0, 0)

No unreachable events, blocked doors or cut-off areas.
```

`generate_map_layout` builds a whole map at once — `dungeon` places rooms joined by L-shaped
corridors, `cave` grows an organic cavern by cellular automata. Both are **guaranteed fully
connected**: the dungeon connects each room to the previous one as it goes, and the cave keeps
only its largest region so there are no sealed-off pockets.

Connectivity was never the problem, though — a fully connected map can still be a featureless
blob, which is what a visual review found. So **what "a good layout" means here is measured**.
Three shape metrics were taken over the 55 dungeon-tileset maps that ship with the editor, and
the generators are tuned to land inside the range those occupy:

| | hand-made (median [p10..p90]) | before | after |
|---|---|---|---|
| floor fraction | 0.219 [0.130..0.797] | cave 0.781, dungeon 0.343 | cave 0.360, dungeon 0.367 |
| edge density | 0.676 [0.452..0.800] | cave 0.154, dungeon 0.629 | cave 0.465, dungeon 0.678 |
| dead ends per 100 | 5.178 [0.000..9.040] | dungeon 0.000 | dungeon 4.329 |
| interior islands | 5 [0..21] | cave 2 | cave 10 |

*Edge density* — the share of floor tiles that touch a wall — is what turns "one large open
blob" from an opinion into a number. The cave sat at 0.154 against a hand-made floor of 0.452.
It is now fixed by two changes: the early cellular-automata passes carry a second rule that
keeps walls ragged, and a **pillar pass** drops solid clumps into open space, each kept only if
the cave stays exactly as connected with it as without. Dungeons gained irregular rooms (two
overlapping rectangles, so L- and T-shaped) and **dead ends** — short passages cut into the rock
that arrive nowhere, which the generator previously never produced at all.

The surround can now be an **A3/A4 wall material**, and where a wall mass meets the floor below
it the paired wall *face* is drawn, so a dungeon has height instead of being floor against a
differently-coloured floor. The same `seed` always reproduces
the same layout.

```
####################....########......##
#############....###....########......##
#############......................@..##
#############....###....#####.##......##
#......######################.##......##
#.............................######.###
```

It reports the open-tile count, room count, a suggested start position, and an ASCII preview.
**It paints materials only** — whether the player can actually walk on them comes from the
tileset's passage settings, so check the result with `get_map_grid`.

### Event Editing (5)
| Tool | Description |
|------|-------------|
| `list_events` | List events on a map |
| `create_event` | Create a new event at a position |
| `update_event` | Update event properties |
| `add_event_commands` | Add commands using human-readable format |
| `delete_event` | Delete an event |

**40+ supported command types** including `show_text`, `show_choices`, `transfer_player`, `control_switches`, `play_bgm`, `battle_processing`, `shop_processing`, and more.

### Event Flow Analysis (2)
| Tool | Description |
|------|-------------|
| `describe_map_events` | Overview of every event on a map — one line per page: trigger + gating conditions |
| `describe_event` | Full breakdown of one event: per-page trigger, conditions, readable command flow, and everything it touches |

Where `list_events` tells you an event *exists*, these tell you what it **does** — decoding
raw command codes into readable logic and surfacing the switches, variables, self-switches,
common events, and map transfers involved.

```
Event [3] "Shopkeeper" at (8, 6) — 2 page(s)

── Page 2 ──
Trigger: Action Button
Conditions: self-switch A is ON

Show Text: "Back again? Take a look."
If switch 12 is ON
  Shop Processing
Else
  Show Text: "Come back when you have coin."
End If

── References ──
Reads switches: 12
Writes self-switches: A
```

### Switches and Variables (3)
| Tool | Description |
|------|-------------|
| `list_switches` | What the project's global flags are called, which ids are free, how far the arrays reach |
| `allocate_switch` | Get an id for a named switch or variable, creating it if there isn't one |
| `release_switch` | Take the name off a flag so the id can be reused |

These are the primitive everything with *state* needs — quests, locked doors, a shop that
only opens after dark.

**The names array in System.json is not decoration.** `Game_Switches.setValue` is guarded by
`switchId > 0 && switchId < $dataSystem.switches.length`, and `Game_Variables.setValue` by
the identical test — so **the array's length is the engine's bound on which flags work at
all**. Going outside it fails silently in both directions: `setValue` does nothing, and
`value()` is unguarded and answers `false`. An event setting switch 50 in a project whose
array stops at 20 has no effect, raises no error, and every condition reading that switch is
false forever.

So allocation has one hard rule: never hand out an id the array does not already cover.
`allocate_switch` extends it when it has to, in the `20n + 1` blocks the shipped projects
use — a new project has 21 slots, and the larger projects on hand have 101 and 201.

```
allocate_switch  kind=switch  name="Village gate open"
allocate_switch  kind=switch  name="Endgame reached"  id=45
```

Asking twice for the same name gives the same id back — matching ignores case and
surrounding space — so a generator can call it every run without burning a new flag each
time. Claiming an id that already carries a *different* name is refused: renaming a flag
silently repoints every event that uses it. Naming is sparse in real projects (one names 28
of its 200 slots), so a new flag goes in the first gap, which is what the editor does too.

`release_switch` clears a name without shortening the array — shortening it would move the
bound and break every id above the one freed.

Self switches are not managed here and need no allocation: `Game_SelfSwitches` is a plain
keyed dictionary with no bound, which is why chests and doors can use one freely.

### Commerce (1)
| Tool | Description |
|------|-------------|
| `place_shop` | A shopkeeper who greets the player and opens a buy/sell window, stocked from the project's own database |

A shop is a talking NPC that opens a shop scene, so `place_shop` builds the page
`npcgen` already measured across 70 NPC pages and appends the shop commands — rather than
copying the page from the four shop events available to measure, which is far too thin a
sample to settle anything. What *is* settled exactly is the encoding, because the engine
defines it:

- `Game_Interpreter.command302` builds `goods = [params]` and absorbs each `605` that
  follows, so **the 302's own parameters are the first goods row**, not a list of rows. It
  passes `params[4]` as the scene's `purchaseOnly` flag, which therefore belongs to the shop
  and lives only on that first row.
- `Window_ShopBuy.goodsToItem` switches on `goods[0]` — 0 items, 1 weapons, 2 armours — and
  `makeItemList` prices a row as `goods[2] === 0 ? item.price : goods[3]`. Omit a price and
  the shop follows the database if you reprice the item later.

**Stock comes from the project, and the filter is the engine's own.**
`Window_ShopSell.isEnabled` is `item && item.price > 0`, so a price of zero already means
"not tradeable" to MZ — which is what keeps the `-----Recovery Items` separator rows the RTP
database is full of off the shelf. Key items are excluded too, since the engine categorises
them apart from goods and a shop selling the plot coupon is a bug every time.

```
place_shop  mapId=1  x=14 y=9  preset=general  count=6
place_shop  mapId=1  x=20 y=9  preset=weapon   priceBand=[0.5, 1]
```

`preset` picks the database and `priceBand` the slice of it, as two fractions of the
tradeable entries sorted by price — `[0, 0.5]`, the default, is a village store, and
`[0.5, 1]` a capital-city one. Pass `goods` instead for an exact shelf; those ids are
checked against the database before anything is written, because **the engine drops a row
pointing at a missing id without a word** and the only symptom is a shop quietly one item
short.

### Locked Doors (1)
| Tool | Description |
|------|-------------|
| `place_locked_door` | A door that opens for a key item or a switch, says so when it can't, and remembers once it has |

The smallest thing that needs all three of what the generators never had: a condition, a
second page, and a memory of what the player already did.

**The sample here is one event** — across every project on hand there is exactly one locked
door — so its *wording* settles nothing and is all parameters. What the corpus does settle is
which of the two mechanisms the engine offers gets used: `itemValid`, the engine's own
"this page needs an item" page condition, appears on **0 of 544 event pages**, while
conditional branches on a held item appear 4 times. An item lock is a branch.

Three things about that branch are exact, because the interpreter defines them:

- **The parameter shape differs per database.** `command111` case 8 is
  `hasItem($dataItems[params[1]])` with no third parameter, but cases 9 and 10 pass
  `params[2]` to `hasItem` as `includeEquip` — so a weapon key can count while it is
  equipped and an item key has no such option.
- **A branch body ends with a `0` at the body's own indent** (32 of 32 measured branches),
  and `skipBranch` walks purely by indent — a body written flat is a body the engine runs
  unconditionally.
- **Nothing may follow a transfer.** `Game_Map.setup` rebuilds the event list and the running
  interpreter goes with it, so the self switch that remembers the door is open is written
  *before* the 201, not after it the way a chest writes its own.

```
place_locked_door  mapId=3  x=12 y=8  lockKind=item  keyId=35  targetMapId=9 targetX=6 targetY=11
place_locked_door  mapId=3  x=20 y=4  lockKind=switch  switchName="Cellar unlocked"  remember=false
```

The key is checked against the database and the switch against System.json *before* anything
is written, because both failures are silent in game: `hasItem` answers false for an entry
that is not there, and `setValue` ignores an id past the end of the array — either way the
door simply never opens and nothing says why. A `switchName` with no flag behind it is
allocated exactly as `allocate_switch` would, so a door can be placed without knowing an id.

The asking page is **Action Button**, not the ordinary door's Player Touch: a touch-triggered
locked door announces itself every time the player brushes past. Page 2 is an ordinary door
conditioned on self switch A, and it goes *after* page 1 because
`Game_Event.findProperPageIndex` scans backwards and takes the first match. `remember=false`
drops it, for a gate that must follow its switch forever.

### Consistency Checking (1)
| Tool | Description |
|------|-------------|
| `check_project` | Static analysis across the whole project — finds bugs before you playtest |

Catches the failure modes that are painful to find by hand:

| Rule | Severity | What it catches |
|------|:---:|-----------------|
| `autorun-cannot-stop` | error | An Autorun page with no way to end — freezes the game on map entry |
| `self-switch-never-set` | error | A page gated on a self-switch nothing can ever set — that page is dead |
| `transfer-to-missing-map` | error | A door pointing at a deleted map |
| `missing-common-event` | error | Call Common Event targeting an ID that doesn't exist |
| `switch-out-of-range` | error | A switch id past the end of System.json's array — setValue ignores it, so the flag is permanently false |
| `variable-out-of-range` | error | The same for variables |
| `switch-read-never-written` | warning | A condition that can never change |
| `variable-read-never-written` | warning | A variable that will always be 0 |
| `unreachable-map` | warning | A map with no route from the start map |
| `shop-sells-missing-entry` | error | A shop offering an item, weapon or armour that no longer exists — the engine drops the row silently |
| `branch-checks-missing-entry` | error | A branch testing for a key that was deleted — `hasItem` is false forever, so a door locked that way never opens |
| `tileset-passage-unconfigured` | warning | Tileset passage never set up, so ground-layer walls don't block |
| `switch-written-never-read` | info | A dead write |

Findings name the flag where System.json has one — `switch 12 ("Met the mayor")` rather than a bare id — which is most of what makes `allocate_switch` worth using.

Filter with `minSeverity` (`error` / `warning` / `info`).

**Rules are conservative by design** — a linter that cries wolf gets ignored. Script and
Plugin Commands can do anything, so events containing them are skipped by the self-switch
and autorun rules, and the report says so rather than reporting confident nonsense.

### AI Scenario Generation (3)
| Tool | Description |
|------|-------------|
| `generate_scenario` | Generate a game scenario outline from a theme |
| `generate_dialogue` | Generate NPC dialogue as event commands |
| `generate_quest` | Design a quest with objectives and rewards |

These tools leverage the AI's own capabilities — no external API calls needed.

---

## 📦 Installation

```bash
# Clone the repository
git clone https://github.com/AlexIsakson/rpgmaker-mz-mcp.git
cd rpgmaker-mz-mcp

# Install dependencies
npm install

# Build
npm run build

# Verify (534 tests should pass)
npm test
```

---

## ⚙️ Configuration

### Claude Code (CLI)

Create a `.mcp.json` file in your project directory:

```json
{
  "mcpServers": {
    "rpgmaker-mz": {
      "command": "node",
      "args": ["/path/to/rpgmaker-mz-mcp/dist/index.js"]
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "rpgmaker-mz": {
      "command": "node",
      "args": ["/path/to/rpgmaker-mz-mcp/dist/index.js"]
    }
  }
}
```

---

## 💬 Usage Examples

Once the MCP server is connected, talk to Claude naturally:

```
You: Load my RPG Maker MZ project at /Users/me/Games/MyRPG

You: Create a warrior character named "Roland" with high attack

You: Create a 20x15 village map called "Oakwood Village" with Town1 BGM

You: Add an NPC shopkeeper on map 2 at position (8, 6)

You: Add dialogue to the shopkeeper: "Welcome! Take a look at my wares."

You: Generate a quest about rescuing a kidnapped princess

You: Create a healing potion item that restores 200 HP
```

---

## 🏗 Architecture

```
src/
├── index.ts                    # MCP Server entry point (stdio transport)
├── logger.ts                   # stderr-only logger
├── core/
│   ├── file-handler.ts         # Atomic writes + backups + Zod validation
│   ├── project-manager.ts      # Project loading / validation
│   ├── database-manager.ts     # Generic CRUD for all entity types
│   ├── version-sync.ts         # System.json versionId auto-sync
│   │
│   ├── tileset-reader.ts       # Tileset passability flag loading
│   ├── tileset-image.ts        # Measures the A2 sheet — opacity, edge contrast
│   ├── passage.ts              # Slot ranges, passage planning, flag edits
│   ├── passage-catalogue.ts    # Generated: shipped tilesets' passage flags (RLE)
│   ├── prop-catalogue.ts       # Generated: 1,628 named props across 12 sheets
│   │
│   ├── map-grid.ts             # Tile decoding + ASCII grid rendering
│   ├── map-layers.ts           # Tile layer read/write over the flat data array
│   ├── map-graph.ts            # Transfer graph + reachability analysis
│   ├── walkability.ts          # Flood fill through Game_CharacterBase.canPass
│   ├── event-flow.ts           # Command-code decoding + reference collection
│   ├── consistency.ts          # Project-wide static consistency rules
│   │
│   ├── autotile.ts             # A2 floor autotile shape computation
│   ├── wall-autotile.ts        # A3/A4 wall shape computation
│   ├── shadows.ts              # The z=4 shadow plane
│   ├── tile-batch.ts           # Batched multi-layer tile writes
│   ├── building-placement.ts   # Applying a building plan to a map file
│   ├── blueprint.ts            # Roof/wall pairing, nine-slice roofs, door events
│   ├── props.ts                # Named-object lookup and placement
│   │
│   ├── mapgen.ts               # Dungeon / cave layout generation
│   ├── towngen.ts              # Town planning — streets, plots, tree line
│   ├── interiorgen.ts          # Rooms behind doors, wired both ways
│   ├── npcgen.ts               # NPC pages + connectivity-safe placement
│   ├── dungeon-dressing.ts     # Torches, treasure, floor clutter
│   ├── stairs.ts               # Stair transfer pages + furthest-pair planning
│   │
│   ├── switches.ts             # Named global flags, allocation and array growth
│   ├── shop.ts                 # Goods encoding + stock selection
│   ├── loot.ts                 # Loot tables, dealt without repeats
│   └── locked-door.ts          # Conditional branches + the two pages of a locked door
├── schemas/
│   ├── database.ts             # Zod schemas for 8 entity types
│   ├── map.ts                  # Map & audio schemas
│   ├── event.ts                # Event & command schemas + converter
│   ├── tileset.ts              # Tilesets.json schema
│   └── system.ts               # System.json schema
├── tools/                      # 54 MCP tools across 24 modules
│   ├── project-tools.ts        # 4  project management
│   ├── database-tools.ts       # 6  database CRUD
│   ├── map-tools.ts            # 5  map management
│   ├── event-tools.ts          # 5  event editing
│   ├── map-paint-tools.ts      # 3  fill_map_region, paint_tiles, apply_wall_shadows
│   ├── npc-tools.ts            # 3  character sheets, place_npc, populate_map
│   ├── passage-tools.ts        # 3  tileset passage configuration
│   ├── scenario-tools.ts       # 3  AI scenario generation
│   ├── event-flow-tools.ts     # 2  event flow analysis
│   ├── interior-tools.ts       # 2  generate_interior(s)
│   ├── prop-tools.ts           # 2  list_tileset_props, place_prop
│   ├── stairs-tools.ts         # 2  place_stairs, link_dungeon_floors
│   ├── blueprint-tools.ts      # 1  place_building
│   ├── switch-tools.ts         # 3  allocate/list/release_switch
│   ├── consistency-tools.ts    # 1  check_project
│   ├── shop-tools.ts           # 1  place_shop
│   ├── locked-door-tools.ts    # 1  place_locked_door
│   ├── dungeon-dressing-tools.ts # 1 decorate_dungeon
│   ├── map-graph-tools.ts      # 1  get_map_graph
│   ├── map-grid-tools.ts       # 1  get_map_grid
│   ├── mapgen-tools.ts         # 1  generate_map_layout
│   ├── tileset-tools.ts        # 1  describe_tileset_materials
│   ├── towngen-tools.ts        # 1  generate_town
│   └── walkability-tools.ts    # 1  check_map_walkability
├── templates/
│   ├── defaults.ts             # RPG Maker MZ default data templates
│   └── engine-files.ts         # Engine files written by create_project
scripts/
├── build-passage-catalogue.mjs # Regenerate passage-catalogue.ts from the editor
├── build-prop-catalogue.mjs    # Regenerate prop-catalogue.ts from the editor
└── render-map.mjs              # Render any map to a PNG (ports Tilemap's drawing)
```

The two `*-catalogue.ts` files are **generated and committed**. They are built from the
tilesets and `.txt` label files the editor ships, which projects do not include — rerun the
matching script against an editor install to pick up DLC or custom sheets.

### Key Design Decisions

- **Atomic writes**: Write to `.tmp` → `fs.rename()` to target. Rename is atomic on the same filesystem, preventing data corruption from partial writes.
- **Auto backup**: Every write creates a `.bak` file before overwriting, enabling easy recovery.
- **Zod validation**: All JSON reads are validated through Zod schemas instead of unsafe `as T` type assertions.
- **Generic DatabaseManager\<T\>**: One class handles CRUD for all 8 entity types, eliminating code duplication.
- **stderr-only logging**: MCP uses stdout for JSON-RPC. Any `console.log` would corrupt the protocol. We use `console.error` exclusively.
- **Version sync**: Every data file modification bumps `System.json` `versionId`, forcing RPG Maker MZ editor to reload.

---

## 🧪 Development

```bash
# Run tests
npm test

# Watch mode
npm run test:watch

# Build
npm run build

# Dev mode (auto-rebuild on changes)
npm run dev
```

### Runtime Dependencies (minimal)

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP protocol implementation |
| `zod` | Schema validation |
| `pngjs` | Reading tileset images to measure material opacity and edge contrast |

That's it. Just 3 runtime dependencies.

---

## 📄 License

This project is licensed under the [GNU General Public License v3.0](LICENSE).

You are free to use, modify, and distribute this software, provided that derivative works are also distributed under the same license.

---

<a id="繁體中文"></a>
## 繁體中文

[English](#-rpg-maker-mz-mcp-server) | **繁體中文** | [日本語](#日本語)

### 簡介

一個**穩定、經過完整測試**的 [Model Context Protocol](https://modelcontextprotocol.io) 伺服器，讓 Claude 等 AI 助手能透過自然語言建立和編輯 [RPG Maker MZ](https://www.rpgmakerweb.com/products/rpg-maker-mz) 專案。

> **為什麼要重新開發？** GitHub 上現有的 RPG Maker MZ MCP Server 都有嚴重問題 — stdout 污染導致 MCP 協議損壞、副檔名錯誤、沒有原子寫入、沒有測試、SDK 過時。本專案從頭開發，解決了所有已知問題。

### 特色

- **原子寫入**：先寫入 `.tmp` 暫存檔，再用 `fs.rename()` 覆蓋目標，防止寫入中斷導致資料損壞
- **自動備份**：每次寫入前自動建立 `.bak` 備份檔
- **Zod 驗證**：讀取 JSON 時透過 Zod schema 驗證，取代不安全的 `as T` 型別斷言
- **泛型資料庫管理器**：一個 `DatabaseManager<T>` 處理所有 8 種實體的 CRUD，消除重複程式碼
- **stderr 日誌**：MCP 使用 stdout 進行 JSON-RPC 通訊，任何 `console.log` 都會破壞協議。本專案只用 `console.error`
- **版本同步**：每次修改資料檔案後自動更新 `System.json` 的 `versionId`，強制 RPG Maker MZ 編輯器重新載入

### 可用工具（共 53 個）

| 類別 | 工具數 | 說明 |
|------|:---:|------|
| 專案管理 | 4 | 載入 / 建立 / 查詢專案資訊 / 列出素材資源 |
| 資料庫 CRUD | 6 | 列出 / 取得 / 新增 / 更新 / 刪除 / 搜尋（支援角色、職業、技能、道具、武器、防具、敵人、狀態） |
| 地圖管理 | 22 | 列出 / 建立 / 查看 / 更新 / 刪除地圖 / 以文字網格呈現地圖（牆壁、梯子、事件位置等空間資訊）/ 地圖連線圖（單向通道、無法抵達的地圖、失效的場所移動）/ 繪製區域（自動計算 autotile 接邊）/ 批次寫入圖塊 / 放置建築（屋頂、牆壁、門事件）/ 依名稱放置物件 / 產生城鎮、室內、地城或洞窟 / 地城裝飾（火把、寶箱、雜物）/ 樓梯與地城樓層連接 / 陰影圖層 / 通行性檢查 / 圖塊材質分析 |
| 角色配置 | 3 | 列出角色圖檔 / 放置單一 NPC / 在不阻斷通路的前提下佈置多個 NPC |
| 圖塊通行度 | 3 | 依編輯器內建設定寫入通行度旗標 / 手動設定指定圖塊 / 查詢已支援的圖塊表 |
| 事件編輯 | 5 | 列出 / 建立 / 更新 / 新增指令 / 刪除事件（支援 40+ 種人類可讀指令格式） |
| 事件流程分析 | 2 | 解析事件實際行為：各頁的觸發條件、指令流程，以及所使用的開關 / 變數 / 獨立開關 / 公共事件 / 場所移動 |
| 專案一致性檢查 | 1 | 全專案靜態檢查：無法停止的自動執行、永遠無法開啟的獨立開關、失效的場所移動與公共事件、從未設定的開關 / 變數、無法抵達的地圖、未設定通行度的圖塊組 |
| 開關與變數 | 3 | 列出 / 配置 / 釋放全域開關與變數。依名稱重複使用同一 ID，並在必要時擴充陣列（超出陣列長度的 ID 引擎會靜默忽略） |
| 商店 | 1 | 放置商人與買賣視窗，商品從專案資料庫中挑選（依引擎自身的可交易判斷：售價大於零） |
| AI 劇情生成 | 3 | 生成遊戲劇情大綱 / NPC 對話 / 任務設計 |

### 使用範例

連接 MCP Server 後，用自然語言跟 Claude 對話即可：

```
你：載入我的 RPG Maker MZ 專案，路徑是 /Users/me/Games/MyRPG

你：建立一個戰士角色，名字叫「羅蘭」，攻擊力要高

你：建立一張 20x15 的村莊地圖，叫做「橡木村」，背景音樂用 Town1

你：在地圖 2 的座標 (8, 6) 放一個 NPC 商人

你：幫商人加一段對話：「歡迎光臨！請看看我的商品。」

你：幫我設計一個拯救被綁架公主的任務

你：建立一個回復 200 HP 的治療藥水
```

### 安裝與設定

```bash
git clone https://github.com/AlexIsakson/rpgmaker-mz-mcp.git
cd rpgmaker-mz-mcp
npm install
npm run build
npm test  # 534 個測試應全部通過
```

在你的專案目錄建立 `.mcp.json`：

```json
{
  "mcpServers": {
    "rpgmaker-mz": {
      "command": "node",
      "args": ["/path/to/rpgmaker-mz-mcp/dist/index.js"]
    }
  }
}
```

---

<a id="日本語"></a>
## 日本語

[English](#-rpg-maker-mz-mcp-server) | [繁體中文](#繁體中文) | **日本語**

### 概要

**安定性が高く、十分にテスト済み**の [Model Context Protocol](https://modelcontextprotocol.io) サーバーです。Claude などの AI アシスタントが自然言語で [RPG Maker MZ](https://www.rpgmakerweb.com/products/rpg-maker-mz)（RPGツクールMZ）のプロジェクトを作成・編集できるようにします。

> **なぜ新しく開発したのか？** GitHub 上の既存の RPG Maker MZ MCP サーバーには深刻な問題があります — stdout 汚染による MCP プロトコル破損、間違ったファイル拡張子、アトミック書き込みなし、テストなし、古い SDK。本プロジェクトはこれらすべてをゼロから解決しました。

### 特徴

- **アトミック書き込み**：`.tmp` 一時ファイルに書き込み → `fs.rename()` で上書き。書き込み途中のデータ破損を防止
- **自動バックアップ**：書き込み前に自動で `.bak` バックアップを作成
- **Zod バリデーション**：JSON 読み取り時に Zod スキーマで検証。安全でない `as T` 型アサーションを排除
- **汎用データベースマネージャー**：`DatabaseManager<T>` 一つで全 8 種のエンティティの CRUD を処理。コードの重複を排除
- **stderr 専用ログ**：MCP は stdout を JSON-RPC 通信に使用。`console.log` はプロトコルを破壊するため、`console.error` のみ使用
- **バージョン同期**：データファイル変更のたびに `System.json` の `versionId` を自動更新し、RPGツクールMZ エディタに再読み込みを強制

### 利用可能なツール（全 53 個）

| カテゴリ | ツール数 | 説明 |
|---------|:---:|------|
| プロジェクト管理 | 4 | 読み込み / 作成 / 情報取得 / リソース一覧 |
| データベース CRUD | 6 | 一覧 / 取得 / 作成 / 更新 / 削除 / 検索（アクター、職業、スキル、アイテム、武器、防具、敵キャラ、ステート対応） |
| マップ管理 | 22 | 一覧 / 作成 / 詳細 / 更新 / 削除 / テキストグリッド表示（壁・はしご・イベント位置などの空間情報）/ マップ接続グラフ（一方通行・到達不能マップ・無効な場所移動）/ 領域の塗りつぶし（オートタイル形状を自動計算）/ タイルの一括書き込み / 建物の配置（屋根・壁・ドアイベント）/ 名前によるオブジェクト配置 / 町・室内・ダンジョン・洞窟の自動生成 / ダンジョンの装飾（松明・宝箱・小物）/ 階段とフロア間の接続 / 影レイヤー / 通行可能性チェック / タイルセット素材の判定 |
| キャラクター配置 | 3 | キャラチップ一覧 / NPC を 1 体配置 / 通路を塞がないように複数の NPC を配置 |
| タイルセット通行度 | 3 | エディタ同梱の設定から通行フラグを書き込み / 指定タイルを手動設定 / 対応シート一覧 |
| イベント編集 | 5 | 一覧 / 作成 / 更新 / コマンド追加 / 削除（40以上の人間が読めるコマンド形式対応） |
| イベントフロー解析 | 2 | イベントの実際の動作を解析：各ページのトリガー・出現条件・コマンドの流れ、使用しているスイッチ / 変数 / セルフスイッチ / コモンイベント / 場所移動 |
| プロジェクト整合性チェック | 1 | プロジェクト全体の静的解析：停止できない自動実行、絶対にONにならないセルフスイッチ、存在しないマップ / コモンイベントへの参照、未設定のスイッチ / 変数、到達不能マップ、通行設定が未構成のタイルセット |
| スイッチと変数 | 3 | グローバルスイッチ / 変数の一覧・確保・解放。同名なら同じ ID を返し、必要に応じて配列を拡張（配列長を超える ID はエンジンが無視） |
| ショップ | 1 | 店主と売買ウィンドウを配置。商品はプロジェクトのデータベースから選択（エンジン自身の取引可否判定：価格 0 より大） |
| AI シナリオ生成 | 3 | ゲームシナリオ概要 / NPC 会話 / クエスト設計の生成 |

### 使用例

MCP サーバー接続後、Claude に自然言語で話しかけるだけで操作できます：

```
あなた：/Users/me/Games/MyRPG にある RPGツクールMZ のプロジェクトを読み込んで

あなた：「ローランド」という名前の戦士キャラクターを作って、攻撃力を高めに

あなた：20x15 の村マップを作って、名前は「オークウッド村」、BGMは Town1 で

あなた：マップ 2 の座標 (8, 6) に NPC の商人を配置して

あなた：商人にセリフを追加して：「いらっしゃいませ！商品をご覧ください。」

あなた：さらわれた姫を救出するクエストを設計して

あなた：HP を 200 回復する回復薬を作って
```

### インストールと設定

```bash
git clone https://github.com/AlexIsakson/rpgmaker-mz-mcp.git
cd rpgmaker-mz-mcp
npm install
npm run build
npm test  # 534 テストがすべてパスするはず
```

プロジェクトディレクトリに `.mcp.json` を作成：

```json
{
  "mcpServers": {
    "rpgmaker-mz": {
      "command": "node",
      "args": ["/path/to/rpgmaker-mz-mcp/dist/index.js"]
    }
  }
}
```
