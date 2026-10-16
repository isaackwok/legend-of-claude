# 克勞德傳說 里程碑一：真實工作閉環 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出能真的拿來工作的最小遊戲：在佈告欄建立或從 Jira 匯入委託 → 派給 NPC → NPC 在獨立 worktree 裡用 auto mode 工作（需要時放信鴿請你批准）→ 你在水晶球看進度、傳信或召回 → 驗收或退回 → 結算（推分支、開 PR、改 Jira、留言、貼 PR 連結、開票）。

**Architecture:** npm workspaces 三個套件：`shared`（型別與純函式）、`server`（Node + Hono + ws + Agent SDK，負責存檔、git、跑 NPC）、`client`（Vite + React + Zustand，本里程碑不含 Phaser）。所有 Claude 呼叫都經過 `server/src/agent/` 的一個可注入 `QueryFn`，所以除了技術實驗與最後的手動驗證，所有測試都不打真的 Claude。

**Tech Stack:** TypeScript 5、Node 22+、`@anthropic-ai/claude-agent-sdk`、Hono + `@hono/node-server`、`ws`、Vite、React 18、Zustand、Vitest、@testing-library/react。

**Spec:** `docs/superpowers/specs/2026-10-16-legend-of-claude-v1-design.md`（下稱「規格」）。草圖在 `docs/superpowers/mockups/`。

## Global Constraints

- 本里程碑只做規格 §8「里程碑一」。不做 Phaser 城鎮、招募表單、法師塔、觀戰動畫、隊伍、經驗值。
- 介面文字一律繁體中文、用遊戲名詞（委託、冒險中、待驗收、卷軸、信鴿、水晶球、公會櫃檯、地下城、傳信、召回），除非影響理解。
- 不使用 emoji。畫面用規格 §7 色盤：羊皮紙 `#e9dcc0`、淺羊皮紙 `#f4ead2`、墨色 `#2e2418`、框線 `#4a3a28`、蠟封紅 `#7a2e1e`、狀態色：冒險中 `#c9822e`、完成 `#4f6b3a`。
- 伺服器只綁 `127.0.0.1`；所有 HTTP 與 WebSocket 都要驗 token 與 `Origin`（規格 §4）。
- NPC 一律 `permissionMode: 'auto'`；不可用時退到 `'acceptEdits'` 並標示「謹慎模式」；**永不**使用 `'bypassPermissions'`（規格 §5.7）。
- `settingSources: ['project', 'local']`（讀專案設定、不讀使用者層級，規格 §3）。
- `systemPrompt: { type: 'preset', preset: 'claude_code', append: <人設與遊戲指示> }`。
- SDK 子程序的 `env` 一律從 `process.env` 複製並**移除** `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`，確保走 claude.ai 訂閱與 connectors；啟動檢查時若偵測到這些變數，在畫面上顯示「已忽略」提示。
- 遊戲資料夾預設 `~/.legend-of-claude/`，可用環境變數 `LOC_DATA_DIR` 覆寫（測試一律用暫存資料夾）。
- 一個 NPC 同時只執行一個委託（規格 §5.1）。
- Session 由遊戲自己的 `FileSessionStore`（`sessionStore` 選項）保存；續聊一律帶同一個 store（規格 §5.9）。

## Review Focus

1. **伺服器在委託「冒險中」時重啟**：委託不能永遠卡在冒險中。重啟後改回「待接委託」並在卷軸欄記一行「冒險被中斷」，worktree 與分支保留，可再次出發並續用原 session。→ Task 10 的 `recoverInterrupted` 測試。
2. **信鴿等待中時召回或 session 結束**：待批准的信不能殘留在信箱，按下也不能報錯。→ Task 9 的 `cancels pending approvals on interrupt` 測試。
3. **Jira 票號不存在或 connector 不可用**：不建立委託，回傳清楚錯誤訊息。→ Task 11 的 `importJiraIssue rejects unknown key` 測試。
4. **專案有未提交的修改、或同名分支已存在**：建 worktree 要以專案目前的 HEAD 為基底照常成功；分支名衝突時回傳清楚錯誤，不覆蓋舊分支。→ Task 8 的兩個測試。
5. **同一個 NPC 被連點兩次出發**：第二次要被拒絕（NPC 已在冒險中），不能開出兩個 session。→ Task 10 的 `rejects starting a second quest for a busy npc` 測試。

---

## File Structure

```
package.json                     # npm workspaces: shared, server, client
tsconfig.base.json
vitest.workspace.ts
shared/src/
  types.ts                       # Quest, Npc, Dungeon, GameEvent, Approval, Settlement…
  questMachine.ts                # 委託狀態機（純函式）
  protocol.ts                    # WebSocket 訊息型別、REST 請求／回應型別
server/src/
  index.ts                       # 啟動：讀設定、建 app、印出帶 token 的網址
  config.ts                      # dataDir、port、token、allowedOrigins
  http/app.ts                    # Hono app 組裝
  http/security.ts               # token 與 Origin 中介層
  http/routes/*.ts               # quests, approvals, dungeons, jira, sessions, chats, inventory, preflight
  ws/hub.ts                      # WebSocket 廣播
  store/jsonRepo.ts              # 以 JSON 檔存取集合（原子寫入）
  store/fileSessionStore.ts      # SDK SessionStore 實作
  preflight.ts                   # 環境檢查
  dungeons/scan.ts               # 掃描 git 專案、解析 GitHub remote
  npcs/seeds.ts                  # 內建 NPC 與職業模板
  git/worktree.ts                # 建立／提交／推送 worktree 分支
  agent/queryFn.ts               # QueryFn 型別與真實實作
  agent/options.ts               # buildAgentOptions（純函式）
  agent/runner.ts                # AgentRun：串流、傳信、召回、信鴿
  agent/translate.ts             # SDKMessage → GameEvent
  agent/approvals.ts             # ApprovalBroker
  quests/service.ts              # 委託流程
  quests/prompts.ts              # 委託提示文字
  clerk/clerk.ts                 # 公會櫃檯：Jira 匯入、轉換清單、結算
  chats/service.ts               # 與 NPC 閒聊
spikes/                          # 技術實驗腳本（不進產品）
client/src/
  main.tsx, App.tsx
  api/http.ts, api/ws.ts         # 帶 token 的呼叫
  state/store.ts                 # Zustand
  theme/tokens.css               # 色盤、字體
  ui/Preflight.tsx
  ui/board/*                     # 佈告欄
  ui/dungeons/*                  # 地下城登記
  ui/crystal/*                   # 水晶球
  ui/settlement/*                # 驗收與結算
docs/superpowers/spikes/2026-10-16-results.md
```

---

### Task 1: Monorepo 骨架

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.workspace.ts`, `shared/package.json`, `shared/tsconfig.json`, `server/package.json`, `server/tsconfig.json`, `client/package.json`, `client/tsconfig.json`, `client/vite.config.ts`, `client/index.html`
- Test: `shared/src/smoke.test.ts`

**Interfaces:**
- Produces: 根目錄指令 `npm test`（跑全部 vitest）、`npm run dev`（同時起 server 與 client）、`npm run typecheck`。套件名 `@loc/shared`、`@loc/server`、`@loc/client`。

- [ ] **Step 1:** 建立 workspaces 與 TS 設定（`strict: true`、`module: NodeNext`；client 用 `bundler`）。server 依賴：`@anthropic-ai/claude-agent-sdk`、`hono`、`@hono/node-server`、`ws`、`zod`；dev：`tsx`、`vitest`。client 依賴：`react`、`react-dom`、`zustand`；dev：`vite`、`@vitejs/plugin-react`、`@testing-library/react`、`jsdom`。`npm run dev` 用 `concurrently` 起 `tsx watch server/src/index.ts` 與 `vite`。
- [ ] **Step 2:** 寫 `smoke.test.ts`：`expect(1 + 1).toBe(2)`。
- [ ] **Step 3:** Run `npm install && npm test && npm run typecheck`。Expected: 1 passed，typecheck 無錯。
- [ ] **Step 4: Commit** `chore: scaffold npm workspaces`

---

### Task 2: 技術實驗（開工前必做，有決策關卡）

**Files:**
- Create: `spikes/connectors.ts`, `spikes/skills.ts`, `spikes/autoMode.ts`, `spikes/sessionStore.ts`
- Create: `docs/superpowers/spikes/2026-10-16-results.md`

每個腳本用 `npx tsx spikes/<name>.ts <某個測試用 git 專案路徑>` 執行，打真的 Claude（用 Haiku 模型、極短提示以省用量），把觀察寫進結果文件。`env` 依 Global Constraints 移除 API key。

- [ ] **Step 1: connectors.ts** — `settingSources: ['project','local']` 跑一次 `query`，印出 init 訊息的 `apiKeySource`、`mcp_servers`（name/status/source）、`tools` 中所有 `mcp__` 開頭的名稱。記錄：claude.ai connectors 是否出現、server 名稱與工具前綴（`mcp__<prefix>__…`）的對應規則。
- [ ] **Step 2: skills.ts** — 在暫存資料夾建一個 local plugin（`.claude-plugin/plugin.json` + `skills/a/SKILL.md`、`skills/b/SKILL.md`），以 `plugins: [{type:'local', path}]` 搭配 `skills: [<只有 a>]` 跑一次，印出 init 的 `skills`。記錄：plugin 技能的命名格式（是否帶 plugin 前綴）、`skills` 篩選是否也會篩掉專案 `.claude/skills` 的技能。
- [ ] **Step 3: autoMode.ts** — `permissionMode: 'auto'`、提供會記錄呼叫的 `canUseTool`，請模型執行 `git status` 再建立並刪除一個暫存檔。記錄：init 的 `permissionMode` 是否為 `auto`、哪些呼叫進了 `canUseTool`、`decisionReason` 內容。
- [ ] **Step 4: sessionStore.ts** — 用 SDK 的 `InMemorySessionStore` 跑一次，再以 `resume` 續聊一句「我剛剛請你做什麼」，確認續聊有上下文；再試 `deny` 規則 `mcp__<某 connector 前綴>__*` 是否讓該 connector 從 `tools` 消失或被拒。
- [ ] **Step 5: 決策關卡** — 把四項結果寫進 `docs/superpowers/spikes/2026-10-16-results.md`，每項標「可行／不可行／需調整」，並寫下後續任務要用的具體規則：(a) `connectorPrefix(serverName)` 的對應規則；(b) `enabledSkills` 的命名規則；(c) auto 是否可用。**若 (a) claude.ai connectors 在 `settingSources` 不含 `user` 時不出現，或 (c) auto 不可用於預設模型：停止，回報使用者，不要繼續後續任務。**
- [ ] **Step 6: Commit** `docs: record agent sdk spike results`

---

### Task 3: 共用型別與委託狀態機

**Files:**
- Create: `shared/src/types.ts`, `shared/src/questMachine.ts`, `shared/src/protocol.ts`
- Test: `shared/src/questMachine.test.ts`

**Interfaces:**
- Produces（後續所有任務使用，名稱不可改）：

```ts
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ClassId = 'warrior' | 'scholar' | 'scout' | 'freeman';
export type BuiltinRole = 'clerk';               // 本里程碑只有公會櫃檯
export interface Npc {
  id: string; name: string; classId: ClassId; builtin?: BuiltinRole;
  persona: string; model: string; effort: Effort;
  equipment: { connectorPrefixes: string[]; readOnly: boolean };
  skills: string[]; homeDungeonId?: string;
  busyQuestId?: string; cautious?: boolean;     // cautious = 謹慎模式（退到 acceptEdits）
}
export interface Dungeon { id: string; name: string; path: string; githubRepo?: string /* owner/name */; defaultBranch?: string }
export type QuestStatus = 'open' | 'adventuring' | 'review' | 'done' | 'abandoned';
export type QuestSource = { kind: 'local' } | { kind: 'jira'; key: string; url: string };
export interface Quest {
  id: string; title: string; body: string; stars: 1|2|3|4|5;
  status: QuestStatus; source: QuestSource;
  npcId?: string; dungeonId?: string; branch?: string; worktreePath?: string; baseBranch?: string;
  sessionId?: string; scroll?: string; rejections: number;
  settlement?: SettlementRecord; createdAt: number; updatedAt: number;
}
export type QuestAction = 'start' | 'finish' | 'interrupt' | 'reject' | 'accept' | 'abandon';
export interface Approval { id: string; npcId: string; questId?: string; sessionId: string; toolName: string; summary: string; reason?: string; createdAt: number }
export type GameEventKind = 'text' | 'tool_start' | 'tool_end' | 'compact' | 'subagent_start' | 'subagent_end' | 'background_start' | 'background_end' | 'result' | 'error';
export interface GameEvent { id: string; sessionId: string; npcId: string; questId?: string; at: number; kind: GameEventKind; label: string; detail?: string; toolUseId?: string; parentToolUseId?: string | null }
export interface SettlementChoices { pushAndPr: boolean; jiraTransitionId?: string; jiraComment?: string; linkPr: boolean; openTicket: boolean }
export interface SettlementRecord { choices: SettlementChoices; prUrl?: string; results: { action: string; ok: boolean; message: string }[]; at: number }
```

`protocol.ts` 定義 WS 伺服器→客戶端訊息：`{type:'snapshot'; quests; npcs; dungeons; approvals; preflight}`、`{type:'quest'; quest}`、`{type:'npc'; npc}`、`{type:'dungeon'; dungeon}`、`{type:'event'; event: GameEvent}`、`{type:'approval'; approval}`、`{type:'approval_resolved'; id}`，以及 `Preflight = { ignoredEnvVars: string[]; apiKeySource?: string; loggedIn: boolean; warnings: string[] }`。

- [ ] **Step 1: 寫失敗測試** `questMachine.test.ts`，針對 `transition(status: QuestStatus, action: QuestAction): QuestStatus`：
  - `open --start--> adventuring`；`adventuring --finish--> review`；`adventuring --interrupt--> open`；`review --reject--> adventuring`；`review --accept--> done`；`open|review --abandon--> abandoned`。
  - 其他組合 `toThrow(InvalidTransitionError)`，例如 `done --start`、`adventuring --accept`、`abandoned --start`。
  - `STATUS_LABEL` 等於 `{ open:'待接委託', adventuring:'冒險中', review:'待驗收', done:'已完成', abandoned:'已放棄' }`。
- [ ] **Step 2:** Run `npx vitest run shared` → FAIL（模組不存在）。
- [ ] **Step 3:** 實作 `transition`、`InvalidTransitionError`、`STATUS_LABEL`、`BOARD_COLUMNS: QuestStatus[] = ['open','adventuring','review','done']`。
- [ ] **Step 4:** Run `npx vitest run shared` → PASS。
- [ ] **Step 5: Commit** `feat(shared): domain types and quest state machine`

---

### Task 4: 存檔與 Session Store

**Files:**
- Create: `server/src/config.ts`, `server/src/store/jsonRepo.ts`, `server/src/store/fileSessionStore.ts`
- Create: `server/test/sessionStoreConformance.ts`（從 SDK repo `examples/session-stores/shared/conformance.ts` 複製）
- Test: `server/src/store/jsonRepo.test.ts`, `server/src/store/fileSessionStore.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env = process.env): { dataDir: string; port: number; clientPort: number; token: string; allowedOrigins: string[] }`：`dataDir` = `LOC_DATA_DIR ?? ~/.legend-of-claude`；`port` 4517；`clientPort` 4518；`token` = 32 bytes 隨機 hex；`allowedOrigins` = `http://127.0.0.1:4518`、`http://localhost:4518`、`http://127.0.0.1:4517`、`http://localhost:4517`。
  - `class JsonRepo<T extends { id: string }>`：`constructor(file: string)`、`list(): Promise<T[]>`、`get(id): Promise<T | undefined>`、`put(item: T): Promise<T>`、`remove(id): Promise<void>`。檔案為 `{ items: T[] }`，寫入用「寫暫存檔再 rename」。同一實例內的寫入要排隊（避免並發覆蓋）。
  - `class FileSessionStore implements SessionStore`（SDK 匯出的型別）：`constructor(root: string)`，存在 `<dataDir>/sessions/<projectKey>/<sessionId>[/<subpath>].jsonl`；實作 `append`（依 `entry.uuid` 去重）、`load`、`listSessions`、`listSessionSummaries`（用 SDK 的 `foldSessionSummary`，每個 session 一把鎖）、`delete`（連同子鍵與摘要）、`listSubkeys`。
  - `repos(dataDir)` 回傳 `{ quests: JsonRepo<Quest>; npcs: JsonRepo<Npc>; dungeons: JsonRepo<Dungeon>; sessions: JsonRepo<SessionIndexEntry>; settings: JsonRepo<Settings> }`，其中
    `SessionIndexEntry = { id: string /* sessionId */; npcId: string; questId?: string; title: string; cwd: string; updatedAt: number }`，
    `Settings = { id: 'settings'; scanRoot: string /* 初值 ~/dev */; lastSettlement?: SettlementChoices; connectors?: { name: string; prefix: string; status: string }[] }`（兩個型別放在 `shared/src/types.ts`）。

- [ ] **Step 1: 寫失敗測試**：`jsonRepo.test.ts` — `put` 後 `get` 取回相同物件；`remove` 後 `get` 為 `undefined`；並發 `Promise.all` 20 次 `put` 不同 id 後 `list()` 長度 20；檔案不存在時 `list()` 回 `[]`。`fileSessionStore.test.ts` — 呼叫 `runSessionStoreConformance(() => new FileSessionStore(tmpDir()))`；另測重送相同 `uuid` 的 entry 不重複。
- [ ] **Step 2:** Run `npx vitest run server/src/store` → FAIL。
- [ ] **Step 3:** 實作上述三個模組。
- [ ] **Step 4:** Run → PASS。
- [ ] **Step 5: Commit** `feat(server): json repositories and file session store`

---

### Task 5: 伺服器、安全性、WebSocket、啟動檢查

**Files:**
- Create: `server/src/index.ts`, `server/src/http/app.ts`, `server/src/http/security.ts`, `server/src/ws/hub.ts`, `server/src/preflight.ts`, `server/src/http/routes/preflight.ts`
- Test: `server/src/http/security.test.ts`, `server/src/preflight.test.ts`

**Interfaces:**
- Consumes: `loadConfig`（Task 4）、`protocol.ts` 型別（Task 3）。
- Produces:
  - `createApp(deps: AppDeps): Hono`，`AppDeps` 之後各任務往裡加服務；所有路由掛在 `/api`。
  - `requireAuth(config)`：Hono 中介層。接受 `Authorization: Bearer <token>`；`Origin` 存在時必須在 `allowedOrigins`；否則 401/403。
  - `class WsHub`：`attach(server, config)` 只接受 `?token=` 正確且 `Origin` 合法的升級請求；`broadcast(msg: ServerMessage)`；新連線先送 `snapshot`（由 `getSnapshot: () => Promise<Snapshot>` 提供）。
  - `sdkEnv(env = process.env): { env: Record<string,string|undefined>; ignored: string[] }`：移除 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`，回傳被移除的名稱。
  - `runPreflight(queryFn): Promise<Preflight>`：用 Haiku 跑一個 `maxTurns: 1` 的極短 query，只讀 init 的 `apiKeySource`；收到 `auth_status` 未登入或丟出 "Not logged in" 時 `loggedIn: false` 並給警告文字「請先在終端機執行 claude 並用 claude.ai 帳號登入」。
  - `GET /api/preflight`。
  - `index.ts`：`listen({ hostname: '127.0.0.1', port })`，印出 `克勞德傳說已啟動：http://127.0.0.1:4518/?token=<token>`。
- [ ] **Step 1: 寫失敗測試** `security.test.ts`：無 token → 401；錯 token → 401；正確 token + `Origin: https://evil.example` → 403；正確 token + 允許的 Origin → 200；正確 token 且無 Origin（伺服器端工具）→ 200。WS：錯 token 升級被拒、壞 Origin 被拒、正確的收到第一則 `snapshot`。`preflight.test.ts`：`sdkEnv({ANTHROPIC_API_KEY:'x', PATH:'/bin'})` → `env` 無該鍵、`ignored` 等於 `['ANTHROPIC_API_KEY']`；以假 `queryFn` 丟出 `Not logged in` → `loggedIn:false`。
- [ ] **Step 2:** Run → FAIL。
- [ ] **Step 3:** 實作。
- [ ] **Step 4:** Run → PASS；手動 `npm run dev` 看到印出的網址。
- [ ] **Step 5: Commit** `feat(server): secured http and websocket server with preflight`

---

### Task 6: 地下城（本機專案）登記

**Files:**
- Create: `server/src/dungeons/scan.ts`, `server/src/http/routes/dungeons.ts`
- Test: `server/src/dungeons/scan.test.ts`

**Interfaces:**
- Produces:
  - `scanForRepos(root: string, maxDepth = 2): Promise<{ name: string; path: string; githubRepo?: string }[]>`：找出含 `.git` 的資料夾（找到就不再往下）。
  - `parseGithubRemote(url: string): string | undefined`：支援 `git@github.com:o/r.git`、`https://github.com/o/r(.git)`，回 `o/r`。
  - `inspectRepo(path): Promise<{ githubRepo?: string; defaultBranch: string }>`：`git remote get-url origin`、`git symbolic-ref --short HEAD`。
  - 路由：`GET /api/dungeons`、`GET /api/dungeons/scan?root=`（預設 settings.scanRoot，初值 `~/dev`）、`POST /api/dungeons {path}`（驗證是 git 專案，否則 400「這不是 git 專案」）、`DELETE /api/dungeons/:id`。新增後廣播 `dungeon`。
- [ ] **Step 1: 寫失敗測試**：在暫存資料夾 `git init` 兩個專案（一個設 GitHub remote）與一個非 git 資料夾 → `scanForRepos` 回 2 筆、remote 正確；`parseGithubRemote` 三種格式；`POST` 非 git 路徑回 400。
- [ ] **Step 2–4:** 跑測試 FAIL → 實作 → PASS。
- [ ] **Step 5: Commit** `feat(server): scan and register local dungeons`

---

### Task 7: NPC 種子與 Agent 選項組裝

**Files:**
- Create: `server/src/npcs/seeds.ts`, `server/src/agent/options.ts`, `server/src/agent/queryFn.ts`
- Test: `server/src/agent/options.test.ts`

**Interfaces:**
- Consumes: Task 2 結果文件中的 `connectorPrefix` 與技能命名規則；`sdkEnv`（Task 5）；`FileSessionStore`（Task 4）。
- Produces:
  - `type QueryFn = typeof import('@anthropic-ai/claude-agent-sdk').query`；`realQueryFn`。
  - `CLASS_TEMPLATES: Record<ClassId, Pick<Npc,'model'|'effort'|'equipment'>>`：warrior＝當下最新 Opus、`high`、可改檔；scholar＝最新 Sonnet、`medium`、`readOnly: true`；scout＝最新 Haiku、`low`、`readOnly: true`；freeman＝Sonnet、`medium`、可改檔。模型 ID 集中在 `MODELS` 常數。
  - `connectorPrefixesFrom(settings: Settings): string[]`：回傳 `settings.connectors` 的 prefix；尚未盤點時回 `[]`（此時不產生任何 connector 拒絕規則）。
  - `seedNpcs(): Npc[]`：若 Task 2 結果指出某模型不支援 auto，該 NPC 種子設 `cautious: true`。公會櫃檯（`builtin:'clerk'`、Haiku、`low`、readOnly、人設說明「只負責 Jira 與 GitHub 的文書工作」）＋ 新手戰士「阿列克」、學者「莉娜」、斥候「托比」。首次啟動（npcs 為空）寫入。
  - `READ_ONLY_DENY = ['Edit', 'Write', 'NotebookEdit']`。
  - `buildAgentOptions(input: { npc: Npc; cwd: string; appendPrompt?: string; allConnectorPrefixes: string[]; sessionStore: SessionStore; env: Record<string,string|undefined>; resume?: string; canUseTool?: CanUseTool; outputFormat?: Options['outputFormat']; forceReadOnly?: boolean }): Options`
    - `systemPrompt` preset＋append（`npc.persona` 之後接 `appendPrompt`）；`model`、`effort`；`settingSources: ['project','local']`；`permissionMode: npc.cautious ? 'acceptEdits' : 'auto'`；`cwd`；`resume`；`sessionStore`；`env`；`includePartialMessages: false`。
    - `disallowedTools` = （readOnly 或 forceReadOnly 時）`READ_ONLY_DENY` ＋ 每個「未裝備」的 connector 前綴 `mcp__<prefix>__*`。
    - 技能：依 Task 2 的規則組 `plugins`（遊戲技能資料夾 `<dataDir>/skills` 作為 local plugin）與 `skills` 篩選；本里程碑 NPC 技能為空時不設 `skills`。
- [ ] **Step 1: 寫失敗測試**：學者 → `disallowedTools` 含三個 READ_ONLY_DENY；戰士裝備 `['jira']`、全部 `['jira','github','slack']` → 含 `mcp__github__*`、`mcp__slack__*`、不含 jira；`cautious:true` → `permissionMode:'acceptEdits'`；任何輸入都不會產生 `'bypassPermissions'`；`settingSources` 恆為 `['project','local']`；`systemPrompt.append` 以 persona 開頭並含 appendPrompt；`seedNpcs()` 恰有一位 `builtin:'clerk'`。
- [ ] **Step 2–4:** FAIL → 實作 → PASS。
- [ ] **Step 5: Commit** `feat(server): npc seeds and agent option builder`

---

### Task 8: Worktree 管理

**Files:**
- Create: `server/src/git/worktree.ts`
- Test: `server/src/git/worktree.test.ts`

**Interfaces:**
- Produces:
  - `branchName(quest: Quest): string` → `loc/<quest.id>`（Jira 委託為 `loc/<KEY>-<quest.id 前 6 碼>`）。
  - `createWorktree(repoPath: string, dataDir: string, branch: string): Promise<{ worktreePath: string; baseBranch: string }>`：位置 `<dataDir>/worktrees/<branch 中的 / 換成 ->`，以 repo 目前 HEAD 建新分支；分支已存在時丟 `BranchExistsError`（訊息「分支 <name> 已存在」）。
  - `commitIfDirty(worktreePath, message): Promise<boolean>`。
  - `diffStat(worktreePath, baseBranch): Promise<string>`（`git diff --stat base...HEAD`）。
  - `pushBranch(worktreePath, branch): Promise<void>`（`git push -u origin <branch>`）。
  - `worktreeExists(path): Promise<boolean>`。
- [ ] **Step 1: 寫失敗測試**（暫存 git repo，含一個初始 commit）：建立後 worktree 存在、`git -C <wt> branch --show-current` 等於分支名；**原 repo 有未提交修改時仍可建立，且 worktree 內看不到那些修改**；**同名分支已存在 → `BranchExistsError`，舊分支的 commit 不變**；`commitIfDirty` 無變更回 `false`、有變更回 `true` 且產生 commit；`diffStat` 含修改的檔名；`pushBranch` 推到一個本機 bare remote 後該 remote 有該分支。
- [ ] **Step 2–4:** FAIL → 實作（`execFile('git', …)`，不經 shell）→ PASS。
- [ ] **Step 5: Commit** `feat(server): git worktree management`

---

### Task 9: Agent Runner、事件翻譯、信鴿

**Files:**
- Create: `server/src/agent/runner.ts`, `server/src/agent/translate.ts`, `server/src/agent/approvals.ts`
- Test: `server/src/agent/runner.test.ts`, `server/src/agent/translate.test.ts`, `server/src/agent/approvals.test.ts`
- Test helper: `server/test/fakeQuery.ts`（假 `QueryFn`：依劇本 yield `SDKMessage`，記錄收到的 options 與 streamInput、可觸發 `canUseTool`、支援 `interrupt()`）

**Interfaces:**
- Consumes: `buildAgentOptions`（Task 7）、`GameEvent`、`Approval`（Task 3）。
- Produces:
  - `class ApprovalBroker`：`request(meta: Omit<Approval,'id'|'createdAt'>, signal: AbortSignal): Promise<PermissionResult>`（建立 Approval、透過 `onChange` 廣播、等待 `resolve`）；`resolve(id: string, decision: { allow: boolean; message?: string }): void`（allow → `{behavior:'allow'}`；deny → `{behavior:'deny', message: message ?? '會長拒絕了這個請求'}`）；`cancelForSession(sessionId)`（全部以 deny 結束並廣播 `approval_resolved`）；`list(): Approval[]`；`onChange(cb)`。
  - `summarizeTool(toolName: string, input: Record<string, unknown>): string`：Bash → 指令；Edit/Write/Read → 檔案路徑；`mcp__x__y` → `x / y`；其他 → 工具名。
  - `translate(msg: SDKMessage, ctx: { npcId: string; questId?: string }): GameEvent[]`：assistant 文字區塊 → `text`；`tool_use` 區塊 → `tool_start`（label 用 `summarizeTool`，Agent/Task 工具 → `subagent_start`，`run_in_background:true` 的 Bash → `background_start`）；user 訊息中的 `tool_result` → `tool_end`（或對應的 `subagent_end`/`background_end`）；`compact_boundary` → `compact`（label「正在整理筆記」）；result → `result` 或 `error`；其他類型回 `[]`。保留 `parent_tool_use_id`。
  - `class AgentRun`：`static start(params: { queryFn: QueryFn; options: Options; prompt: string; npcId: string; questId?: string; broker: ApprovalBroker; onEvent: (e: GameEvent) => void }): AgentRun`
    - 以串流輸入模式啟動（prompt 為 `AsyncIterable<SDKUserMessage>`，第一則為 `prompt`，`origin: { kind: 'human' }`）。
    - `options.canUseTool` 由 runner 注入：轉給 `broker.request`。
    - `init: Promise<{ sessionId: string; permissionMode: string }>`（取自 init 訊息）。
    - `send(text: string): void`（傳信：推入串流，`priority: 'next'`）。
    - `recall(): Promise<void>`（`interrupt()` 後關閉串流，`broker.cancelForSession`）。
    - `done: Promise<{ ok: boolean; resultText?: string; structured?: unknown; sessionId: string; costUsd: number; errors?: string[] }>`；收到 result 後關閉輸入串流使 query 結束。
- [ ] **Step 1: 寫失敗測試**：
  - `translate.test.ts`：同一則 assistant 訊息含 2 個 Read `tool_use` → 2 個 `tool_start`、label 為檔案路徑；`mcp__jira__getIssue` → label `jira / getIssue`；Agent 工具 → `subagent_start`；背景 Bash → `background_start`；compact → `compact`；success result → `result`、error result → `error`。
  - `approvals.test.ts`：`request` 後 `list()` 有 1 筆；`resolve(id,{allow:false})` 得到 deny 且 message 為預設文字；`cancelForSession` 讓等待中的 Promise 以 deny 結束且 `list()` 清空。
  - `runner.test.ts`：假劇本「init → tool_use(Bash) 觸發 canUseTool → 等待 → result」：在等待時 `broker.list()` 有 1 筆；`resolve` 後 run 完成、`done.ok === true`；`send('先別改')` 會出現在假 query 收到的串流輸入；**`cancels pending approvals on interrupt`：等待批准時 `recall()` → broker 清空、`done.ok === false`、不丟例外**；`onEvent` 收到的事件依序包含 `tool_start` 與 `result`。
- [ ] **Step 2–4:** FAIL → 實作 → PASS。
- [ ] **Step 5: Commit** `feat(server): agent runner with event translation and approvals`

---

### Task 10: 委託服務

**Files:**
- Create: `server/src/quests/service.ts`, `server/src/quests/prompts.ts`, `server/src/http/routes/quests.ts`, `server/src/http/routes/approvals.ts`
- Test: `server/src/quests/service.test.ts`

**Interfaces:**
- Consumes: `transition`（Task 3）、`repos`（Task 4）、`createWorktree/commitIfDirty/diffStat/branchName`（Task 8）、`buildAgentOptions`（Task 7）、`AgentRun/ApprovalBroker`（Task 9）、`WsHub.broadcast`（Task 5）。
- Produces:
  - `questPrompt(quest: Quest, dungeon: Dungeon): string`：含委託標題、內容、Jira 票號（若有），以及固定指示：「你在獨立分支 <branch> 上工作；完成時先 commit；最後一則回覆寫成給會長的卷軸：做了什麼、根本原因、如何驗證、還有什麼風險」。
  - `class QuestService`（建構子注入 `repos, hub, broker, queryFn, dataDir, sessionStore`；connector 前綴每次出發時以 `connectorPrefixesFrom(await repos.settings.get('settings'))` 取得，由 Task 11 的盤點填入）：
    - 取得 `sessionId` 時寫入 `repos.sessions`（title＝委託標題、questId、cwd＝worktree）。
    - 若 init 訊息的 `permissionMode` 不是請求的 `'auto'`：把該 NPC 設為 `cautious: true` 並廣播 `npc`（之後出發都用謹慎模式）。
    - `create(input: { title: string; body: string; stars?: 1|2|3|4|5; source?: QuestSource }): Promise<Quest>`（stars 預設 2）。
    - `start(questId, { npcId, dungeonId }): Promise<Quest>`：NPC 有 `busyQuestId` → 丟 `NpcBusyError`「<名字>正在冒險中」；建 worktree（重新出發時沿用既有 worktree 與 `sessionId` 續聊）；設 `npc.busyQuestId`；`transition(start)`；啟動 `AgentRun`（cwd＝worktree，`appendPrompt`＝`questPrompt`）；事件經 hub 廣播；結束時見 `finish` 流程。
    - finish 流程（run 結束時）：`commitIfDirty(wt, 'loc: <title>')`；ok → 寫 `scroll`＝resultText ＋「\n\n變更：\n」＋`diffStat`，`transition(finish)`；失敗 → `transition(interrupt)`，`scroll` 記「冒險失敗：<errors>」；清 `npc.busyQuestId`。
    - `message(questId, text)`：轉給進行中的 run 的 `send`；無進行中 run → 409。
    - `recall(questId)`：run.recall，之後依 finish 失敗分支處理（scroll 記「已被召回」）。
    - `reject(questId, feedback)`：`transition(reject)`、`rejections+1`，以 `resume: sessionId` 再啟動 run，prompt 為「會長退回了委託：<feedback>」。
    - `abandon(questId)`。
    - `recoverInterrupted(): Promise<void>`：啟動時把所有 `adventuring` 改回 `open`、scroll 附加「冒險被中斷（伺服器重啟）」、清相關 NPC 的 `busyQuestId`。
  - 路由：`GET/POST /api/quests`、`POST /api/quests/:id/start|message|recall|reject|abandon`、`GET /api/approvals`、`POST /api/approvals/:id {allow, message?}`。錯誤以 `{ error: string }` 回傳中文訊息。
- [ ] **Step 1: 寫失敗測試**（假 queryFn、暫存 git repo、暫存 dataDir）：
  - 建立 → `open`；出發 → `adventuring`、NPC busy、worktree 存在；假劇本在 worktree 寫檔後 result success → `review`、`scroll` 含 resultText 與檔名、NPC 不再 busy、分支上有 commit。
  - **`rejects starting a second quest for a busy npc`**：同一 NPC 對兩個委託連續 `start`（不 await 第一個完成）→ 第二個 `NpcBusyError`，假 queryFn 只被呼叫一次。
  - 退回 → 以相同 `sessionId` 的 `resume` 呼叫 queryFn，prompt 含 feedback，`rejections === 1`。
  - 召回 → 回 `open`、scroll 含「已被召回」。
  - 假 init 回報 `permissionMode: 'default'` → 該 NPC 變成 `cautious: true`。
  - **`recoverInterrupted`**：repo 中預存一筆 `adventuring` → 執行後 `open`、scroll 含「冒險被中斷」、NPC 不 busy、worktree 仍在；再 `start` 時沿用原 `sessionId` 作 `resume`。
- [ ] **Step 2–4:** FAIL → 實作 → PASS。
- [ ] **Step 5: Commit** `feat(server): quest lifecycle service`

---

### Task 11: 公會櫃檯（Jira 匯入、轉換清單、結算）與倉庫盤點

**Files:**
- Create: `server/src/clerk/clerk.ts`, `server/src/http/routes/jira.ts`, `server/src/http/routes/inventory.ts`, `server/src/http/routes/settlement.ts`
- Test: `server/src/clerk/clerk.test.ts`

**Interfaces:**
- Consumes: 公會櫃檯 NPC（Task 7）、`AgentRun`（Task 9）、`pushBranch`（Task 8）、`QuestService`（Task 10）。
- Produces（全部用 `outputFormat: { type:'json_schema', schema }` 取結構化結果；cwd＝`<dataDir>/guildhall`，空資料夾，故不載入任何專案設定）：
  - `refreshInventory(): Promise<{ name: string; prefix: string; status: string }[]>`：極短 query 讀 init 的 `mcp_servers` 與 `tools`，依 Task 2 規則算 prefix；存進 settings，供 `getConnectorPrefixes`。路由 `POST /api/inventory/refresh`、`GET /api/inventory`。
  - `importJiraIssue(key: string): Promise<Quest>`：schema `{ found: boolean; key; title; description; storyPoints: number|null; priority: string|null; url; error: string|null }`。`found:false` 或 run 失敗 → 丟 `ClerkError`（訊息帶 `error` 或「找不到 <key>，或 Jira 連線不可用」），**不建立委託**。成功 → `QuestService.create`，`source:{kind:'jira',key,url}`，`stars = starsFrom(storyPoints, priority)`。
  - `starsFrom(sp: number|null, priority: string|null): 1|2|3|4|5`：sp ≤1→1、≤2→2、≤3→3、≤5→4、>5→5；無 sp 時 priority Lowest/Low→1、Medium→2、High→3、Highest→4；都沒有→2。
  - `getTransitions(key): Promise<{ id: string; name: string }[]>`。路由 `GET /api/quests/:id/settlement-options` 回 `{ isJira, transitions, lastChoices }`。
  - `settle(questId, choices: SettlementChoices): Promise<SettlementRecord>`：委託必須是 `review`。順序：`pushAndPr` → 先 `pushBranch`，再請櫃檯用 GitHub 開 PR（head＝分支、base＝`quest.baseBranch`、title＝委託標題、body＝scroll）取得 `prUrl`；`jiraTransitionId` → 轉狀態；`jiraComment` → 留言（原文照貼）；`linkPr` 且有 `prUrl` → 在 Jira 留言貼 PR 連結。每一步記 `{action, ok, message}`，某步失敗不中斷後續步驟。之後 `transition(accept)`，存 `settlement`，`settings.lastSettlement = choices`。`openTicket` 由客戶端處理，伺服器只記錄。路由 `POST /api/quests/:id/settle`。
- [ ] **Step 1: 寫失敗測試**（假 queryFn 回固定 `structured_output`）：`importJiraIssue` 成功建立 jira 委託、stars 依 storyPoints；**`importJiraIssue rejects unknown key`：`found:false` → `ClerkError`、quests 數量不變**；`starsFrom` 表格測試；`settle` 全勾時依序呼叫（記錄假 queryFn 收到的 prompt 順序）、`prUrl` 存入、狀態 `done`、`lastSettlement` 更新；PR 步驟失敗時 Jira 步驟仍執行且 `results` 記錄失敗；非 `review` 委託呼叫 `settle` → 錯誤。
- [ ] **Step 2–4:** FAIL → 實作 → PASS。
- [ ] **Step 5: Commit** `feat(server): guild clerk for jira import and settlement`

---

### Task 12: 閒聊與 Session 查詢

**Files:**
- Create: `server/src/chats/service.ts`, `server/src/http/routes/chats.ts`, `server/src/http/routes/sessions.ts`
- Test: `server/src/chats/service.test.ts`

**Interfaces:**
- Consumes: `AgentRun`、`buildAgentOptions`、`FileSessionStore`、`repos`。
- Produces:
  - Session 索引用 Task 4 的 `repos.sessions`；委託 session 由 QuestService 寫入，閒聊 session 由本服務寫入（title＝第一句話前 30 字）。
  - `ChatService.say(input: { npcId: string; text: string; sessionId?: string }): Promise<{ sessionId: string }>`：cwd＝NPC 駐地的專案路徑，沒有駐地則 `<dataDir>/tavern`；**閒聊一律 `forceReadOnly: true`**（閒聊不會改到主分支的檔案）；有 `sessionId` 則 `resume`；NPC busy 時仍可閒聊（閒聊不佔用 `busyQuestId`）——但若該 NPC 正在冒險，規格要求「冒險途中說話＝傳信」，所以 busy 時回 409「<名字>正在冒險，請到水晶球傳信」。
  - `GET /api/sessions?npcId=`：依 `updatedAt` 降冪，進行中（有 run 在跑）置頂並標 `live: true`。
  - `GET /api/sessions/:id/messages`：`getSessionMessages(id, { sessionStore, dir: cwd })` 轉成 `{ role, blocks }[]`，tool_use／tool_result 保留名稱、輸入摘要、輸出前 2000 字。
  - `POST /api/chats {npcId, text, sessionId?}`。
- [ ] **Step 1: 寫失敗測試**：新閒聊建立 session 索引並帶 `forceReadOnly`（檢查假 queryFn 收到的 `disallowedTools` 含 `Edit`）；帶 `sessionId` 時 options.resume 相同；NPC busy → 409 錯誤；sessions 列表排序與 `live` 標記。
- [ ] **Step 2–4:** FAIL → 實作 → PASS。
- [ ] **Step 5: Commit** `feat(server): npc chats and session browsing`

---

### Task 13: 客戶端骨架、狀態、連線

**Files:**
- Create: `client/src/main.tsx`, `client/src/App.tsx`, `client/src/api/http.ts`, `client/src/api/ws.ts`, `client/src/state/store.ts`, `client/src/theme/tokens.css`, `client/src/ui/Preflight.tsx`
- Modify: `client/vite.config.ts`（`/api` 與 `/ws` 代理到 4517、`server.host: '127.0.0.1'`、port 4518）
- Test: `client/src/state/store.test.ts`

**Interfaces:**
- Consumes: `protocol.ts`（Task 3）。
- Produces:
  - `getToken(): string`：首次從 `location.search` 的 `token` 讀出存入 `sessionStorage` 並以 `history.replaceState` 從網址移除；之後從 `sessionStorage` 讀。無 token 時 App 顯示「請用伺服器印出的網址開啟」。
  - `api<T>(path, init?): Promise<T>`：自動加 Bearer；非 2xx 丟出 `{ error }` 的訊息。
  - `connectWs(onMessage): () => void`：斷線 2 秒後重連。
  - `useGame`（Zustand）：`quests: Record<id,Quest>`、`npcs`、`dungeons`、`approvals: Record<id,Approval>`、`events: Record<sessionId, GameEvent[]>`（每個 session 最多保留 500 筆）、`preflight`、`ui: { panel: 'board'|'crystal'|'dungeons'; crystalSessionId?: string; settlementQuestId?: string }`；動作 `applyServerMessage(msg: ServerMessage)`、`openPanel`、`openCrystal(sessionId)`、`openSettlement(questId)`、`closeSettlement()`。供日後 Phaser 用 `useGame.getState()/subscribe` 存取。
  - `tokens.css`：Global Constraints 色盤為 CSS 變數，字體 `"Kaiti TC","STKaiti","Songti TC",serif`（標題與內文），程式碼用 `ui-monospace`。
  - `Preflight`：`ignoredEnvVars` 非空 → 提示「已忽略 <變數>，NPC 會使用 claude.ai 訂閱」；`loggedIn:false` → 紅色警告與登入說明。
- [ ] **Step 1: 寫失敗測試** `store.test.ts`：`snapshot` 填滿各集合；`quest` 訊息覆蓋同 id；`approval` 加入、`approval_resolved` 移除；`event` 依 sessionId 累加且超過 500 筆時丟最舊的。
- [ ] **Step 2–4:** FAIL → 實作 → PASS；`npm run dev` 用印出的網址開啟，看到 Preflight 與空白頁框。
- [ ] **Step 5: Commit** `feat(client): app shell, store, and authenticated connection`

---

### Task 14: 佈告欄與地下城登記畫面

**Files:**
- Create: `client/src/ui/board/Board.tsx`, `client/src/ui/board/QuestCard.tsx`, `client/src/ui/board/NewQuestDialog.tsx`, `client/src/ui/board/StartQuestDialog.tsx`, `client/src/ui/dungeons/DungeonsPanel.tsx`, `client/src/ui/Nav.tsx`
- Test: `client/src/ui/board/Board.test.tsx`

**Interfaces:**
- Consumes: `useGame`、`api`、`BOARD_COLUMNS`、`STATUS_LABEL`。
- Produces（版面參考 `docs/superpowers/mockups/town-and-board.html` 的 A）：
  - `Board`：四欄（`BOARD_COLUMNS`），標題用 `STATUS_LABEL`；欄頂「貼新委託」「從 Jira 匯入」按鈕。
  - `QuestCard`：票號／「本地委託」、標題、星等（SVG 星或文字「★」字元，不用 emoji）、地下城名、NPC 名與冒險中狀態（最新一筆事件的 label）。點擊：`adventuring` → 開水晶球到該 session；`review` → 「驗收」「退回」按鈕；`open` → 「派遣」。
  - `NewQuestDialog`：標題、內容、星等。「從 Jira 匯入」：輸入票號 → `POST /api/jira/import`，等待中顯示「公會櫃檯正在查詢…」，錯誤原樣顯示。
  - `StartQuestDialog`：選 NPC（排除公會櫃檯與 busy 者）、選地下城（預設 NPC 駐地）→ `POST /start`。
  - `DungeonsPanel`：掃描結果勾選登記、手動輸入路徑、已登記清單（名稱、路徑、GitHub repo）。
  - `Nav`：切換「佈告欄／水晶球／地下城地圖」，信箱徽章顯示待批准數量。
- [ ] **Step 1: 寫失敗測試** `Board.test.tsx`：給 store 三個不同狀態的委託 → 出現在對應欄位；`review` 卡片有「驗收」「退回」；`StartQuestDialog` 的 NPC 選單不含公會櫃檯與 busy 的 NPC。
- [ ] **Step 2–4:** FAIL → 實作 → PASS。
- [ ] **Step 5: Commit** `feat(client): quest board and dungeon registry`

---

### Task 15: 水晶球

**Files:**
- Create: `client/src/ui/crystal/CrystalBall.tsx`, `client/src/ui/crystal/SessionList.tsx`, `client/src/ui/crystal/Transcript.tsx`, `client/src/ui/crystal/PigeonLetter.tsx`, `client/src/ui/crystal/Composer.tsx`
- Test: `client/src/ui/crystal/CrystalBall.test.tsx`

**Interfaces:**
- Consumes: `GET /api/sessions`、`GET /api/sessions/:id/messages`、`useGame.events/approvals`、`POST /api/quests/:id/message|recall`、`POST /api/chats`、`POST /api/approvals/:id`。
- Produces（版面仿 Claude Code：左列表、右對話，規格 §5.11）：
  - `SessionList`：依 NPC 分組，`live` 置頂並標「冒險中」；頂端「與 NPC 聊天」選 NPC 開新閒聊。
  - `Transcript`：歷史訊息（API）＋該 session 的即時事件（store）接在後面；tool 呼叫一行摘要、可展開看輸入與輸出；Edit 的輸入以 diff 呈現（old_string 紅、new_string 綠）；`compact` 顯示「正在整理筆記」分隔線；`subagent_*` 標「使魔」、`background_*` 標「營火」。
  - `PigeonLetter`：該 session 的待批准信，顯示 NPC、`summary`、`reason`，「同意」「拒絕（可附理由）」。
  - `Composer`：委託 session → 「傳信」（`/message`）與「召回」（確認後 `/recall`）；閒聊 session → 送出走 `/api/chats`。
- [ ] **Step 1: 寫失敗測試**：store 中有一則該 session 的 approval → 畫面出現信件，按「同意」呼叫 `POST /api/approvals/:id` 帶 `{allow:true}`（mock fetch）；委託 session 顯示「傳信」「召回」，閒聊 session 不顯示「召回」；`tool_start` 事件可展開顯示 detail。
- [ ] **Step 2–4:** FAIL → 實作 → PASS。
- [ ] **Step 5: Commit** `feat(client): crystal ball session viewer`

---

### Task 16: 驗收、退回、結算畫面

**Files:**
- Create: `client/src/ui/settlement/SettlementDialog.tsx`, `client/src/ui/board/RejectDialog.tsx`
- Test: `client/src/ui/settlement/SettlementDialog.test.tsx`

**Interfaces:**
- Consumes: `GET /api/quests/:id/settlement-options`、`POST /api/quests/:id/settle`、`POST /api/quests/:id/reject`。
- Produces（規格 §5.8）：
  - 勾選項：推上分支並開 PR／把 Jira 狀態改為（下拉 transitions）／在 Jira 留言（textarea，預設為 scroll，可編輯）／在 Jira 貼上 PR 連結（未勾開 PR 時 disabled）／在瀏覽器打開這張 Jira 票。非 Jira 委託只顯示第一項。初始值取 `lastChoices`。
  - 送出時顯示「公會櫃檯正在結算…」，完成後逐條顯示 `results`；勾了開票則 `window.open(source.url, '_blank', 'noopener')`。
  - `RejectDialog`：輸入退回理由（必填）→ `/reject`。
- [ ] **Step 1: 寫失敗測試**：本地委託只顯示「推上分支並開 PR」；Jira 委託未勾開 PR 時「貼上 PR 連結」為 disabled；`lastChoices` 帶入預設勾選；送出 body 等於勾選結果；勾開票時呼叫 `window.open` 帶票的 url。
- [ ] **Step 2–4:** FAIL → 實作 → PASS。
- [ ] **Step 5: Commit** `feat(client): review, reject, and settlement dialogs`

---

### Task 17: 正式啟動指令與端到端手動驗證

**Files:**
- Modify: `package.json`（`npm start`：build client，server 以靜態檔服務 `client/dist`，只開 4517）、`server/src/http/app.ts`（靜態檔與 SPA fallback，仍需 token 才能呼叫 `/api`）
- Create: `README.md`（啟動方式、需要先用 claude.ai 帳號登入 Claude Code、資料夾位置）

- [ ] **Step 1:** 實作 `npm start`；Run `npm test && npm run typecheck && npm start`，Expected：全綠，印出 `http://127.0.0.1:4517/?token=…`。
- [ ] **Step 2: 手動驗證（用一個可丟棄的 git 專案，含一個會失敗的測試）**，逐項打勾並把結果記在 PR 描述：
  1. Preflight 顯示已登入；若有設 `ANTHROPIC_API_KEY` 顯示已忽略。
  2. 地下城地圖掃描並登記該專案。
  3. 倉庫盤點列出 claude.ai connectors。
  4. 貼一個本地委託「修好失敗的測試」，派給戰士 → 卡片進「冒險中」，水晶球即時出現工具呼叫。
  5. 冒險途中傳信一次，NPC 有回應。
  6. 至少出現一次信鴿（可請 NPC 執行一個需要批准的動作），同意與拒絕各試一次。
  7. 完成後進「待驗收」，卷軸含說明與變更檔案；退回一次並附理由，NPC 用同一 session 繼續。
  8. 驗收並結算「推上分支並開 PR」（專案需有 GitHub remote 與 connector）→ 取得 PR 連結。
  9. 從 Jira 匯入一張真實票（可選不結算 Jira 項目，避免動到真實資料；若要測，先跟使用者確認用哪張票）。
  10. 在冒險中重啟伺服器 → 委託回到「待接委託」並註明被中斷，再次出發可續聊。
- [ ] **Step 3: Commit** `feat: production start command and readme`
