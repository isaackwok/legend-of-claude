# 里程碑一 執行期間的裁決紀錄

執行 `docs/superpowers/plans/2026-10-16-milestone-1-real-work-loop.md` 時，由 controller 在無人值守下所做的決定。每條：決定 — 理由 — 若決定錯誤的代價。

- R1 Ruling: use Node 24 via nvm (`.nvmrc` = `24`); every command runs after `source ~/.nvm/nvm.sh && nvm use >/dev/null` — spec/vercel note says Node 20 is deprecated and plan requires 22+ — cost if wrong: trivial, change .nvmrc.
- R2 Ruling: Task 5 creates `server/src/agent/queryFn.ts` (QueryFn type + realQueryFn); Task 7 consumes it instead of creating it — fixes task order — cost if wrong: none.
- R3 Ruling: Task 5's preflight test uses a minimal inline fake async generator; Task 9 creates the shared `server/test/fakeQuery.ts` — cost if wrong: small duplication.
- R4 Ruling: Task 11 adds `QuestService.accept(questId: string, record: SettlementRecord): Promise<Quest>` (transition accept, store settlement, broadcast) and `settle` calls it — plan required the accept transition but gave no owner — cost if wrong: small refactor.
- R5 Ruling: Jira import route is `POST /api/jira/import` body `{ key: string }` → `Quest` (201) or `{ error }` (400/502) — cost if wrong: rename.
- R6 Ruling: MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' } (latest per environment) — cost if wrong: edit constant.
- R7 Ruling: vitest config uses root `vitest.config.ts` with `test.projects` instead of `vitest.workspace.ts` — vitest 5 ignores workspace files — cost if wrong: none.
- R8 Ruling: accept latest majors (TypeScript 7, Vite 8, Vitest 5, Zod 4) — plan said current stable — cost if wrong: pin back if a tool breaks.
- R9 Ruling: every NPC session gets disallowedTools `Bash(git push *)` (and `Bash(git push)`) — spike showed auto mode lets NPCs push; spec says push/PR only at settlement by the game — cost if wrong: NPC can't push even if user wanted; trivial to relax.
- R10 Ruling: Task 11 refreshInventory uses streaming-input mode and polls `query.mcpServerStatus()` until connectors settle (not init.mcp_servers, which is [] at init) — spike finding — cost if wrong: inventory empty.
- R11 Ruling: in M1 NPCs have no game skills, so `skills` option is omitted (all project + built-in skills visible, honoring "load all project settings"); per-NPC filtering (must list `plugin:skill` + project skill names) deferred to the 法師塔 milestone — spike: `skills` filter also hides project skills — cost if wrong: none in M1.
- R12 Ruling: accept that auto mode rarely calls canUseTool (pigeons seldom fire) — user explicitly chose Claude Code auto-mode parity; surface to user at finish together with "auto allowed rm outside cwd" — cost if wrong: user may want extra deny rules/hooks later.
- R13 Ruling: settings record is seeded lazily — a helper `getSettings(repos)` (added in Task 5's app wiring or first consumer) returns the stored record or creates `{id:'settings', scanRoot: <home>/dev}`; Task 6 must use it — Task 4 left no default — cost if wrong: trivial.
- R14 Ruling: security-review finding accepted as Important — data dir/files created owner-only (dirs 0o700, files 0o600) in FileSessionStore and JsonRepo — transcripts may contain code/secrets — cost if wrong: none.
- R15 Ruling: Task 4 reviewer Minor #3 (torn trailing line / corrupt sidecar makes session unusable) promoted to Important — spec §5.9 "冒險日誌不會無故少頁" — cost if wrong: small extra code.
- R16 Ruling: preflight consumes one tiny Haiku turn per server start (reads to result, then close) — not-logged-in only surfaces after the first API call — cost if wrong: negligible usage per start.
- R17 Ruling: Task 5 reviewer minors 1,2,4,5 folded into fix round 1 as hardening — Host-header allowlist (127.0.0.1:<port>, localhost:<port> for 4517/4518) on HTTP and WS; preflight persistSession:false + tools disabled; startup URL printed only after listening; upgrade socket error handler + small maxPayload — security-sensitive local server, all cheap — cost if wrong: none.
- R18 Ruling: DELETE /api/dungeons/:id returns 204 without broadcast; the client (Task 14) removes it locally / refetches GET /api/dungeons after delete — protocol has no removal variant and adding one isn't needed for single-user — cost if wrong: stale entry in another open tab until reload.
- R19 Ruling: canonical connector prefix = the bare server segment (e.g. `claude_ai_Slack`), used identically in Settings.connectors[].prefix and Npc.equipment.connectorPrefixes; deny rule = `mcp__${prefix}__*` — avoids exact-match mismatch — cost if wrong: trivial.
- R20 Ruling: builtin clerk is exempt from connector deny rules (gets every claude.ai connector) — its job is Jira/GitHub and prefixes are unknown until inventory — cost if wrong: clerk has more connectors than needed (read-only anyway).
- R21 Ruling: plan-mandated "read-only = deny Edit/Write/NotebookEdit" kept for M1 although Bash can still write files under auto mode — spec §5.1 defines 唯讀之戒 exactly as disallowedTools Edit/Write; stronger enforcement (hooks/Bash write denies) needs a design choice — SURFACE TO USER at finish (also affects idle chat forceReadOnly) — cost if wrong: a "read-only" NPC/chat could modify files via shell.
- R22 Ruling: plan-mandated "subagent_end/background_end on tool_result" overridden — for backgrounded tasks the end event comes from system/task_notification (status completed/failed/stopped, summary); spec §5.10 says familiar/campfire ends when the work finishes — cost if wrong: small translate change.
- R23 Ruling: AgentRun outcome.costUsd is the session-cumulative total_cost_usd; consumers (Task 10/11) must store the latest value per session, never sum across resumed runs — SDK doc — cost if wrong: inflated 食量 stats later.
- R24 Ruling: if commitIfDirty throws at quest finish (hooks/GPG), the quest still moves to review and the scroll gets a line `自動提交失敗：<message>` — the work exists in the worktree and the 會長 decides — cost if wrong: uncommitted work reaches review.
- R25 Ruling: questPrompt split — systemPrompt.append carries the standing quest instructions (branch, commit, scroll format); the first user message carries the quest content (title/body/Jira key) — avoids sending the brief twice — cost if wrong: none.
- R26 Ruling: re-starting an open quest with a DIFFERENT NPC reuses the worktree but starts a fresh session (no resume); same NPC resumes — a new NPC shouldn't inherit another's conversation — cost if wrong: lost context for the new NPC (scroll still in prompt).
- R27 Ruling: narrow R20 — once inventory exists, the clerk is equipped only with connectors whose name/prefix matches /atlassian|jira|github/i (fallback: all, if none match); limits prompt-injection blast radius since NPC-written scrolls flow into clerk prompts — cost if wrong: clerk can't reach an oddly-named Jira/GitHub connector (fallback covers zero-match case).
- R28 Ruling: importing a Jira key that already has a quest not in done/abandoned returns that existing quest (200) instead of creating a duplicate, without a clerk run — cost if wrong: user can't intentionally duplicate.
- R29 Ruling: the clerk is denied Bash entirely (the game does all git work) in addition to R27 connector narrowing; Jira-sourced and NPC-sourced text in clerk prompts is fenced as data — prompt-injection hardening — cost if wrong: none.
- R30 Ruling: chat resume validation beyond brief accepted (unknown id 404, other NPC's session 400, quest session 400; resume uses stored entry.cwd) — SDK keys sessions by cwd — cost if wrong: none.
- R31 Ruling: add ServerMessage variant `{type:'preflight'; preflight: Preflight}`; server broadcasts it when the startup check finishes; client store applies it — fixes the placeholder loggedIn:true never updating (Task 5 deferred minor) — cost if wrong: none.
- R32 Ruling: the Nav 信箱 badge opens the crystal panel; Task 15's crystal ball shows a 信箱 section listing ALL pending approvals across sessions (click → opens that session) in addition to per-session letters — mailbox location was unspecified — cost if wrong: small UI move.
- R33 Ruling: when settlement-options returns 502 for a Jira quest, the dialog offers only 推上分支並開 PR and 在瀏覽器打開這張 Jira 票 (Jira-dependent actions hidden) — they'd fail the same way — cost if wrong: user retries settlement later for Jira steps.
- R34 Ruling: Task 16 minor #1 promoted — post-await window.open is likely popup-blocked, so the results screen must also show a 「開啟 Jira 票」 link when openTicket was chosen (spec §5.8 action must work) — cost if wrong: none.
- R35 Ruling: if a chosen pushAndPr step fails, settlement records results but the quest STAYS in review (re-settle possible; user unchecks Jira steps that already succeeded); results show branch + worktree path — plan said accept unconditionally, but that dead-ends the user — cost if wrong: user must re-open settlement.
- R36 Ruling: clerk gets an explicit deny of built-in non-connector tools (Read, Glob, Grep, WebFetch, WebSearch, Task, Agent, NotebookEdit, TodoWrite) instead of `tools: []`, to avoid breaking json_schema structured output — cost if wrong: verify in manual E2E.
- R37 Ruling: all NPCs also deny `Bash(gh pr *)` and `Bash(gh api *)`; README states push blocking is best-effort — cost if wrong: none.

## 暫緩處理（parked）

- parked — empty inventory saved when status never settles disables deny rules until 盤點倉庫 — Ruling: narrow trigger, falls back to prior default, manual escape; surface to user.
- parked — launch waits behind clerk queue when no inventory (≤15s or clerk cap) — Ruling: only when startup inventory failed; acceptable for M1.
- parked — lastSettlementAttempt not cleared on reject/abandon; Jira steps re-run on re-settle unless unchecked — Ruling: by design R35; UI polish later.
- Parked (final review minors, not fixed): settlement dialog can't show clerk approvals (clerk rarely asks in auto mode); worktree base = main checkout HEAD not defaultBranch (user's current branch may be intentional); gitignored local settings (.claude/settings.local.json, CLAUDE.local.md) absent in worktrees — Ruling: surface to user, defer.

## 端到端驗證

# M1 real-SDK e2e report (branch feat/m1-real-work-loop, real claude.ai login)


1. PASS - `npm start` built the client and served on 4517; URL and token printed.
2. PASS - GET /api/preflight: loggedIn=true, apiKeySource="none", warnings=[]. The real result (apiKeySource present) was already in place within ~25s of start.
3. PASS - POST /api/inventory/refresh listed the account's claude.ai connectors; a Jira (Atlassian) connector was connected. No github-like connector.
4. PASS - POST /api/dungeons gave 201; path is realpath'd to /private/tmp/..., defaultBranch main, no githubRepo.
5. PASS - quest created and started (alex). Worktree created and branch `loc/<questId>`. WS event kinds seen: text, tool_start, tool_end, result (plus quest and npc messages). No compact/subagent/background/error events in this run. Tools: Bash, Read/Edit, git commit. The agent reproduced the failure, fixed `a - b` to `a + b`, added a test assertion and committed.
6. PASS - POST /message returned 204. It was injected mid-run: a second `result` event followed ("已經 commit 過了…沒有新的改動"). It did not cause a duplicate commit.
7. PASS - status=review in ~24s. Scroll starts "會長，已經 commit 過了，這次沒有新的改動。- commit: 5d2f2cf Fix sum() to add instead of subtract…" with the diffstat. Branch loc/8eca4dfe-…; worktree /tmp/loc-e2e-data.zGMb/worktrees/loc-8eca4dfe-…. The worktree has the fix commit, a clean status, and `npm test` prints ok. No git push attempted (none in logs, no remote). GET /api/approvals stayed [] throughout.
8. PASS - POST /reject returned 200 (status adventuring, rejections=1). sessionId stayed b42b7eb3-… and the quest returned to review with a new commit (562b2bb, comment added); tests still pass.
9. PASS - GET /api/sessions listed the session (cost 0.0135 USD, live=false). /messages returned 25 messages: assistant tool_use x9, user tool_result x9, assistant text x4, user text x3 (the user texts are the prompt, the mid-run message and the reject feedback).
10. PASS - toby quest started, server killed with kill -9 while adventuring (quests.json showed adventuring, toby.busyQuestId set). After restart: quest status=open, scroll "冒險被中斷（伺服器重啟）", toby busyQuestId cleared, no sessions live, worktree and branch kept.
11. PASS - POST /api/jira/import ZZZTEST-999999 returned 400 in 13.8s: "Jira 回傳 404：Issue does not exist or you do not have permission to see it（站台 …）。…未做任何修改。" Events: ToolSearch, getAccessibleAtlassianResources, getJiraIssue (failed), StructuredOutput, result. Structured output and the connector wait worked. The only calls were read-only lookups.
12. PASS - POST /api/chats (lina) returned {sessionId} in 0.4s. Events streamed (text then result). Transcript has the user text and the assistant reply: "我是學者莉娜，專門讀程式碼的人：…". Cost 0.125 USD.
Extra - PASS - settle with all options false returned 200 with accepted:true and results:[]; quest status done. No network or LLM calls.
13. PASS - server stopped (port 4517 free). git status of the repo is clean.

## Bugs / observations (none blocking)
- B1 (minor, UX): after POST /reject, quest.scroll still holds the previous scroll while status=adventuring (stale until the new result). Repro: reject a review quest, then GET /api/quests during the run.
- B2 (minor): the Jira 404 message includes the Atlassian site hostname, which the clerk takes from the connector. Not a bug, but it exposes the site name in API and UI text.
- B3 (info): a message sent mid-run is queued and processed after the current turn's `result`, so one quest emits two `result` events before review. A client that treats the first `result` as completion would show it early. The quest status only went to review after the second result.
- B4 (info): chat events have no questId (as designed) and the `text` and `result` events carry the same body, so the chat panel may show the reply twice if it renders both.
- No errors, no unhandled rejections in server logs (only the start banner and the inventory line).
