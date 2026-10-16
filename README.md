# 克勞德傳說 (Legend of Claude)

A local web RPG where your NPCs are Claude Agent SDK agents that do real work on your real projects.

克勞德傳說是一個只在本機執行的網頁遊戲：你是公會會長，NPC 是真正的 Claude Code 代理人。把一個專案登記成「地下城」，貼上或匯入「委託」，派給 NPC，看他在「水晶球」裡一步一步做事，完成後在「待驗收」審核並「結算」。

## 需求

- Node.js 22 以上（建議用 `.nvmrc` 指定的 Node 24：`nvm use`）。
- 已安裝 Claude Code，並用 claude.ai 帳號登入過一次：在終端機執行 `claude`，輸入 `/login`。
- NPC 一律走 claude.ai 訂閱與你的 connectors（Jira、GitHub 等）。環境變數 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 會被忽略，畫面上會顯示「已忽略」提示。
- 要在結算時推上分支並開 PR，專案需有 GitHub remote，且 claude.ai 已連上 GitHub connector。要匯入 Jira 票，需連上 Atlassian connector。

## 啟動

```bash
nvm use
npm install
```

開發模式（Vite 熱更新，伺服器自動重啟）：

```bash
npm run dev
```

啟動後終端機會印出 `http://127.0.0.1:4518/?token=…`，用瀏覽器開這個網址。

正式模式（先建置前端，再由伺服器單一埠提供頁面與 API）：

```bash
npm start
```

終端機會印出 `http://127.0.0.1:4517/?token=…`，用瀏覽器開這個網址。每次啟動都會產生新的 token，網址要整串打開；不要把這個網址分享出去。

其他指令：`npm test`（全部測試）、`npm run typecheck`（型別檢查）。

啟動時伺服器會做一次「啟動檢查」，會用 Haiku 發一個極小的請求確認登入狀態，這會消耗一點點訂閱用量。

## 資料夾

遊戲資料放在 `~/.legend-of-claude/`（委託、NPC、地下城登記、冒險日誌、NPC 的 git worktree 等）。要換位置，啟動前設定 `LOC_DATA_DIR`：

```bash
LOC_DATA_DIR=/path/to/data npm start
```

## 基本玩法

畫面上方有三個分頁：「佈告欄」（委託看板）、「水晶球」（即時觀看與傳信）、「地下城地圖」（專案）。

1. 登記地下城：進入「地下城地圖」，按「掃描」讓遊戲找出資料夾底下的 git 專案（可填掃描資料夾，留空使用預設的 `~/dev`），從「掃描到的專案」登記；也可以「手動登記」輸入專案路徑。
2. 建立委託：在「佈告欄」按「貼新委託」，貼上標題與說明；或切換成「從 Jira 匯入委託」，輸入票號（需要 Atlassian connector）。
3. 派出冒險者：在委託卡片上選一位 NPC 出發。NPC 會在這個專案的獨立 git worktree 與分支裡工作，卡片進入「冒險中」。同一位 NPC 同時只執行一個委託。
4. 觀看與傳信：在「水晶球」即時看到工具呼叫與回覆，也可以隨時對 NPC 傳信。NPC 需要你批准某個動作時，會送來「信鴿」（右上角信箱會顯示件數），你可以同意或拒絕。
5. 驗收：NPC 完成後，委託進入「待驗收」，「卷軸」會列出說明與變更檔案。你可以退回並附上理由（同一位 NPC 會用同一個 session 繼續），或驗收。
6. 結算：驗收後選擇結算方式，例如「推上分支並開 PR」，完成後會顯示 PR 連結。結算由「公會櫃檯」（內建的書記 NPC）透過你的 connectors 處理。

## 安全注意事項

- 伺服器只綁 `127.0.0.1`。API 與 WebSocket 需要 token；頁面本身不需要。所有 HTTP 與 WebSocket 都要驗 `Origin` 與 `Host`，頁面本身也只回應 loopback 的 Host（防 DNS rebinding）。
- token 會出現在終端機輸出的網址裡，也會存在瀏覽器的 sessionStorage（開頁面後網址列上的 token 會被移除）。能看到你終端機或這個瀏覽器分頁的人就能操作遊戲。
- NPC 在 Claude Code 的 auto mode 下執行，行為和你在同一個專案用 Claude Code auto mode 一樣：多數動作會自動放行，不會每次詢問，所以「信鴿」不常出現。遊戲永遠不會使用 `bypassPermissions`。
- NPC 在獨立的 git worktree（獨立分支）裡工作，不會直接改你目前檢出的工作目錄。但這不是沙盒：auto mode 下的 NPC 仍可能執行 worktree 之外的 shell 指令（例如操作其他目錄的檔案），請只對你信任的專案與委託內容使用。
- 推上分支與開 PR 應該由遊戲在你按下「結算」時才做。遊戲會封鎖 NPC 執行常見寫法的 `git push`、`gh pr` 與 `gh api` 指令，但這只是盡力而為：換個寫法（例如透過別的指令、腳本或別名間接執行）仍可能繞過封鎖。worktree 也不是沙盒。
- 「唯讀」的 NPC 只是封鎖 Edit、Write 與 NotebookEdit 工具。它仍然能用 shell 指令（例如重新導向或 `sed -i`）寫檔，所以「唯讀」不是強制的安全邊界。需要真正隔離時，請不要把敏感專案派給它。
- NPC 的所有用量都計入你的 claude.ai 訂閱額度。
- 資料夾內的冒險日誌可能包含程式碼與機密，遊戲建立的資料夾與檔案只有你自己能讀寫。
