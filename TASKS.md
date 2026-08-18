# Phase 5 backlog

The ordered list of what is left in **procedural map generation**. One task ≈ one commit.
Work top to bottom; `/continue` takes the first unchecked box.

Scope is Phase 5 only. Phase 4's remaining database-integrity rules and the engine tier
(Phases 6–7) are deliberately out of scope here — see [ROADMAP.md](ROADMAP.md).

**Progress: 6 / 33**

---

## M1 — Ergonomics and reach

Small, self-contained, and each removes a papercut that currently misleads or blocks a caller.

- [x] **P5-01 — Fix the `autotileKind` description**
  The parameter doc says "columns 1-4 are patch materials with visible outlines". Column 4 is the
  first *overlay* material, so a caller who follows the description lands straight in the
  transparent-holes bug the classifier exists to prevent. Correct the wording in the tool schema
  and check no other tool description repeats it.
  *Done when:* the description matches what `src/core/tileset-image.ts` actually classifies.
  *Done:* `fill_map_region`'s own description had already been rewritten; the claim survived in
  the ROADMAP verification caveat and in CLAUDE.md. Measured all four RTP A2 sheets with the new
  `scripts/measure-a2-columns.mjs`: the sentence is wrong for 30 of the 64 kinds in columns 1-4,
  and **no** column is opaque-and-outlined in all four sheets, so no column rule can be right.
  See [A2 columns predict nothing](ROADMAP.md#a2-columns-predict-nothing). Turned up P5-26.

- [x] **P5-02 — Write the region plane (z=5)**
  Map data is `data[(z * height + y) * width + x]`; z 0–3 are tiles, z 4 is shadow, **z 5 is the
  region id** and no tool can reach it. `fill_map_region` caps `layer` at 0–3. Regions drive
  encounter zones and a great many plugins, so a generated map cannot participate in either.
  Add `paint_regions` (and/or a region argument to the batch writer), mirroring how
  `apply_wall_shadows` reached z=4.
  *Done when:* a region can be written and read back, and `get_map_grid` can show it.
  *Done:* `paint_regions` takes a rectangle or a tile list; `get_map_grid showRegions` prints
  the plane. The corpus turned out to be silent — 0 of 293 sample maps use z=5 and all 293 ship
  an empty `encounterList` — so the semantics come from the engine (`Game_Map.regionId`,
  `meetsEncounterConditions`) and no convention was invented. See
  [The region plane](ROADMAP.md#the-region-plane--the-sixth-layer). Turned up P5-27.

- [x] **P5-03 — Resolve switch *names* in `add_event_commands`**
  `allocate_switch` gives a named flag an id, and `place_locked_door` accepts `switchName` and
  allocates behind it — but `add_event_commands` still takes `control_switches` by raw id, so a
  caller has to allocate, remember the number, and pass it. Apply the same name resolution in the
  command converter.
  *Done when:* a command list can name a flag and the converter allocates or looks it up.
  *Done:* `src/core/command-flags.ts` rewrites `switchName` / `variableName` into ids on
  `control_switches`, `control_variables` and `conditional_branch`, reusing an existing flag of
  that name and otherwise allocating exactly as `allocate_switch` would. Measured with the new
  `scripts/measure-flag-usage.mjs`: the 293 sample maps use **no** global switch or variable at
  all, while `Wicked Heart` refers to **26 distinct switch ids and all 26 are named** — the name
  is the handle a real project already works in. Fixed on the way: a variable `conditional_branch`
  emitted 3 parameters where `command111` case 1 reads 5, so it could never be taken. See
  [Naming a flag in a command list](ROADMAP.md#naming-a-flag-in-a-command-list). Turned up P5-28,
  P5-29 and P5-30.

- [x] **P5-28 — Make a conditional branch actually gate**
  *(turned up by P5-03.)* `convertCommand` emits every command at `indent: 0`, and
  `Game_Interpreter.skipBranch` advances only `while (list[index + 1].indent > this._indent)` —
  so a false branch skips nothing and the commands after it run either way. Every
  `conditional_branch` built through `add_event_commands` is decorative today; the tool now
  warns, which is not the same as working. Needs a nesting model: per-command `indent`, plus
  `else` (411) and the branch/loop end markers (412, 413) as command types.
  *Done when:* a branch whose condition is false skips its body, asserted against a port of
  `skipBranch` rather than against itself.
  *Done:* `src/core/command-nesting.ts` computes indent from block structure — indent is never
  passed by hand, since a caller who could set it could write a list the engine walks differently
  from the way it reads. Three block kinds on one mechanism: branch (`else` / `end_branch`), loop
  (`repeat_above`) and choice (`when_choice` / `when_cancel` / `end_choices`). Measured over 3014
  corpus command lists: **all 3014 end with the `{code:0, indent:0}` terminator** that
  `skipBranch`'s unguarded lookahead depends on, **all 82 block markers sit at their opener's
  indent**, **all 34 branches are closed by a 412**, and **all 9 `show_choices` are followed by a
  402 at the same indent** while all 37 branches and loops are followed by a deeper command — the
  one place the constructs differ, and now a refusal. Asserted with `walkCommands`, a port of
  `executeCommand`/`skipBranch`/`command111`/`411`/`402`/`403`/`413`/`113`, and re-run over JSON
  the real server wrote. See [Indent is the gate](ROADMAP.md#indent-is-the-gate). Turned up
  P5-32.

- [x] **P5-32 — Branch on how a battle ended**
  *(turned up by P5-28.)* `battle_processing` emits a bare 301 with nothing after it, so a
  generated battle cannot lead anywhere — you cannot reward a win or handle a loss. The engine
  has the same indent machinery for it: `command601` (If Win), `command602` (If Escape) and
  `command603` (If Lose) each `skipBranch()` unless `_branch[_indent]` matches, with 604 closing.
  Measured: of 13 `battle_processing` commands in the corpus, **11 are immediately followed by a
  601 at the same indent**, so a bare 301 is the exception rather than the norm. Add the four as
  a fourth block kind in `command-nesting.ts` — the model already takes a new `BlockSpec` with
  multiple dividers.
  *Done when:* a battle can be followed by win/escape/lose arms, asserted with `walkCommands`.
  P5-18 ("a switch set by winning a battle") depends on this.
  *Done:* a fourth `BlockSpec` with two properties the others did not need — it opens a block
  only when an arm follows (2 of 13 have none), and its arms are ordered. **All 11 armed battles
  run Win → [Escape] → Lose → End with no exception**, so the order is enforced. `canLose: false`
  with an `if_lose` arm is **refused** — `updateBattleEnd` sends a party wipe to `Scene_Gameover`,
  so the interpreter never resumes — while `canEscape: false` with an `if_escape` arm is
  **allowed** despite an equally tight 11/11 correlation, because Abort Battle (command 340) from
  a troop page reaches result 1 without consulting `canEscape`. Verified by walking JSON the real
  server wrote. See [Battles lead somewhere](ROADMAP.md#battles-lead-somewhere). Turned up P5-33.

- [ ] **P5-33 — Check that a troop exists before writing a battle**
  *(turned up by P5-32.)* `command301` only sets up the battle inside
  `if ($dataTroops[troopId])`, and the event callback is installed in the same block. So
  `battle_processing` with a troop id that is not in Troops.json is silent in **every** direction:
  no battle starts, `_branch[_indent]` is never set, and every win/escape/lose arm is skipped —
  the player walks through an ambush that does not happen and nothing reports a thing. Confirmed
  with `walkCommands`. Nothing in the server validates `troopId`; a new project ships **5**
  troops (`Wicked Heart` has 100), so an id picked without looking is easily past the end.
  *Done when:* a `battle_processing` naming a troop that does not exist is refused, saying how
  many the project has — and ideally troops can be named the way switches are (see P5-03).

- [ ] **P5-29 — Write page conditions**
  *(turned up by P5-03.)* Switch page conditions are the **most common** way real event logic
  gates itself — 62 uses in `Wicked Heart`, against 43 Control Switches and 23 conditional
  branches — and no tool writes one. `create_event` and `update_event` do not touch
  `page.conditions` at all; only the generators that build their own pages (`lever.ts`,
  `locked-door.ts`, `vault.ts`) ever set one. A caller can set a switch but cannot make anything
  respond to it.
  *Done when:* a page's switch / variable / self-switch / item / actor conditions can be set,
  by name where the flag has one, and `describe_event` reads them back.

- [ ] **P5-30 — Fix the random operand on `control_variables`**
  *(turned up by P5-03.)* `convertCommand` emits 5 parameters for code 122. `command122`
  operand 2 (Random) reads `params[5]` as the top of the range: `randomMax = params[5] -
  params[4] + 1` is `NaN`, `Math.max(NaN, 1)` is `NaN`, and the variable is set to `NaN`. Same
  class of bug as the conditional branch P5-03 fixed, in the same converter.
  *Done when:* a random assignment emits the range top, and operands 3 (game data) and 4
  (script) either work or are refused by name.

- [x] **P5-26 — Check the material in the generators that paint one**
  *(turned up by P5-01.)* `fill_map_region`, `paint_tiles` and `generate_town` all consult
  `loadA2Materials` before writing an A2 kind. `generate_map_layout` (`floorKind`,
  `surroundKind`) and `generate_interior` (`floorKind`) do not — so they will paint a
  transparent overlay across a whole floor and say nothing, which is the exact bug the
  classifier was written to prevent, at a much larger scale than one `fill_map_region` call.
  Their descriptions now warn; the code still does not check.
  *Done when:* those three arguments are checked the way `fill_map_region` checks, the refusal
  names the kind and the tileset, and `allowOverlayOnGround` exists as the deliberate override.
  *Done:* `src/core/ground-material.ts` is now the one place that decides, wired into all three
  plus `fill_map_region`. The task's premise was slightly off: `generate_town` consulted
  `loadA2Materials` for `roadKind` only, so **`groundKind` — the largest paint in the server —
  was unchecked too** and is now covered. Measured over the four RTP A2 sheets: **54 of 128
  kinds (42%) cannot go on layer 0**, and on `World_A2` only 8 of 32 can, which is why this is a
  refusal and not a note. Verified by PNG — an overlay floor forced through renders as a black
  dungeon with fence posts in it. See
  [One place decides](ROADMAP.md#one-place-decides-whether-a-material-can-go-on-the-ground).
  Turned up P5-31.

- [ ] **P5-31 — Refuse a material whose sheet the tileset does not have**
  *(turned up by P5-26.)* P5-26 covers A2, where the classifier can read the image. Nothing
  checks that a non-A2 kind has a sheet behind it at all. Of the 6 tilesets a new project ships,
  **`Overworld` has neither an A3 nor an A4 sheet, and `Inside`, `Dungeon` and `SF Inside` have
  no A3** — so `generate_map_layout` with `surroundKind: 98` on `Overworld` writes tile ids
  pointing at a sheet that is not there. Verified by PNG: the surround is simply absent, the map
  renders as an island of floor on nothing, and the tool reports *"Surround: A4 wall kind 98"*
  as a success. Same failure mode as the overlay bug, one family over, and cheaper to detect —
  it needs `tilesetNames[n] !== ''`, not an image.
  *Done when:* an autotile kind whose sheet is missing is refused, naming the kind, the sheet
  and the tileset, everywhere a kind can be passed.

## M2 — Make the generators compose

The pieces exist one level down; the generators just do not reach for them. This is the largest
visible payoff per unit of work in the whole backlog — it turns a correct but empty
architectural model into an inhabited place.

- [ ] **P5-04 — `generate_town` emits NPCs**
  `populate_map` is currently a separate pass over a finished map, so a generated town is
  complete and completely empty. Have the town planner place people as part of the plan, where it
  already knows what is street, what is plot and what is doorway — placement it can guarantee,
  rather than a second pass rediscovering it.
  *Done when:* one `generate_town` call yields a populated town, asserted across seeds, and no NPC
  stands on a door approach tile.

- [ ] **P5-05 — `generate_town` places a shop**
  `place_shop` needs a coordinate and `generate_town` builds the buildings; neither knows about
  the other, so a generated town has no merchant unless one is placed by hand. Pick a building,
  mark it as the shop, put the shopkeeper inside it (needs its interior — see P5-13) or at its
  door, and stock it from the project database the way `place_shop` already does.
  *Done when:* a generated town has a working shop reachable from the street.

- [ ] **P5-06 — Doors on a building's top edge**
  A door sits on the bottom wall row and is entered from the tile below
  ([blueprint.ts:302](src/core/blueprint.ts:302)). Three things bake this in: the sprite
  direction, the Set Movement Route that walks the player forward, and the approach tile. The
  consequence is that `generate_town` can only lay out *bands* — a row of buildings facing the
  street below — so the ground above every row is dead space. Add a top-edge door variant, then
  let the planner house both sides of a street.
  *Done when:* a building can be entered from above, and the town planner uses both.
  *Note:* the samples say 98 of 107 doors are on the bottom row, so bottom stays the default —
  this adds an option, it does not change the norm.

- [ ] **P5-27 — Generators mark their own regions**
  *(turned up by P5-02.)* `paint_regions` can write z=5, but every caller has to work out the
  coordinates itself — which is exactly the knowledge the generators already have and throw
  away. `generate_map_layout` knows which tiles are floor and which are surround,
  `generate_town` knows street from plot from doorway, and `lock_dungeon_floor` knows which
  side of the chokepoint is which. Each could mark its areas as it builds them.
  *Done when:* a generated map comes back with regions it did not have to be told about, and
  the ids it used are named in the result.
  *Note:* the other half of encounter zones is `encounterList`, which no tool writes at all —
  that belongs with P5-17, and until it exists a regioned map has nothing to gate.

## M3 — Shape (visual review finding 7)

The one finding that has never moved: **everything the generators emit is a rectangle**, while
hand-made maps have almost no straight material boundaries. Now measurable against the 293 sample
maps — do P5-07 first, and let it decide the shape of the three that follow.

- [ ] **P5-07 — Measure what hand-made shape actually looks like**
  A measurement task, no feature. Over `samplemaps/`: how long is a straight material run before
  it turns? How often is a roof footprint non-rectangular, and which inner-corner cells do
  L-shaped roofs use? How wide are streets and do they change width? Are interior rooms
  rectangular? Commit the numbers as a catalogue under `scripts/` the way
  `build-prop-catalogue.mjs` and `build-passage-catalogue.mjs` already do.
  *Done when:* there are counts to design P5-08…P5-10 against, recorded in ROADMAP.

- [ ] **P5-08 — L-shaped roofs and inner corners**
  `src/core/blueprint.ts` already catalogues each roof set's inner-corner pieces and nothing uses
  them, because footprints are rectangles. Accept a non-rectangular footprint, emit the corner
  cells, and keep the existing guards — the transparent-corner check and the sheet half-edge wrap
  refusal both still have to hold.
  *Done when:* an L-shaped building renders correctly, verified by PNG.

- [ ] **P5-09 — Ragged edges for ground materials**
  Ground patches are hard-edged rectangles. Give material boundaries controlled irregularity, and
  let roads bend and change width. The autotile shape computation already handles any silhouette;
  what is missing is a generator that produces one.
  *Done when:* a generated ground layer has no straight material runs longer than P5-07 says it
  should.

- [ ] **P5-10 — Rooms and blocks that are not boxes**
  Interior rooms are a single rectangle; town blocks are a grid; dungeon rooms are axis-aligned
  boxes. Apply P5-07's findings to all three. Connectivity must still be guaranteed *before*
  writing, which is the existing argument for corridors and cross-streets.
  *Done when:* rooms and blocks vary in shape across seeds and the walkability audit still
  reports one connected area.

## M4 — Content depth

- [ ] **P5-11 — A1 support: water and waterfalls**
  A1 is unsupported, so a generated map can have no water at all. Needs the third autotile table
  (`WATERFALL_AUTOTILE_TABLE`) alongside the floor and wall tables already ported, plus A1's
  animation frames.
  *Done when:* a lake and a waterfall can be painted and render correctly.

- [ ] **P5-12 — NPCs who say something worth reading**
  The wrapping machinery is good — `dialogueCommands` breaks on word boundaries and starts a new
  box every four lines because the engine measures text in pixels. What flows through it is a
  placeholder, identical for every NPC. Give dialogue that varies with where the NPC stands and
  what the map is, the way `src/core/vault.ts` generates an inscription from real placement.
  *Done when:* two NPCs in a generated town do not say the same thing, and long lines still wrap.

- [ ] **P5-13 — Interiors worth entering**
  A room is one rectangle varying only in furniture: no shop interiors, no upper floors. Stairs up
  would be `place_stairs`, which exists — nothing generates the floor above.
  *Done when:* an interior can be a shop or have a second storey.

- [ ] **P5-14 — Pillars in clumps**
  Single-tile pillars read as studs rather than rock formations. The obstacle is that the
  placement sweep's "cannot seal the map" guarantee is per-tile; a multi-tile clump has to be
  tested as a unit, so the sweep gets reworked.
  *Done when:* clumped pillars appear and `check_map_walkability` still reports one connected area.

- [ ] **P5-15 — Something for a cave mouth to sit in**
  The RTP entrance tile is doorway art drawn to sit against a cliff face. On the flat grass of a
  generated surface map it renders as a black rectangle in a field — the tile is correct and the
  cliff is missing. Generate the surround.
  *Done when:* an entrance placed on a generated surface map reads as an entrance in the PNG.

- [ ] **P5-16 — Something at the end of the dungeon**
  `link_dungeon_floors` deliberately leaves the deepest floor's far end clear and nothing ever
  fills it: no boss, no final lock, no set piece. Put the floor's climax there, reusing
  `lock_dungeon_floor`'s chokepoint reasoning.
  *Done when:* the deepest floor ends in something.

## M5 — Game logic

The pieces exist; nothing composes them. Nothing chains two steps, nothing tracks a quest as a
whole, no puzzle needs two flags, and there are no enemies anywhere.

- [ ] **P5-17 — Enemies and troops**
  Entirely absent. No troop placement, no encounter lists on generated maps, no enemy events.
  Measure what the sample maps and the user's projects do for encounter setup before designing.
  *Done when:* a generated dungeon has encounters appropriate to its depth.

- [ ] **P5-18 — More things that throw a flag**
  A lever is currently the *only* thing that sets a switch, so every gate in a generated dungeon
  opens by pulling a handle. Add at least: an NPC who throws it after a favour, a pressure plate,
  and a switch set by winning a battle (depends on P5-17).
  *Done when:* `lock_dungeon_floor` can choose among opener kinds.

- [ ] **P5-19 — Quest chains and quest state**
  One key opens one door and nothing tracks the whole. Add a multi-step quest — a chain where step
  two is only reachable after step one — and a representation of quest state that the consistency
  checker can validate for solvability.
  *Done when:* a two-step quest can be generated and proven winnable.

- [ ] **P5-20 — Puzzles that need more than one flag**
  Two levers that must both be on, or a sequence. Anything needing more than one flag is
  hand-assembly today and nothing checks such a combination is solvable.
  *Done when:* a multi-flag gate can be generated, with solvability enforced.

- [ ] **P5-21 — Sequence the locks on one floor**
  `lock_dungeon_floor` is one door per call. A floor with three good chokepoints gets locked three
  times with nothing reasoning about order — which is the difference between a locked floor and a
  dungeon that unfolds.
  *Done when:* one call locks a floor in a deliberate order.

- [ ] **P5-22 — Join one floor's fiction to the next**
  Each lock is themed independently, so a three-floor dungeon is a treasury, an armoury and a
  storeroom with nothing between them.
  *Done when:* a multi-floor dungeon reads as one place.

- [ ] **P5-23 — Doors between "always locked" and "never again"**
  `remember` is all or nothing: a door either forgets its lock forever after one opening or
  re-tests it every time. Nothing in between — no door that relocks.
  *Done when:* a door can relock on a condition.

- [ ] **P5-24 — Shops with more than one greeting**
  One page, one line, fixed stock, nothing gated behind a switch. The 302/605 command shape is
  settled from the engine; the depth around it is not.
  *Done when:* stock can change and a shop can be gated.

- [ ] **P5-25 — More rooms behind the locks**
  Five vault themes (treasury, armoury, storeroom, cell, crypt) are a hardcoded table of strings
  that do reach the loot table. A sixth is five more strings; nothing writes copy that fits *this
  project* rather than the genre.
  *Done when:* themes are extensible without editing a literal, or there are more of them.

---

## Also open, tracked but out of scope here

- The refusal on a locked door is one line of text — no guard, no hint where the key is.
- Custom tileset art gets no passage defaults, only `set_tileset_passage` tile by tile. Nothing
  infers passability from an image, and arguably nothing could.
- Shape 47 is never emitted; its role for A2 is unconfirmed.
- Caves are barely lockable — median best split 2.2%, a fact about the cave generator's blobby
  silhouette rather than about the locking tool. P5-09/P5-10 may move this.
