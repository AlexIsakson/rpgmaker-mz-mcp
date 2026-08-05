# 🎮 RPG Maker MZ MCP Server

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js)](https://nodejs.org)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.26.0-orange)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/Tests-72%20passed-brightgreen)]()

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

## 🛠 Available Tools (26 total)

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

### Map Management (6)
| Tool | Description |
|------|-------------|
| `list_maps` | List all maps with hierarchy |
| `create_map` | Create a new map with size, tileset, BGM |
| `get_map` | Get map details including events |
| `update_map` | Update map properties |
| `delete_map` | Delete a map |
| `get_map_grid` | Render a map as a text grid — walls, ladders, bushes, counters, damage floors, and event positions |

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
│   ├── event-tools.ts          # 5 event editing tools
│   ├── event-flow-tools.ts     # 2 event flow analysis tools
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

### 可用工具（共 26 個）

| 類別 | 工具數 | 說明 |
|------|:---:|------|
| 專案管理 | 4 | 載入 / 建立 / 查詢專案資訊 / 列出素材資源 |
| 資料庫 CRUD | 6 | 列出 / 取得 / 新增 / 更新 / 刪除 / 搜尋（支援角色、職業、技能、道具、武器、防具、敵人、狀態） |
| 地圖管理 | 6 | 列出 / 建立 / 查看 / 更新 / 刪除地圖 / 以文字網格呈現地圖（牆壁、梯子、事件位置等空間資訊） |
| 事件編輯 | 5 | 列出 / 建立 / 更新 / 新增指令 / 刪除事件（支援 40+ 種人類可讀指令格式） |
| 事件流程分析 | 2 | 解析事件實際行為：各頁的觸發條件、指令流程，以及所使用的開關 / 變數 / 獨立開關 / 公共事件 / 場所移動 |
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

### 利用可能なツール（全 26 個）

| カテゴリ | ツール数 | 説明 |
|---------|:---:|------|
| プロジェクト管理 | 4 | 読み込み / 作成 / 情報取得 / リソース一覧 |
| データベース CRUD | 6 | 一覧 / 取得 / 作成 / 更新 / 削除 / 検索（アクター、職業、スキル、アイテム、武器、防具、敵キャラ、ステート対応） |
| マップ管理 | 6 | 一覧 / 作成 / 詳細 / 更新 / 削除 / テキストグリッド表示（壁・はしご・イベント位置などの空間情報） |
| イベント編集 | 5 | 一覧 / 作成 / 更新 / コマンド追加 / 削除（40以上の人間が読めるコマンド形式対応） |
| イベントフロー解析 | 2 | イベントの実際の動作を解析：各ページのトリガー・出現条件・コマンドの流れ、使用しているスイッチ / 変数 / セルフスイッチ / コモンイベント / 場所移動 |
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
