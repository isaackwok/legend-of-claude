import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';
import type { Npc, ServerMessage } from '@loc/shared';
import type { ApprovalBroker } from '../agent/approvals.js';
import { buildAgentOptions, connectorPrefixesFrom } from '../agent/options.js';
import type { QueryFn } from '../agent/queryFn.js';
import { AgentRun } from '../agent/runner.js';
import { sdkEnv } from '../preflight.js';
import type { Repos } from '../store/jsonRepo.js';
import { getSettings } from '../store/settings.js';

const TITLE_MAX = 30;

/** A chat error carrying the HTTP status the route answers with. Messages are shown to the player. */
export class ChatError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 | 502,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

export interface ChatServiceDeps {
  repos: Repos;
  hub: { broadcast(msg: ServerMessage): void };
  broker: ApprovalBroker;
  queryFn: QueryFn;
  dataDir: string;
  sessionStore: SessionStore;
  /** Env for SDK child processes; defaults to `sdkEnv().env` (API-key variables removed). */
  env?: Record<string, string | undefined>;
}

export interface SayInput {
  npcId: string;
  text: string;
  sessionId?: string;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** First message, single-lined and cut to 30 characters (code points, so CJK and emoji never split). */
function titleOf(text: string): string {
  return [...text.trim().replace(/\s+/g, ' ')].slice(0, TITLE_MAX).join('');
}

/** 閒聊: one `AgentRun` per message turn, always read-only; follow-up turns `resume` the same session. */
export class ChatService {
  /** sessionId -> its running chat turn. */
  private readonly runs = new Map<string, AgentRun>();
  /** Sessions with a turn starting or running; resumed ids are claimed before the first await. */
  private readonly claimed = new Set<string>();
  private readonly settledRuns = new Set<Promise<void>>();

  constructor(private readonly deps: ChatServiceDeps) {}

  /** Session ids with a chat turn running right now (read-only; for the crystal ball). */
  liveSessionIds(): string[] {
    return [...this.runs.keys()];
  }

  /** Resolves once every chat turn started so far has ended and been recorded. */
  async idle(): Promise<void> {
    while (this.settledRuns.size > 0) await Promise.all([...this.settledRuns]);
  }

  /** Sends one message; resolves with the session id as soon as the NPC's session started, not when it finished replying. */
  async say(input: SayInput): Promise<{ sessionId: string }> {
    const { repos, hub, broker, queryFn, sessionStore } = this.deps;
    const resumeId = input.sessionId;
    // Session ids this turn holds; a resumed id is claimed before the first await, so a double send
    // can never open two turns on one session.
    const held = new Set<string>();
    const hold = (id: string) => {
      held.add(id);
      this.claimed.add(id);
    };
    const release = () => {
      for (const id of held) {
        this.claimed.delete(id);
        this.runs.delete(id);
      }
    };
    if (resumeId !== undefined) {
      if (this.claimed.has(resumeId)) throw new ChatError(`${await this.npcName(input.npcId)}還在回話中`, 409);
      hold(resumeId);
    }

    let run: AgentRun;
    let npc: Npc;
    let cwd: string;
    const text = input.text.trim();
    try {
      if (!text) throw new ChatError('請說點什麼', 400);
      const found = await repos.npcs.get(input.npcId);
      if (!found) throw new ChatError('找不到這位冒險者', 404);
      npc = found;
      if (npc.builtin === 'clerk') throw new ChatError(`${npc.name}只辦文書，不閒聊；要請她辦事，請到公會櫃檯`, 400);
      if (npc.busyQuestId) throw new ChatError(`${npc.name}正在冒險，請到水晶球傳信`, 409);

      if (resumeId !== undefined) {
        const entry = await repos.sessions.get(resumeId);
        if (!entry) throw new ChatError('找不到這段對話', 404);
        if (entry.npcId !== npc.id) throw new ChatError(`這段對話不是和${npc.name}的`, 400);
        if (entry.questId !== undefined) throw new ChatError('委託的冒險紀錄不能閒聊，請到水晶球傳信', 400);
        // A session is stored under its cwd, so a resume has to run where it started.
        cwd = entry.cwd;
      } else {
        cwd = await this.chatCwd(npc);
      }

      const settings = await getSettings(repos);
      const options = buildAgentOptions({
        npc,
        cwd,
        allConnectorPrefixes: connectorPrefixesFrom(settings),
        sessionStore,
        env: this.deps.env ?? sdkEnv().env,
        forceReadOnly: true,
        ...(resumeId !== undefined ? { resume: resumeId } : {}),
      });
      run = AgentRun.start({ queryFn, options, prompt: text, npcId: npc.id, broker, onEvent: (event) => hub.broadcast({ type: 'event', event }) });
    } catch (err) {
      release();
      throw err;
    }

    const started = run;
    const recorded = started.init.then(async (info) => {
      hold(info.sessionId);
      this.runs.set(info.sessionId, started);
      await this.recordInit(info.sessionId, npc.id, cwd, text);
      return info.sessionId;
    });
    // Every turn is settled the same way: cost + updatedAt once it has its result, then the claims are freed.
    const settled: Promise<void> = Promise.allSettled([recorded, started.done])
      .then(async () => {
        const outcome = await started.done;
        if (outcome.sessionId) await this.touch(outcome.sessionId, outcome.costUsd);
      })
      .catch((err: unknown) => console.error(`[閒聊 ${npc.name}] 結束處理失敗：${errorText(err)}`))
      .finally(() => {
        release();
        this.settledRuns.delete(settled);
      });
    this.settledRuns.add(settled);

    try {
      return { sessionId: await recorded };
    } catch (err) {
      // Never started (or its record could not be written): end the turn before answering.
      await started.recall().catch(() => undefined);
      await settled;
      throw new ChatError(`${npc.name}沒有回應：${errorText(err)}`, 502);
    }
  }

  /** The NPC's home dungeon, else a tavern folder of its own under the game data. */
  private async chatCwd(npc: Npc): Promise<string> {
    const home = npc.homeDungeonId ? await this.deps.repos.dungeons.get(npc.homeDungeonId) : undefined;
    if (home) return home.path;
    const tavern = join(this.deps.dataDir, 'tavern');
    await mkdir(tavern, { recursive: true, mode: 0o700 });
    return tavern;
  }

  /** Index entry for a chat session; an existing title (the first message) is kept on later turns. */
  private async recordInit(sessionId: string, npcId: string, cwd: string, text: string): Promise<void> {
    const { sessions } = this.deps.repos;
    const existing = await sessions.get(sessionId);
    await sessions.put({ ...existing, id: sessionId, npcId, title: existing?.title ?? titleOf(text), cwd, updatedAt: Date.now() });
  }

  /** R23: `costUsd` is the session's cumulative total, so only the larger value is kept, never a sum. */
  private async touch(sessionId: string, costUsd: number): Promise<void> {
    const { sessions } = this.deps.repos;
    const entry = await sessions.get(sessionId);
    if (entry) await sessions.put({ ...entry, updatedAt: Date.now(), costUsd: Math.max(entry.costUsd ?? 0, costUsd) });
  }

  private async npcName(id: string): Promise<string> {
    return (await this.deps.repos.npcs.get(id))?.name ?? id;
  }
}
