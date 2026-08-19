# Phase 5 backlog

The ordered list of what is left in **procedural map generation**. One task ≈ one commit.
Work top to bottom; `/continue` takes the first unchecked box **of the plan**. Anything it finds
along the way goes to [Found while working](#found-while-working) at the end, not in front of the
task after it.

Scope is Phase 5 only. Phase 4's remaining database-integrity rules and the engine tier
(Phases 6–7) are deliberately out of scope here — see [ROADMAP.md](ROADMAP.md).

**Plan: 7 / 25.** The Phase 5 features this backlog was written for.

**Found while working: 15 / 16.** Defects turned up while doing the above, listed at the end.

Two numbers, not one: most commits so far went on defects rather than on the plan,
and a single combined figure hid that. The discovered list is a byproduct of the verification
CLAUDE.md demands — rendering the map and driving the real server — so it grows when the method
is working, and it should not be read as the plan slipping.

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

- [x] **P5-33 — Check that a troop exists before writing a battle**
  *(turned up by P5-32.)* `command301` only sets up the battle inside
  `if ($dataTroops[troopId])`, and the event callback is installed in the same block. So
  `battle_processing` with a troop id that is not in Troops.json is silent in **every** direction:
  no battle starts, `_branch[_indent]` is never set, and every win/escape/lose arm is skipped —
  the player walks through an ambush that does not happen and nothing reports a thing. Confirmed
  with `walkCommands`. Nothing in the server validates `troopId`; a new project ships **5**
  troops (`Wicked Heart` has 100), so an id picked without looking is easily past the end.
  *Done when:* a `battle_processing` naming a troop that does not exist is refused, saying how
  many the project has — and ideally troops can be named the way switches are (see P5-03).
  *Done:* `src/core/database-refs.ts` checks **all ten** databases `add_event_commands` can
  reach — troops, common events, items, weapons, armors, actors, classes, skills, states and
  every row of a shop's goods — because the engine's guard-then-do-nothing habit is the same at
  each. `troopName` matches Troops.json and an unknown name is **refused, not allocated**: a
  troop is content, not a slot. Measured: **13 of Wicked Heart's 100 troop rows are named, and
  the split is exactly whether the row is real — 13 named all have members, 87 unnamed all have
  zero, neither diagonal populated.** That turned into a second check: an empty troop is truthy,
  so the battle starts and `isAllDead()` is true on the first frame — a battle won before it
  begins, now refused. Actor id 0 is left alone on the seven commands that reach
  `iterateActorId`, where it means the whole party. See
  [The engine guards, then does nothing](ROADMAP.md#the-engine-guards-then-does-nothing).
  Turned up P5-34.

- [x] **P5-34 — Check the references the map itself carries**
  *(turned up by P5-33.)* P5-33 covers the ten databases reachable from `add_event_commands`.
  The same guard-then-do-nothing shape sits outside it and is unchecked: a `transfer_player` to
  a map id with no `MapXXX.json`, a page image naming a character sheet that is not in
  `img/characters`, a map's `tilesetId` past the end of Tilesets.json, and `battle_processing`'s
  designation 1 (troop from a variable) and 2 (same as random encounters), which the converter
  cannot emit at all — it hardcodes designation 0, matching 13 of 13 in the corpus, but
  designation 2 is what an encounter-driven battle needs and belongs with P5-17.
  *Done when:* a transfer to a map that does not exist is refused, and the other three are
  either checked or explicitly recorded as out of reach.
  *Done:* `src/core/map-refs.ts` checks all three, and the premise turned out to be half right —
  only the tileset fails the guard-then-do-nothing way. The other two **throw**: a missing map
  file 404s into `DataManager._errors` and the next `isMapLoaded()` throws a LoadError, and a
  missing character sheet makes `ImageManager.isReady` throw, which fails the *whole map* on
  arrival rather than one event. The tileset is the silent one — `tilesetFlags()` returns `[]`
  and `checkPassage` then takes its "[o] Passable" branch on every tile, so the map is invisible
  and walkable everywhere; asserted with a port of `checkPassage`, not described. Measured with
  the new `scripts/measure-map-refs.mjs`: **all 108 of `Wicked Heart`'s transfers resolve, all
  658 of samplemaps' do, and all 45 distinct sheet names across 1878 image-bearing pages are on
  disk** — a dangling reference appears nowhere in 357 hand-made maps. Two things came out of the
  work: the target map's size is two numbers away once it is known to exist, so a transfer
  landing off the edge (where `locate()` has no bounds check and `canPass` then freezes the
  player) is refused too; and `create_map` was duplicating `createMapFile` inline, so it kept
  writing unchecked maps until it was routed through it. Sheet checking is one loader shared by
  ten tools. Designation 1/2 recorded as out of reach — see P5-35. See
  [What the map points at](ROADMAP.md#what-the-map-points-at). Turned up P5-35 and P5-36.

- [x] **P5-35 — Emit the battle and transfer designations**
  *(turned up by P5-34.)* `convertCommand` hardcodes `params[0] = 0` on both `301` and `201`, so
  the two variable-driven forms cannot be written at all. `command301` designation 1 reads the
  troop id from a variable and 2 calls `$gamePlayer.makeEncounterTroopId()`; `command201`
  designation 1 reads map, x and y from three variables. The corpus never uses either — 0 of 13
  battles and 0 of 766 transfers — so nothing is broken today, but **designation 2 is what an
  encounter-driven battle needs**, which makes this a dependency of P5-17 rather than a papercut.
  *Done when:* a battle can be "same as random encounters" and a transfer can take its
  destination from variables, with the variable ids resolvable by name the way P5-03 does it.
  *Done:* `src/core/designation.ts` is the one place that knows which source a command names.
  A battle takes `troopId`/`troopName`, `troopVariableId`/`troopVariableName`, or
  `sameAsRandomEncounter` — exactly one, since the others would be written and never read; a
  transfer takes `mapId`/`x`/`y` or all three `*VariableId`s, because **the engine has one
  designation flag covering all three numbers** and a partial set is refused. Widened the sweep
  from P5-34's five projects to **44 data directories, 926 maps: 0 use designation 1 or 2, all
  926 ship `encounterList: []` and `encounterStep: 30`, and 1 of the 361 maps in the seven named
  projects paints a single region tile** (`scripts/measure-encounters.mjs`). That last figure is
  why designation 2 is **refused** on a map whose table cannot produce a troop —
  `makeEncounterTroopId` returns 0, which is not a row, so it is P5-33's silent nothing all over
  again. The region plane from P5-02 is finally load-bearing: a row gated on an unpainted
  `regionSet` can never fire, and one `paint_regions` call turns the refusal into an acceptance.
  Three things the work turned up: `database-refs.ts` was checking a `troopId` the engine would
  never read, `map-refs.ts` was resolving a dynamic transfer against map 1, and `describe_event`
  reported *"troop 1"* for a battle that names no troop — all three now read the designation. See
  [Designation is a fork in the engine](ROADMAP.md#designation-is-a-fork-in-the-engine).
  Turned up P5-37.

- [x] **P5-37 — Write a map's encounter table**
  *(turned up by P5-35.)* Nothing in the server writes `encounterList` or `encounterStep`, so
  designation 2 is reachable only on a map somebody set up in the editor — **0 of 926 maps on
  this machine have a single row**. The shape is settled and small: `{ troopId, weight,
  regionSet }`, picked by weight, filtered by `meetsEncounterConditions`, stepped by
  `encounterStep` through `makeEncounterCount`. The reasoning that has to come with it is not
  small, which is why this is P5-17's and not a five-line tool: which troops suit a floor's
  depth, what weights mean next to each other, and whether the zones are regions or the whole
  map. `checkEncounterSource` already knows how to say a table is unusable, so the writer has a
  validator waiting for it.
  *Done when:* a generated map can come back with encounters that `check_map_walkability`'s
  player would actually meet, and `paint_regions` can scope them.
  *Done:* `set_map_encounters` and `get_map_encounters`, over `src/core/encounters.ts`. Widened
  the sweep again with `scripts/measure-troops.mjs` — **64 data directories, 1219 maps, 0 with a
  single `encounterList` row**; `encounterStep` is 30 on 1217 and 31 on exactly two, both of
  which *still* have an empty list, so the field has been nudged here and never once paired with
  a table. The reasoning the task predicted would be large landed in one place: **weight is not a
  percentage.** `regionSet` filters the list before `weightSum` is summed, and the filter runs
  against the region under the *player*, so an empty-`regionSet` row competes inside every region
  too and the denominator changes as the player walks. The tool therefore reports one probability
  table **per zone** rather than one percentage per row. Reachability is the other half: a region
  painted on walls or on floor walled off from the start gates a row exactly as hard as an
  unpainted one, so `reachableGrid` was split out of `analyseWalkability` and a scoped row is
  refused unless the player can stand in it. Third refusal is the empty troop — **459 troop rows
  on this machine, only 173 (37.7%) have a member**, and an empty one is a battle won on the
  first frame. `checkEncounterSource` now takes the reachable set rather than the painted one.
  See [Weight means nothing on its own](ROADMAP.md#weight-means-nothing-on-its-own).
  Turned up P5-38.

- [x] **P5-38 — Let the encounter check be told where the player arrives**
  *(turned up by P5-37.)* `checkEncounterSource`, reached through `add_event_commands`, has no
  start argument, so `reachableRegions` falls back to the largest walkable area — the exact
  assumption `analyseWalkability`'s own docs call wrong on an interior, where a room's passable
  wall tops out-number the room. A `sameAsRandomEncounter` battle inside a small room can
  therefore be refused for a region that is perfectly reachable from where the player really
  starts. `set_map_encounters` already takes `startX`/`startY`; the event path does not.
  *Done when:* the battle-side check can be given a start, and agrees with `set_map_encounters`
  when both are given the same one.
  *Done:* `add_event_commands` takes `startX`/`startY`, and — more usefully — nothing has to pass
  them, because `src/core/arrival.ts` derives the arrival tiles from the project: every literal
  Transfer Player aimed at the map, plus `System.json`'s new game position. `reachableFromAny`
  unions the areas they land in from one area survey, since a map is entered from more than one
  door. The new `scripts/measure-arrival.mjs` turned the old assumption from an argument into a
  count: over the **677 maps with real passage flags, 619 (91.4%) have more than one walkable
  area**, **159 are transferred into with 394 arrival points**, and **36 of those (9.1%), on 20
  maps, land outside the largest area** — `Wicked Heart` map 25 is 627 tiles against 65, map 59
  is 516 against 11. Events are not a usable stand-in: 992 of the 1278 events outside the largest
  area stand on impassable tiles, because doors and clutter are events. The two checks now agree
  — given the same start on map 8, `set_map_encounters` and `add_event_commands` both see region
  9's 6 reachable tiles and the battle side reports `2 of 2 row(s) can be picked` where it used
  to say `1 of 2`. Since a derived arrival can be badly restrictive when a map is broken,
  `describeArrival` warns when it reaches under half the largest area, and a caller-given start
  gets the comparison without the diagnosis. See
  [The largest area is not where the player is](ROADMAP.md#the-largest-area-is-not-where-the-player-is).
  Turned up P5-39.

- [x] **P5-39 — Refuse a transfer the player can never walk out of**
  *(turned up by P5-38.)* The arrival sweep found `Wicked Heart` map 32 carrying
  `201 [0,59,0,49,0,0]` — a transfer to map 59 at (0, 49). That tile is passable down, left and
  up but **not right**, so `Game_CharacterBase.canPass` blocks every attempt to leave column 0
  and the player can walk 11 tiles of a 13x50 map. This is a third class: P5-34 checks the
  landing square is inside the map, P5-36 will check it can be stood on, and neither catches a
  tile you can stand on and never leave. `reachableFromAny` already computes the answer — the
  area the landing tile reaches — so this is a threshold and a message, not new reasoning. The
  hard part is what the threshold should be, and the corpus has 36 outside-largest arrivals to
  calibrate against.
  *Done when:* a transfer whose landing tile reaches only a fraction of the target map is
  refused or warned about, saying how many tiles the player would be able to walk.
  *Done:* `reachableFromLanding` (`src/core/walkability.ts`) reduces the existing flood to two
  numbers — the landing tile's area, against the map's largest — and `requireTransferTarget`
  (`src/core/map-refs.ts`) refuses under `TRAPPED_LANDING_RATIO`. Widened
  `scripts/measure-arrival.mjs`'s calibration data to all 36 outside-largest arrivals (19
  distinct landings across 44 data directories) and it splits cleanly: 13 reach 0.4%-16.9% of
  the largest area, the other 6 reach 66.7%-96.9% — a 4x gap with nothing in it, so
  `TRAPPED_LANDING_RATIO = 0.25` sits in the gap rather than on either cluster. Refused rather
  than warned, matching the two sibling checks already in the same function. `loadMapReach`
  (`src/tools/map-ref-loaders.ts`) reads the target's map data and tileset flags, degrading to
  unchecked the same way `loadMapSizes` does. Verified against real files written to disk and
  read back through the built `dist/`, not just a hand-built inventory. See
  [A landing tile you can stand on and never leave](ROADMAP.md#a-landing-tile-you-can-stand-on-and-never-leave).

- [x] **P5-36 — Refuse a transfer that lands somewhere the player cannot stand**
  *(turned up by P5-34.)* P5-34 checks the landing square is *inside* the target map, which is
  the half that needs only its width and height. The other half is passability: `locate()` will
  put the player inside a wall, and if that tile is impassable in all four directions
  `Game_CharacterBase.canPass` is false every way and they are frozen exactly as if they had
  landed off the map. `check_map_walkability` already ports the rule, so this is reuse rather
  than new reasoning — it needs the target's tileset flags, which the current check deliberately
  does not read.
  *Done when:* a transfer onto an unstandable tile is refused or warned about, saying which.
  *Note:* P5-38 measured the population — **24 of the 394 arrival points on this machine land on
  a tile the player cannot stand on**, so this is not hypothetical. The neighbouring class, a
  tile they can stand on but never leave, is P5-39.
  *Done:* a second branch in `requireWalkableLanding` (`src/core/map-refs.ts`), reusing P5-39's
  `reachableFromLanding` result rather than a new flood — its `standable` field is exactly
  `!readTile(...).isWall`. Refused, matching the sibling checks. Runs after the bounds check
  (P5-34) and before the pocket-ratio check (P5-39), so a bad transfer gets exactly one refusal,
  in the order the engine would actually hit the failures. Verified end to end the same way as
  P5-39: a real 10x6 room written to disk, read back through the built `dist/`, accepts a floor
  landing and refuses the wall corner (0, 0). See
  [A landing tile you cannot stand on at all](ROADMAP.md#a-landing-tile-you-cannot-stand-on-at-all).

- [x] **P5-29 — Write page conditions**
  *(turned up by P5-03.)* Switch page conditions are the **most common** way real event logic
  gates itself — 62 uses in `Wicked Heart`, against 43 Control Switches and 23 conditional
  branches — and no tool writes one. `create_event` and `update_event` do not touch
  `page.conditions` at all; only the generators that build their own pages (`lever.ts`,
  `locked-door.ts`, `vault.ts`) ever set one. A caller can set a switch but cannot make anything
  respond to it.
  *Done when:* a page's switch / variable / self-switch / item / actor conditions can be set,
  by name where the flag has one, and `describe_event` reads them back.
  *Done:* `resolvePageConditions` (`src/core/command-flags.ts`) reuses the same `resolveOne`
  allocator `resolveCommandFlags` runs for commands, since a page condition names the same kind
  of flag; `requirePageConditionRefs` (`src/core/database-refs.ts`) checks `itemId`/`actorId`
  the same guard-then-do-nothing way `checkDatabaseRefs` already does. `update_event` gained
  `pageIndex` (append a new page by giving the next index — `findProperPageIndex` scans pages
  backwards, so a conditioned page has to follow its fallback) and `trigger`, and routed the
  previously page-0-only `characterName`/`characterIndex` through it too. `describe_event`
  needed no changes — `describePageConditions` already rendered all six kinds. Verified end to
  end over stdio MCP: a named switch allocated once and reused on a second page, a self-switch
  added, and an unknown `itemId` refused naming Items.json rather than silently writing a dead
  condition. See
  [Making a page respond to a flag](ROADMAP.md#making-a-page-respond-to-a-flag).

- [x] **P5-30 — Fix the random operand on `control_variables`**
  *(turned up by P5-03.)* `convertCommand` emits 5 parameters for code 122. `command122`
  operand 2 (Random) reads `params[5]` as the top of the range: `randomMax = params[5] -
  params[4] + 1` is `NaN`, `Math.max(NaN, 1)` is `NaN`, and the variable is set to `NaN`. Same
  class of bug as the conditional branch P5-03 fixed, in the same converter.
  *Done when:* a random assignment emits the range top, and operands 3 (game data) and 4
  (script) either work or are refused by name.
  *Done:* `controlVariableOperand` (`src/schemas/event.ts`) gives every operand its own field(s)
  — `sourceVariableId` (1 Variable), `value`/`randomMax` (2 Random), `gameDataType`/
  `gameDataParam1`/`gameDataParam2` (3 Game Data), `script` (4 Script) — and refuses by name,
  citing the exact engine computation, when a required one is missing. An operand outside 0-4 is
  refused too, since the engine's `value` silently stays `0` for an unmatched case. Verified
  over stdio MCP: Random wrote the full six-parameter shape (`randomMax` computed as `6`, not
  `NaN`), Game Data and Script wrote their seven/five-parameter shapes, and the same Random
  command with `randomMax` left off was refused before anything was written. See
  [Every control_variables operand gets its own field](ROADMAP.md#every-control_variables-operand-gets-its-own-field).

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

- [x] **P5-31 — Refuse a material whose sheet the tileset does not have**
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
  *Done:* `src/core/tileset-sheets.ts` is the one place that decides, wired into
  `fill_map_region` (kind *and* raw tileId), `paint_tiles`, `generate_map_layout`,
  `generate_town`, `generate_interior` and `place_building`. The slot mapping is the engine's,
  ported from `Tilemap._addAutotile` / `_addNormalTile` (v1.9.0). The task's premise held and
  understated it: `Overworld` also has no **A5**, and **all six** shipped tilesets lack D and E,
  so raw tile ids were exposed too — hence the tileId check. Across the user's 22 tilesets
  **A3 is empty in 16, D in 19, E in 20**. Of 293 sample maps, 292 write only to slots their
  tileset fills, and 0 of their 441,000 tiles fall in the unaddressable 1024-1535 band. No
  override flag, deliberately: unlike an overlay, a tile from an absent sheet can never draw
  anything. Verified by PNG both ways — the `Overworld` + kind 98 render is an island of floor
  on black; the same seed on `Dungeon` is the dungeon the caller meant. Read-filter `floorKind`
  arguments (`decorate_dungeon`, `place_dungeon_stairs`) are deliberately not checked, and props
  were already safe via `collectProps`. See [A sheet that is not there](ROADMAP.md#a-sheet-that-is-not-there).
  Turned up P5-40.

- [x] **P5-40 — A town with no buildings should not report success**
  *(turned up by P5-31.)* `generate_town` collects per-building `BuildingPlacementError`s into a
  `failures` list and reports the call as a success regardless of how many landed — measured
  with `roofKinds: [120]` on `Dungeon`, which derives an out-of-family wall kind: every building
  was refused, the tool printed *"Buildings: 0 of 2 planned"* and returned no error, having
  written a map of bare ground and props. The refusals themselves are good; treating a town with
  nothing in it as a completed town is not.
  *Done when:* a town where no building was placed is a refusal that names why the first one
  failed, and a partial placement says plainly how many were lost. Decide and state whether the
  map should still be written when the count is 0.
  *Done:* `assessTownBuild` in `src/core/towngen.ts`, called **before the props pass and before
  the only write**, so a refusal leaves the map untouched — verified over MCP with a marker tile
  and marker event that both survive a refused run, where before it wrote 660 tiles of ground and
  cleared the events. Two zero cases, separated because they have different causes. **Nothing
  planned** turned out to be a narrow window: measured over 4356 accepted plans (widths 17-60,
  heights 13-45, 3 seeds, at `TOWN_DEFAULTS`), a plan yields no building at **width 22 in 93 of
  93, widths 23 and 24 in 31 of 93 each, and never from 25 up**; the same plans place a median of
  8 and at most 25. **Everything refused** quotes the first reason, justified by counting the
  refusal sites: **6 of the 8 are argument-driven, and the 2 plot-driven ones cannot fire from
  `generate_town`** — `planTown` only emits in-bounds rects, and the ground is filled before the
  first building. Partial placement stays a success with the loss on the buildings line. See
  [A town with no buildings in it](ROADMAP.md#a-town-with-no-buildings-in-it).

## M2 — Make the generators compose

The pieces exist one level down; the generators just do not reach for them. This is the largest
visible payoff per unit of work in the whole backlog — it turns a correct but empty
architectural model into an inhabited place.

- [x] **P5-04 — `generate_town` emits NPCs**
  `populate_map` is currently a separate pass over a finished map, so a generated town is
  complete and completely empty. Have the town planner place people as part of the plan, where it
  already knows what is street, what is plot and what is doorway — placement it can guarantee,
  rather than a second pass rediscovering it.
  *Done when:* one `generate_town` call yields a populated town, asserted across seeds, and no NPC
  stands on a door approach tile.
  *Done:* `planTownPeople` in `src/core/towngen.ts` derives the standable candidates and the
  blocked approach tiles straight from the plan — `building.door.approach` was already there and
  nothing had ever read it. `planNpcPlacement` grew an `allow` option that narrows *candidates*
  only, leaving the connectivity flood over the whole map, since standing on an allowed tile can
  seal off a disallowed one. **The count is flat, not a density, and that is measured:** over the
  26 populated maps of `Wicked Heart`, map area and NPC count correlate at **r = 0.09**, and the
  two most crowded maps are the smallest (7 NPCs on 17x13 = 3.17 per 100, against 4 on 40x30 =
  0.33). Default 6, at the top of the measured range (median 2, max 7). The sample corpus settles
  nothing — **4 NPC events across 293 maps** — so every number is labelled as one project's habit;
  it does confirm the existing page defaults (52 of 63 fixed movement, 45 of 63 Action Button).
  Verified over MCP across 4 seeds and 4 sizes, 46 NPCs in 5 towns: **0 on a door or approach
  tile, 0 under a roof or prop, 0 stacked**, and a fresh town is 1133 standable in 1 connected
  area. See [Somebody to talk to](ROADMAP.md#somebody-to-talk-to). Turned up P5-41.

- [x] **P5-41 — Regenerating a map should not leave the last one's debris**
  *(turned up by P5-04.)* `generate_town` says *"The map is replaced — its existing tiles and
  events both go"*, and that is true only of layer 0. Roofs on layer 2, props on layer 1 (where
  `applyPlacements` runs with `skipOccupied`, so new props will not even overwrite old ones) and
  the shadow plane at z=4 all survive a regeneration. Measured on one map: regenerated four
  times it reports **1037 standable with a 7-tile isolated pocket and 0 new shadows**, against
  **1133 standable, no pocket and 20 shadows** on a fresh map with the identical seed and
  arguments — 96 tiles of debris. Caught by a render, where a villager was standing on a roof
  left by a previous run; invisible in every text grid and in the walkability numbers taken on
  their own. `generate_map_layout` has the same shape — it rewrites only the chosen layer and
  already warns about stale tiles rather than clearing them — so decide once whether a generator
  clears the whole map or says plainly that it does not.
  *Done when:* a regenerated map is identical to the same generation on a fresh map, or the tool
  refuses and names what it would have left behind.
  *Done:* `src/core/map-reset.ts` is the one place that decides, but the decision is deliberately
  **not** the same for all three, because their contracts differ. `generate_town` now clears all
  six planes by default — its description already promised that, so the code was made to match
  the promise rather than the other way round — with `keepExistingTiles` for laying a town over
  hand-painted terrain, and the result then names what it kept, by plane. `generate_map_layout`
  keeps its "replaces the chosen layer" default, which is honest, but its old tally walked z 0-3
  only and so silently omitted the shadow and region planes; it now uses the shared census and
  gained `clearOtherLayers`. `generate_interior` is unchanged and routes through the same
  `clearMap`. The measurement that mattered: props are written with `skipOccupied`, so a stale
  prop **displaces** the new one rather than sitting beside it — at (12, 12) the regenerated map
  kept tile 141 where the fresh town put 144. **Verified against the done-when exactly: 0
  differing cells of 8976** (was 141), whole tile array identical, 16 events matching. By PNG a
  third generation over two previous towns is indistinguishable from a fresh one, 1112 standable
  all in one connected area. See
  [What the last generation left behind](ROADMAP.md#what-the-last-generation-left-behind).
  Turned up P5-42.

- [x] **P5-05 — `generate_town` places a shop**
  `place_shop` needs a coordinate and `generate_town` builds the buildings; neither knows about
  the other, so a generated town has no merchant unless one is placed by hand. Pick a building,
  mark it as the shop, put the shopkeeper inside it (needs its interior — see P5-13) or at its
  door, and stock it from the project database the way `place_shop` already does.
  *Done when:* a generated town has a working shop reachable from the street.
  *Done:* `planTownShop` in `src/core/towngen.ts`, feeding `planNpcPlacement` with `count: 1` so
  the keeper inherits the same connectivity guarantee as every villager, and placed *before* the
  townsfolk so none of them can take its tile. Stock comes from `loadPresetStock`, now shared
  with `place_shop` so both phrase an empty database the same way. **The corpus turned out to
  settle even less than the shop module already warned:** the "4 shop pages" are 4 pages of *one
  event*, on an **interior** map, carrying **no sprite at all** — the visible character is a
  separate Barkeeper event above it, and the 293 sample maps have no shop. So both placement
  rules are marked as stated judgements: the building nearest the map centre, and beside the door
  approach rather than on it — on it, the keeper would block the door of its own shop. Verified
  over MCP: keeper at (18, 19) beside the 7x4 building at (18, 15), 6 rows of real stock, page
  written as `101,401,302,605×5` with the 302 carrying the first goods row `[0,13,0,0,false]` as
  `command302` reads it, the door's approach tile **(19, 19) left free**, 3 standable neighbours
  to talk from, 1133 standable in one connected area. See
  [Somewhere to spend the money](ROADMAP.md#somewhere-to-spend-the-money).

- [x] **P5-06 — Doors on a building's top edge**
  A door sits on the bottom wall row and is entered from the tile below
  ([blueprint.ts:302](src/core/blueprint.ts:302)). Three things bake this in: the sprite
  direction, the Set Movement Route that walks the player forward, and the approach tile. The
  consequence is that `generate_town` can only lay out *bands* — a row of buildings facing the
  street below — so the ground above every row is dead space. Add a top-edge door variant, then
  let the planner house both sides of a street.
  *Done when:* a building can be entered from above, and the town planner uses both.
  *Note:* the samples say 98 of 107 doors are on the bottom row, so bottom stays the default —
  this adds an option, it does not change the norm.
  *Done:* `doorSide` on `planBuilding`, `bothSidesOfStreet` on `planTown`. **Two of the three
  things the task names were not baked in at all**, checked against `rmmz_objects.js` v1.9.0:
  `ROUTE_TURN_LEFT/RIGHT/UP` are `setDirection(4|6|8)`, so the door's four "directions" are the
  four rows of `!Door1` — closed through open — and play the same animation from any side; and
  `moveForward` is `moveStraight(this.direction())`, the *player's* facing, which already points
  into the door. Only the approach tile was. The real constraint is that a door must stand on
  **wall**, so `doorSide` moves the wall band to the door's edge.
  The new `scripts/measure-door-sides.mjs` sharpens the note above by asking which side the
  player stands on rather than where the tile is: of 107 door events, the **88 with exactly one
  open approach are approached from below in 88 of 88** — **0** from the north. A **fourth**
  place held the assumption and only the render found it: `analyseWalkability` checked `y + 1`
  only and called all four north-facing doors unreachable when each opened onto a road; it now
  accepts any neighbour, and the two rules **flag the same 19 of 107 corpus doors, disagreeing on
  0**. Verified over MCP at 44x46 seed 7: **8 buildings single-sided against 12 two-sided**,
  every door onto a street, 1573 standable in one connected area, no unreachable door.
  **Ships off by default, on the render rather than the numbers** — the wall band has to go above
  the roof, the RTP roof sets are directional art, and the wall's footing course and drop shadow
  draw over the roof, so it reads as a wall in front of a roof, not a house. The ASCII layout,
  the coordinates and the walkability were all perfect; only the PNG showed it. The default town
  is untouched, byte-for-byte 16 buildings and 1493 standable. See
  [The side a door is entered from](ROADMAP.md#the-side-a-door-is-entered-from).

## M3 — Shape (visual review finding 7)

The one finding that has never moved: **everything the generators emit is a rectangle**, while
hand-made maps have almost no straight material boundaries. Now measurable against the 293 sample
maps — do P5-07 first, and let it decide the shape of the three that follow.

- [x] **P5-07 — Measure what hand-made shape actually looks like**
  A measurement task, no feature. Over `samplemaps/`: how long is a straight material run before
  it turns? How often is a roof footprint non-rectangular, and which inner-corner cells do
  L-shaped roofs use? How wide are streets and do they change width? Are interior rooms
  rectangular? Commit the numbers as a catalogue under `scripts/` the way
  `build-prop-catalogue.mjs` and `build-passage-catalogue.mjs` already do.
  *Done when:* there are counts to design P5-08…P5-10 against, recorded in ROADMAP.
  *Done:* `scripts/measure-map-shape.mjs`. It takes a directory, so the instrument that measures
  the 293 sample maps also measures a generated project — which is how finding 7 finally got a
  number. **Hand-made boundary runs: median 1, p90 3, p99 9, and 70.5% of all runs are a single
  tile. A generated town: median 4, p99 19, with 84.1% of its boundary length in runs of 4+
  against 30.9% by hand.** P5-09's threshold is the corpus p99: a run longer than **9** is
  something under 1% of hand-made runs do.
  **Rectangularity collapses with size** — 48.2% of 8-15 tile regions are rectangles, but **5 of
  334 regions of 128+ tiles**, which is the band a generator emits into. Interiors are the same
  story, not a special case: 25.3% of 562 floor regions across 139 Inside maps.
  **Roofs needed a seam test to be countable at all**: two buildings sharing an edge and a roof
  material flood-fill into one component. Of 94 nine-slice components 72 are merged buildings;
  of the **22 that are one coherent roof, 4 (18.2%) are not rectangles**. A3 autotile roofs: 78
  of 103 rectangular. **The inner-corner rule is settled and clean — `innerCorners[0]` fills a
  missing down-LEFT diagonal, `innerCorners[1]` a missing down-RIGHT, 14 uses out of 14 with no
  counterexample across all four sets** — but only **26 concave corners exist in 293 maps**, and
  46.2% of those were filled with a plain edge tile anyway, so P5-08 should treat the sample as
  thin. No dedicated piece is ever used for a missing *up* corner. Roofs are identified from the
  editor's own `Roof …` tile labels, not from structure, because the C sheets also hold towers
  and monuments a structural test reads as roofs. See
  [The shape of a hand-made map](ROADMAP.md#the-shape-of-a-hand-made-map).

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

---

## Found while working

Defects and gaps turned up *while doing something else*, kept apart from the planned work
above so that one number does not hide the other. `/continue` drains the plan first and only
takes from here when a task above is blocked by one of these, or when you ask for it by id.

The bar for landing here rather than in a ROADMAP paragraph: **a player would notice, or a
caller would be misled.** Everything smaller is written up where it was measured and left
there — see [What the last generation left behind](ROADMAP.md#what-the-last-generation-left-behind)
for one that was deliberately not filed.

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
