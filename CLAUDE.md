# rpgmaker-mz-mcp — working notes

An MCP server that edits RPG Maker MZ projects by writing their `data/*.json` files
directly. No plugin, no running game. 61 tools across [src/tools](src/tools), each backed by
a pure, unit-tested module in [src/core](src/core).

Current focus: **Phase 5 (procedural map generation)**. The ordered backlog is
[TASKS.md](TASKS.md) — that file is the source of truth for what to do next.
[ROADMAP.md](ROADMAP.md) is the long-form record of *why* each thing is the way it is.

## The method: measure, don't invent

This is the rule the whole repo is built on, and the reason its claims hold up.

Before asserting how something works, **count it in the corpus**. The roadmap's claims are
numbers, not impressions: the roof/wall `+8` pairing is 497 of 614 columns; the door page shape
is 60 of 107 pages; 81.6% of sample shadow tiles use bit pattern 5. When a sample is genuinely
too thin to settle a question, **say so in the code comment** rather than picking and sounding
confident — `src/core/shop.ts` opens by admitting it found only 4 shop pages on disk.

Distinguish three kinds of claim, and label them:

- **The engine's** — derived from corescript. Strongest. Cite the function (`Game_Map.checkPassage`).
- **Measured** — counted in sample maps or the user's projects. Give the count.
- **Stated** — a judgement nothing in the data settles (e.g. the loot price band). Mark it as such.

## Where ground truth lives

The MZ editor **is installed**, in a secondary Steam library:

```
M:/SteamLibrary/steamapps/common/RPG Maker MZ/
  samplemaps/        293 hand-made map JSONs (+ a PNG each) — the measurement corpus
  newdata/data/      reference database, incl. the Tilesets.json flags catalogue
  corescript/        v1.4.0 … v1.9.0 — engine source
```

The ROADMAP cites a v1.4.4 corescript path. Newer versions are on disk; check which version a
bit-layout claim was measured against before treating it as current.

Also available: the user's own projects at `M:/Projects/RPGMZ/` — `Wicked Heart` is the largest
(64 maps, 43 tileset PNGs with the editor's `.txt` tile-label files), `Foo` and `Learn` are
1-map scratch projects. Plus `M:/Projects/VisuMZ_Sample_Game_Project/`.

**Never write to the user's game projects.** Copy one into the scratchpad first.

## Architecture conventions

Every feature follows the same split, and new ones must too:

| Layer | Where | Rule |
|---|---|---|
| Logic | `src/core/<feature>.ts` | Pure functions. No file I/O. Unit-tested against the engine's formula, not a restatement of itself |
| Tool | `src/tools/<feature>-tools.ts` | Zod schema, argument validation, calls core, formats the result |
| Tests | `tests/core/<feature>.test.ts` | Test the pure module. Assert across multiple seeds where generation is involved |

Other standing rules:

- **Refuse rather than silently produce something broken.** `fill_map_region` refuses an overlay
  material on layer 0; `place_key_for_door` refuses a placement that makes the game unwinnable;
  `place_building` refuses a roof block that wraps the sheet's half-edge. The refusal names what
  was wrong.
- **Surface limitations in the tool's own output** instead of hiding them. A partial result that
  says what it could not determine beats a confident wrong one.
- **Seeded generation must be reproducible** — same seed, same map.
- **Anything that writes a map should leave it walkable.** `check_map_walkability` ports
  `Game_Map.checkPassage` / `Game_CharacterBase.canPass`; generators enforce connectivity before
  writing rather than auditing after.

## Verifying

Unit tests are necessary and not sufficient — phase 5 is visual, and several real bugs
(transparent-material holes especially) are invisible in a text grid.

```bash
npm test && npm run build
```

Then, for anything that changes what a map looks like:

1. Drive the **real server over stdio MCP** to build a map — not a test harness.
2. Render it: `node scripts/render-map.mjs` — ports `Tilemap` from `rmmz_core.js`, so the PNG
   is what the engine would draw.
3. Look at it. Change something. Render again.

When picking a test material, avoid a **seamless** one — its edge pieces look identical to its
middle pieces, so the render cannot reveal an error either way. In `Outside_A2` use kind 17, 18
or 19. Do not turn that into a column rule: across the four A2 sheets the RTP ships, no column
is opaque-and-outlined in all of them (`Outside_A2` 1–3, `Inside_A2` 3, `Dungeon_A2` 2–5,
`World_A2` 0 — intersection empty). Ask `describe_tileset_materials`, or re-run
`node scripts/measure-a2-columns.mjs`.

## Commit convention

One feature per commit. Message is `type: lowercase phrase describing the effect on the game`,
written for a reader who cares about the result, not the diff:

```
feat: give the locked door a reason to exist
feat: put the key to a door in a chest, and refuse to make the game unwinnable
fix: stop decorate_dungeon walling part of the map off
```

Each feature commit should carry: the core module, its tests, the tool wiring, the ROADMAP
section explaining the measurements behind it, and the TASKS.md checkbox ticked.

## Session workflow

Run `/continue` to pick up the next task from [TASKS.md](TASKS.md). It reads the backlog, does
the next unchecked item end to end, commits and pushes.
