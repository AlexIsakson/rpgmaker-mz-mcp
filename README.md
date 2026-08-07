# 🎮 RPG Maker MZ MCP Server

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js)](https://nodejs.org)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.26.0-orange)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/Tests-167%20passed-brightgreen)]()

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
| Unit & integration tests (42 tests) | ✅ | ❌ |
| MCP SDK v1.26+ | ✅ | ❌ |
| Event editing with human-readable commands | ✅ | Partial |
| AI scenario generation tools | ✅ | ❌ |

---

> **This is a fork** of [a951753abc/rpgmaker-mz-mcp](https://github.com/a951753abc/rpgmaker-mz-mcp),
> extended with map/project *understanding* tools on top of the original's data editing.
> See [ROADMAP.md](ROADMAP.md) for what's planned. Licensed GPL-3.0, same as upstream.

---

## 🛠 Available Tools (33 total)

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

### Map Management (16)
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
| `generate_map_layout` | Fill a map with a generated dungeon or cave layout |
| `apply_wall_shadows` | Write the shadow plane the editor's auto-shadow produces |
| `check_map_walkability` | Traverse the map — unreachable NPCs, blocked doors, cut-off areas |
| `describe_tileset_materials` | Which A2 materials are safe on layer 0, and which have a visible outline |

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

`apply_wall_shadows` writes the shadow plane (z=4), which `fill_map_region` cannot reach. The
rule comes from the 293 sample maps shipped with the editor: 285 of them use shadows, and of
their 16,829 shadow tiles 81.6% carry the value `5` while 83.7% sit immediately right of a
wall. So every non-wall tile with an A3/A4 tile to its left gets its left half darkened.
Without it, buildings read as flat cut-outs pasted onto the ground.

`check_map_walkability` answers the question a tile-by-tile view cannot: **can the player
actually get there?** It floods the map following `Game_CharacterBase.canPass` and reports
NPCs standing in walls, NPCs sealed inside buildings, doors with no reachable tile in front of
them, and areas cut off from the rest of the map.

```
Walkability — 40x30
  Standable tiles: 832 of 1200
  Largest connected area: 832 (from 0, 0)

No unreachable events, blocked doors or cut-off areas.
```

`generate_map_layout` builds a whole map at once — `dungeon` places rooms joined by L-shaped
corridors, `cave` grows an organic cavern by cellular automata. Both are **guaranteed fully
connected**: the dungeon connects each room to the previous one as it goes, and the cave keeps
only its largest region so there are no sealed-off pockets. The same `seed` always reproduces
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
| `switch-read-never-written` | warning | A condition that can never change |
| `variable-read-never-written` | warning | A variable that will always be 0 |
| `unreachable-map` | warning | A map with no route from the start map |
| `tileset-passage-unconfigured` | warning | Tileset passage never set up, so ground-layer walls don't block |
| `switch-written-never-read` | info | A dead write |

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
git clone https://github.com/a951753abc/rpgmaker-mz-mcp.git
cd rpgmaker-mz-mcp

# Install dependencies
npm install

# Build
npm run build

# Verify (42 tests should pass)
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
│   ├── tileset-reader.ts       # Tileset passability flag loading
│   ├── map-grid.ts             # Tile decoding + ASCII grid rendering
│   ├── event-flow.ts           # Command-code decoding + reference collection
│   ├── map-graph.ts            # Transfer graph + reachability analysis
│   ├── consistency.ts          # Project-wide static consistency rules
│   ├── autotile.ts             # Floor autotile shape computation
│   ├── map-layers.ts           # Tile layer read/write over the flat data array
│   ├── mapgen.ts               # Dungeon / cave layout generation
│   └── version-sync.ts         # System.json versionId auto-sync
├── schemas/
│   ├── database.ts             # Zod schemas for 8 entity types
│   ├── map.ts                  # Map & audio schemas
│   ├── event.ts                # Event & command schemas + converter
│   ├── tileset.ts              # Tilesets.json schema
│   └── system.ts               # System.json schema
├── tools/
│   ├── project-tools.ts        # 4 project management tools
│   ├── database-tools.ts       # 6 database CRUD tools
│   ├── map-tools.ts            # 5 map management tools
│   ├── map-grid-tools.ts       # 1 spatial/grid analysis tool
│   ├── map-graph-tools.ts      # 1 map connection graph tool
│   ├── map-paint-tools.ts      # 1 tile painting tool
│   ├── mapgen-tools.ts         # 1 layout generation tool
│   ├── event-tools.ts          # 5 event editing tools
│   ├── event-flow-tools.ts     # 2 event flow analysis tools
│   ├── consistency-tools.ts    # 1 project consistency checker
│   └── scenario-tools.ts       # 3 AI scenario tools
└── templates/
    └── defaults.ts             # RPG Maker MZ default data templates
```

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

That's it. Just 2 runtime dependencies.

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

### 可用工具（共 30 個）

| 類別 | 工具數 | 說明 |
|------|:---:|------|
| 專案管理 | 4 | 載入 / 建立 / 查詢專案資訊 / 列出素材資源 |
| 資料庫 CRUD | 6 | 列出 / 取得 / 新增 / 更新 / 刪除 / 搜尋（支援角色、職業、技能、道具、武器、防具、敵人、狀態） |
| 地圖管理 | 9 | 列出 / 建立 / 查看 / 更新 / 刪除地圖 / 以文字網格呈現地圖（牆壁、梯子、事件位置等空間資訊）/ 地圖連線圖（單向通道、無法抵達的地圖、失效的場所移動）/ 繪製區域（自動計算 autotile 接邊）/ 產生地城或洞窟地形 |
| 事件編輯 | 5 | 列出 / 建立 / 更新 / 新增指令 / 刪除事件（支援 40+ 種人類可讀指令格式） |
| 事件流程分析 | 2 | 解析事件實際行為：各頁的觸發條件、指令流程，以及所使用的開關 / 變數 / 獨立開關 / 公共事件 / 場所移動 |
| 專案一致性檢查 | 1 | 全專案靜態檢查：無法停止的自動執行、永遠無法開啟的獨立開關、失效的場所移動與公共事件、從未設定的開關 / 變數、無法抵達的地圖、未設定通行度的圖塊組 |
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
git clone https://github.com/a951753abc/rpgmaker-mz-mcp.git
cd rpgmaker-mz-mcp
npm install
npm run build
npm test  # 42 個測試應全部通過
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

### 利用可能なツール（全 30 個）

| カテゴリ | ツール数 | 説明 |
|---------|:---:|------|
| プロジェクト管理 | 4 | 読み込み / 作成 / 情報取得 / リソース一覧 |
| データベース CRUD | 6 | 一覧 / 取得 / 作成 / 更新 / 削除 / 検索（アクター、職業、スキル、アイテム、武器、防具、敵キャラ、ステート対応） |
| マップ管理 | 9 | 一覧 / 作成 / 詳細 / 更新 / 削除 / テキストグリッド表示（壁・はしご・イベント位置などの空間情報）/ マップ接続グラフ（一方通行・到達不能マップ・無効な場所移動）/ 領域の塗りつぶし（オートタイル形状を自動計算）/ ダンジョン・洞窟の自動生成 |
| イベント編集 | 5 | 一覧 / 作成 / 更新 / コマンド追加 / 削除（40以上の人間が読めるコマンド形式対応） |
| イベントフロー解析 | 2 | イベントの実際の動作を解析：各ページのトリガー・出現条件・コマンドの流れ、使用しているスイッチ / 変数 / セルフスイッチ / コモンイベント / 場所移動 |
| プロジェクト整合性チェック | 1 | プロジェクト全体の静的解析：停止できない自動実行、絶対にONにならないセルフスイッチ、存在しないマップ / コモンイベントへの参照、未設定のスイッチ / 変数、到達不能マップ、通行設定が未構成のタイルセット |
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
git clone https://github.com/a951753abc/rpgmaker-mz-mcp.git
cd rpgmaker-mz-mcp
npm install
npm run build
npm test  # 42 テストがすべてパスするはず
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
