import { randomUUID } from 'node:crypto';
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';
import { transition, type Dungeon, type Npc, type Quest, type QuestSource, type ServerMessage } from '@loc/shared';
import type { ApprovalBroker } from '../agent/approvals.js';
import { buildAgentOptions, connectorPrefixesFrom } from '../agent/options.js';
import type { QueryFn } from '../agent/queryFn.js';
import { AgentRun, RECALLED, type RunOutcome } from '../agent/runner.js';
import { branchName, commitIfDirty, createWorktree, diffStat, worktreeExists } from '../git/worktree.js';
import { sdkEnv } from '../preflight.js';
import type { Repos } from '../store/jsonRepo.js';
import { getSettings } from '../store/settings.js';
import { CONTINUE_PREFIX, questPrompt, rejectPrompt } from './prompts.js';

export const INTERRUPTED_BY_RESTART = '冒險被中斷（伺服器重啟）';
const QUEST_BUSY = '這個委託正在進行中，請先召回';
const NO_ACTIVE_RUN = '這個委託沒有進行中的冒險';

/** A service error carrying the HTTP status the routes answer with. Messages are shown to the player. */
export class QuestServiceError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NpcBusyError extends QuestServiceError {
  constructor(npcName: string) {
    super(`${npcName}正在冒險中`, 409);
  }
}

export class NotFoundError extends QuestServiceError {
  constructor(message: string) {
    super(message, 404);
  }
}

export class ValidationError extends QuestServiceError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class ConflictError extends QuestServiceError {
  constructor(message: string) {
    super(message, 409);
  }
}

export interface QuestServiceDeps {
  repos: Repos;
  hub: { broadcast(msg: ServerMessage): void };
  broker: ApprovalBroker;
  queryFn: QueryFn;
  dataDir: string;
  sessionStore: SessionStore;
  /** Env for SDK child processes; defaults to `sdkEnv().env` (API-key variables removed). */
  env?: Record<string, string | undefined>;
}

export interface CreateQuestInput {
  title: string;
  body: string;
  stars?: 1 | 2 | 3 | 4 | 5;
  source?: QuestSource;
}

interface LaunchParams {
  action: 'start' | 'reject';
  prompt: string;
  resume?: string;
  /** Fields set on the quest together with the transition (worktree placement, rejections). */
  patch: Partial<Quest>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function appendLine(scroll: string | undefined, line: string): string {
  return scroll ? `${scroll}\n\n${line}` : line;
}

function withoutBusy(npc: Npc): Npc {
  const next = { ...npc };
  delete next.busyQuestId;
  return next;
}

/** 委託 lifecycle: create -> start (worktree + AgentRun) -> finish -> review, plus 傳信, 召回, 退回, abandon. */
export class QuestService {
  private readonly runs = new Map<string, AgentRun>();
  /** npcId -> questId. Claimed synchronously, so two quick starts for one NPC can never both pass. */
  private readonly busyNpcs = new Map<string, string>();
  /** Quests with a lifecycle operation or a run in flight; released when the run's finish is handled. */
  private readonly claimedQuests = new Set<string>();
  private readonly settledRuns = new Map<string, Promise<void>>();
  /** Serializes read-modify-write of quest/npc records. */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: QuestServiceDeps) {}

  list(): Promise<Quest[]> {
    return this.deps.repos.quests.list();
  }

  async create(input: CreateQuestInput): Promise<Quest> {
    const title = input.title.trim();
    if (!title) throw new ValidationError('委託標題不能空白');
    const stars = input.stars ?? 2;
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new ValidationError('星等必須是 1 到 5');
    const now = Date.now();
    const quest: Quest = {
      id: randomUUID(),
      title,
      body: input.body,
      stars,
      status: 'open',
      source: input.source ?? { kind: 'local' },
      rejections: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repos.quests.put(quest);
    this.deps.hub.broadcast({ type: 'quest', quest });
    return quest;
  }

  /** 出發. A quest that already has a worktree (after 召回 / restart) reuses it and resumes its session. */
  async start(questId: string, target: { npcId: string; dungeonId: string }): Promise<Quest> {
    const { npcId, dungeonId } = target;
    // Both claims happen before the first await: a double click must not open two sessions.
    if (this.busyNpcs.has(npcId)) throw new NpcBusyError(await this.npcName(npcId));
    if (this.claimedQuests.has(questId)) throw new ConflictError(QUEST_BUSY);
    this.busyNpcs.set(npcId, questId);
    this.claimedQuests.add(questId);
    try {
      const quest = await this.mustGetQuest(questId);
      const npc = await this.mustGetNpc(npcId);
      const dungeon = await this.mustGetDungeon(dungeonId);
      if (npc.busyQuestId) throw new NpcBusyError(npc.name);
      transition(quest.status, 'start'); // validate before touching git

      if (quest.worktreePath && (await worktreeExists(quest.worktreePath))) {
        if (quest.dungeonId && quest.dungeonId !== dungeonId) throw new ValidationError('這個委託已在另一座地下城開始過，請選原本的地下城');
        const briefing = questPrompt(quest, dungeon);
        const resume = quest.sessionId;
        return await this.launch(quest, npc, dungeon, {
          action: 'start',
          prompt: resume ? `${CONTINUE_PREFIX}\n\n${briefing}` : briefing,
          ...(resume ? { resume } : {}),
          patch: { dungeonId },
        });
      }

      const branch = branchName(quest);
      const { worktreePath, baseBranch } = await createWorktree(dungeon.path, this.deps.dataDir, branch);
      const placed = { ...quest, branch, worktreePath, baseBranch, dungeonId };
      return await this.launch(quest, npc, dungeon, {
        action: 'start',
        prompt: questPrompt(placed, dungeon),
        patch: { branch, worktreePath, baseBranch, dungeonId },
      });
    } catch (err) {
      this.release(questId, npcId);
      throw err;
    }
  }

  /** 傳信: forward a message to the quest's running NPC. */
  async message(questId: string, text: string): Promise<void> {
    if (!text.trim()) throw new ValidationError('信的內容不能空白');
    const run = await this.mustGetRun(questId);
    try {
      run.send(text);
    } catch (err) {
      throw new ConflictError(errorText(err));
    }
  }

  /** 召回: stop the running NPC; the quest returns to open with 「已被召回」 in its scroll. */
  async recall(questId: string): Promise<Quest> {
    const run = await this.mustGetRun(questId);
    await run.recall();
    await this.settled(questId);
    return this.mustGetQuest(questId);
  }

  /** 退回: send the quest back to the same NPC, resuming its session with the guild master's feedback. */
  async reject(questId: string, feedback: string): Promise<Quest> {
    const text = feedback.trim();
    if (!text) throw new ValidationError('請寫下退回的理由');
    if (this.claimedQuests.has(questId)) throw new ConflictError(QUEST_BUSY);
    this.claimedQuests.add(questId);
    let claimedNpc: string | undefined;
    try {
      const quest = await this.mustGetQuest(questId);
      transition(quest.status, 'reject');
      if (!quest.npcId || !quest.dungeonId || !quest.worktreePath || !quest.sessionId) {
        throw new ConflictError('這個委託沒有可續用的冒險紀錄');
      }
      const npc = await this.mustGetNpc(quest.npcId);
      const dungeon = await this.mustGetDungeon(quest.dungeonId);
      // Checked and claimed in one synchronous step.
      if (this.busyNpcs.has(npc.id) || npc.busyQuestId) throw new NpcBusyError(npc.name);
      this.busyNpcs.set(npc.id, questId);
      claimedNpc = npc.id;
      return await this.launch(quest, npc, dungeon, {
        action: 'reject',
        prompt: rejectPrompt(text),
        resume: quest.sessionId,
        patch: { rejections: quest.rejections + 1 },
      });
    } catch (err) {
      this.release(questId, claimedNpc);
      throw err;
    }
  }

  async abandon(questId: string): Promise<Quest> {
    if (this.claimedQuests.has(questId)) throw new ConflictError(QUEST_BUSY);
    this.claimedQuests.add(questId);
    try {
      return await this.patchQuest(questId, (q) => ({ ...q, status: transition(q.status, 'abandon'), updatedAt: Date.now() }));
    } finally {
      this.claimedQuests.delete(questId);
    }
  }

  /** Startup: nothing runs yet, so every adventuring quest was cut off by a restart. Worktrees are kept. */
  async recoverInterrupted(): Promise<void> {
    for (const quest of await this.deps.repos.quests.list()) {
      if (quest.status !== 'adventuring' || this.claimedQuests.has(quest.id)) continue;
      await this.patchQuest(quest.id, (q) =>
        q.status !== 'adventuring'
          ? q
          : { ...q, status: transition(q.status, 'interrupt'), scroll: appendLine(q.scroll, INTERRUPTED_BY_RESTART), updatedAt: Date.now() },
      );
    }
    for (const npc of await this.deps.repos.npcs.list()) {
      if (npc.busyQuestId && !this.busyNpcs.has(npc.id)) await this.patchNpc(npc.id, withoutBusy);
    }
  }

  /** Resolves once the quest's current run has ended and its finish was handled. */
  settled(questId: string): Promise<void> {
    return this.settledRuns.get(questId) ?? Promise.resolve();
  }

  private async launch(quest: Quest, npc: Npc, dungeon: Dungeon, params: LaunchParams): Promise<Quest> {
    const { repos, hub, broker, queryFn, sessionStore } = this.deps;
    const placed: Quest = { ...quest, ...params.patch };
    const worktreePath = placed.worktreePath;
    const baseBranch = placed.baseBranch;
    if (!worktreePath || !baseBranch) throw new ConflictError('這個委託沒有工作目錄');

    // Everything that can fail runs before any state is written.
    const settings = await getSettings(repos);
    const options = buildAgentOptions({
      npc,
      cwd: worktreePath,
      appendPrompt: questPrompt(placed, dungeon),
      allConnectorPrefixes: connectorPrefixesFrom(settings),
      sessionStore,
      env: this.deps.env ?? sdkEnv().env,
      ...(params.resume ? { resume: params.resume } : {}),
    });

    const started = await this.patchQuest(quest.id, (q) => ({
      ...q,
      ...params.patch,
      status: transition(q.status, params.action),
      npcId: npc.id,
      updatedAt: Date.now(),
    }));
    await this.patchNpc(npc.id, (n) => ({ ...n, busyQuestId: quest.id }));

    const run = AgentRun.start({
      queryFn,
      options,
      prompt: params.prompt,
      npcId: npc.id,
      questId: quest.id,
      broker,
      onEvent: (event) => hub.broadcast({ type: 'event', event }),
    });
    this.runs.set(quest.id, run);
    const initHandled = run.init.then(
      (info) => this.onInit(started, npc, worktreePath, info),
      () => undefined,
    );
    this.settledRuns.set(
      quest.id,
      run.done.then((outcome) => this.finish(started, npc.id, run, outcome, initHandled, { worktreePath, baseBranch })),
    );
    return started;
  }

  private async onInit(quest: Quest, npc: Npc, worktreePath: string, info: { sessionId: string; permissionMode: string }): Promise<void> {
    try {
      const existing = await this.deps.repos.sessions.get(info.sessionId);
      await this.deps.repos.sessions.put({
        ...existing,
        id: info.sessionId,
        npcId: npc.id,
        questId: quest.id,
        title: quest.title,
        cwd: worktreePath,
        updatedAt: Date.now(),
      });
      await this.patchQuest(quest.id, (q) => (q.sessionId === info.sessionId ? q : { ...q, sessionId: info.sessionId, updatedAt: Date.now() }));
      // Auto mode was refused (e.g. unsupported model or plan): this NPC goes cautious from now on.
      if (info.permissionMode !== 'auto') await this.patchNpc(npc.id, (n) => (n.cautious ? n : { ...n, cautious: true }));
    } catch (err) {
      console.error(`[委託 ${quest.id}] 記錄 session 失敗：${errorText(err)}`);
    }
  }

  private async finish(
    quest: Quest,
    npcId: string,
    run: AgentRun,
    outcome: RunOutcome,
    initHandled: Promise<void>,
    place: { worktreePath: string; baseBranch: string },
  ): Promise<void> {
    if (this.runs.get(quest.id) === run) this.runs.delete(quest.id);
    await initHandled;
    try {
      let action: 'finish' | 'interrupt';
      let scroll: string;
      if (outcome.ok) {
        action = 'finish';
        scroll = await this.reviewScroll(quest, outcome.resultText ?? '', place);
      } else {
        action = 'interrupt';
        const errors = outcome.errors ?? [];
        scroll = errors.includes(RECALLED) ? RECALLED : `冒險失敗：${errors.join('；') || '未知原因'}`;
      }
      await this.patchQuest(quest.id, (q) => ({
        ...q,
        status: transition(q.status, action),
        scroll,
        ...(outcome.sessionId && !q.sessionId ? { sessionId: outcome.sessionId } : {}),
        updatedAt: Date.now(),
      }));
      if (outcome.sessionId) await this.touchSession(outcome.sessionId, outcome.costUsd);
    } catch (err) {
      console.error(`[委託 ${quest.id}] 結束處理失敗：${errorText(err)}`);
    } finally {
      try {
        await this.patchNpc(npcId, (n) => (n.busyQuestId === quest.id ? withoutBusy(n) : n));
      } catch (err) {
        console.error(`[委託 ${quest.id}] 無法釋放冒險者：${errorText(err)}`);
      }
      this.release(quest.id, npcId);
    }
  }

  /** Commits leftovers (R24: a failed commit still goes to review, noted in the scroll) and lists the changes. */
  private async reviewScroll(quest: Quest, resultText: string, place: { worktreePath: string; baseBranch: string }): Promise<string> {
    let commitError: string | undefined;
    try {
      await commitIfDirty(place.worktreePath, `loc: ${quest.title}`);
    } catch (err) {
      commitError = errorText(err);
    }
    let stat: string;
    try {
      stat = (await diffStat(place.worktreePath, place.baseBranch)).trimEnd() || '（沒有變更）';
    } catch (err) {
      stat = `（無法取得變更：${errorText(err)}）`;
    }
    const scroll = `${resultText}\n\n變更：\n${stat}`;
    return commitError ? appendLine(scroll, `自動提交失敗：${commitError}`) : scroll;
  }

  /** R23: `costUsd` is the session's cumulative total, so the latest value replaces the stored one. */
  private async touchSession(sessionId: string, costUsd: number): Promise<void> {
    const entry = await this.deps.repos.sessions.get(sessionId);
    if (entry) await this.deps.repos.sessions.put({ ...entry, updatedAt: Date.now(), costUsd });
  }

  private release(questId: string, npcId: string | undefined): void {
    this.claimedQuests.delete(questId);
    if (npcId !== undefined && this.busyNpcs.get(npcId) === questId) this.busyNpcs.delete(npcId);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.lock.then(fn, fn);
    this.lock = result.catch(() => undefined);
    return result;
  }

  /** Read-modify-write of one quest; broadcasts when `fn` returns a new object. */
  private patchQuest(id: string, fn: (q: Quest) => Quest): Promise<Quest> {
    return this.serial(async () => {
      const current = await this.deps.repos.quests.get(id);
      if (!current) throw new NotFoundError('找不到這個委託');
      const next = fn(current);
      if (next === current) return current;
      await this.deps.repos.quests.put(next);
      this.deps.hub.broadcast({ type: 'quest', quest: next });
      return next;
    });
  }

  private patchNpc(id: string, fn: (n: Npc) => Npc): Promise<Npc> {
    return this.serial(async () => {
      const current = await this.deps.repos.npcs.get(id);
      if (!current) throw new NotFoundError('找不到這位冒險者');
      const next = fn(current);
      if (next === current) return current;
      await this.deps.repos.npcs.put(next);
      this.deps.hub.broadcast({ type: 'npc', npc: next });
      return next;
    });
  }

  private async mustGetRun(questId: string): Promise<AgentRun> {
    const run = this.runs.get(questId);
    if (run) return run;
    await this.mustGetQuest(questId);
    throw new ConflictError(NO_ACTIVE_RUN);
  }

  private async mustGetQuest(id: string): Promise<Quest> {
    const quest = await this.deps.repos.quests.get(id);
    if (!quest) throw new NotFoundError('找不到這個委託');
    return quest;
  }

  private async mustGetNpc(id: string): Promise<Npc> {
    const npc = await this.deps.repos.npcs.get(id);
    if (!npc) throw new NotFoundError('找不到這位冒險者');
    return npc;
  }

  private async mustGetDungeon(id: string): Promise<Dungeon> {
    const dungeon = await this.deps.repos.dungeons.get(id);
    if (!dungeon) throw new NotFoundError('找不到這座地下城');
    return dungeon;
  }

  private async npcName(id: string): Promise<string> {
    return (await this.deps.repos.npcs.get(id))?.name ?? id;
  }
}
