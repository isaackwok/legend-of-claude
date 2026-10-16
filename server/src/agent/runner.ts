import { randomUUID } from 'node:crypto';
import type { CanUseTool, Options, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { GameEvent } from '@loc/shared';
import type { ApprovalBroker } from './approvals.js';
import type { QueryFn } from './queryFn.js';
import { summarizeTool, ToolTracker, translate } from './translate.js';

export const RECALLED = '已被召回';
export const NOT_STARTED = '冒險尚未開始，無法執行';
export const CANCELLED = '請求已取消';
/** How long `recall()` waits for the SDK to wind down after `interrupt()` before force-closing it. */
const RECALL_GRACE_MS = 5000;

export interface RunOutcome {
  ok: boolean;
  resultText?: string;
  structured?: unknown;
  sessionId: string;
  costUsd: number;
  errors?: string[];
}

export interface AgentRunParams {
  queryFn: QueryFn;
  options: Options;
  prompt: string;
  npcId: string;
  questId?: string;
  broker: ApprovalBroker;
  onEvent: (e: GameEvent) => void;
  /**
   * Runs once the query exists and before the prompt is sent (e.g. waiting for connectors to connect).
   * If it rejects, the prompt is never sent and the run ends failed with the rejection's message.
   */
  beforePrompt?: (query: Query) => Promise<void>;
}

/** Async push-queue used as the streaming prompt. Items pushed before `end()` are still delivered. */
class InputQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;

  push(item: T): void {
    if (this.ended) throw new Error('input stream already ended');
    this.items.push(item);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  get isEnded(): boolean {
    return this.ended;
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((r) => (this.waiter = r));
    }
  }
}

function userMessage(text: string, priority?: SDKUserMessage['priority']): SDKUserMessage {
  // uuid-stamped so an interrupt receipt's `still_queued` can list it.
  const m: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' }, uuid: randomUUID() };
  if (priority !== undefined) m.priority = priority;
  return m;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** One running NPC session in streaming-input mode: one prompt, one result. Follow-ups use `resume`. */
export class AgentRun {
  readonly init: Promise<{ sessionId: string; permissionMode: string }>;
  readonly done: Promise<RunOutcome>;

  private readonly input = new InputQueue<SDKUserMessage>();
  private readonly tracker = new ToolTracker();
  /** Aborted on recall and when the run ends, so waiting approvals never outlive the run. */
  private readonly lifetime = new AbortController();
  private query: Query | undefined;
  private sessionId = '';
  private recalled = false;
  private recallPromise: Promise<void> | undefined;
  private resolveInit!: (v: { sessionId: string; permissionMode: string }) => void;
  private rejectInit!: (e: Error) => void;
  private initSeen = false;
  private prepError: string | undefined;

  private constructor(private readonly params: AgentRunParams) {
    this.init = new Promise((resolve, reject) => {
      this.resolveInit = resolve;
      this.rejectInit = reject;
    });
    this.init.catch(() => {});
    if (!params.beforePrompt) this.input.push(userMessage(params.prompt));
    this.done = this.run();
  }

  static start(params: AgentRunParams): AgentRun {
    return new AgentRun(params);
  }

  /** 傳信: queue a message for the running NPC. Throws once the run has its result or was recalled. */
  send(text: string): void {
    if (this.input.isEnded) throw new Error('這趟冒險已經結束，無法再傳信');
    this.input.push(userMessage(text, 'next'));
  }

  /** 召回: interrupt the NPC, end its input, deny its pending approvals. Safe to call more than once. */
  recall(): Promise<void> {
    this.recallPromise ??= this.doRecall();
    return this.recallPromise;
  }

  private async doRecall(): Promise<void> {
    this.recalled = true;
    // Deny waiting approvals first: interrupt() may not return while a permission request is open.
    this.lifetime.abort();
    if (this.sessionId) this.params.broker.cancelForSession(this.sessionId);
    let receipt: Awaited<ReturnType<Query['interrupt']>> | 'timeout' | undefined;
    try {
      if (this.query) receipt = await withTimeout(this.query.interrupt(), RECALL_GRACE_MS);
    } catch {
      // The query may already be finished; recall still has to end everything below.
    }
    this.input.end();
    // Queued 傳信 that survived the interrupt would start a new turn: stop the session outright.
    const stillQueued = receipt !== 'timeout' && (receipt?.still_queued?.length ?? 0) > 0;
    if (stillQueued) this.closeQuery();
    const finished = await withTimeout(this.done, RECALL_GRACE_MS);
    if (finished === 'timeout') {
      this.closeQuery();
      await this.done;
    }
  }

  private closeQuery(): void {
    try {
      this.query?.close();
    } catch {
      // ignore
    }
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, opts): Promise<PermissionResult> => {
    const signal = AbortSignal.any([opts.signal, this.lifetime.signal]);
    const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) resolve('aborted');
      else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    let started: { sessionId: string } | 'aborted';
    try {
      started = await Promise.race([this.init, aborted]);
    } catch {
      started = 'aborted';
    }
    if (started === 'aborted' || signal.aborted) return deny(this.recalled ? RECALLED : this.initSeen ? CANCELLED : NOT_STARTED);
    const meta: Parameters<ApprovalBroker['request']>[0] = { npcId: this.params.npcId, sessionId: started.sessionId, toolName, summary: summarizeTool(toolName, input) };
    if (this.params.questId !== undefined) meta.questId = this.params.questId;
    if (opts.decisionReason !== undefined) meta.reason = opts.decisionReason;
    return this.params.broker.request(meta, signal);
  };

  private emit(msg: SDKMessage): void {
    const ctx = { npcId: this.params.npcId, tracker: this.tracker, ...(this.params.questId !== undefined ? { questId: this.params.questId } : {}) };
    for (const e of translate(msg, ctx)) this.safeEmit(e);
  }

  private safeEmit(e: GameEvent): void {
    try {
      this.params.onEvent(e);
    } catch {
      // A broken listener must not end the run.
    }
  }

  private emitError(detail: string): void {
    const e: GameEvent = { id: randomUUID(), sessionId: this.sessionId, npcId: this.params.npcId, at: Date.now(), kind: 'error', label: detail === RECALLED ? RECALLED : '冒險失敗', detail };
    if (this.params.questId !== undefined) e.questId = this.params.questId;
    this.safeEmit(e);
  }

  private async run(): Promise<RunOutcome> {
    let outcome: RunOutcome | undefined;
    // A result with queued sends means another turn is under way; until its own result arrives the
    // earlier outcome is provisional, so a recall in between must win over it.
    let turnPending = false;
    let thrown: string | undefined;
    let costUsd = 0;
    try {
      this.query = this.params.queryFn({ prompt: this.input, options: { ...this.params.options, canUseTool: this.canUseTool } });
      if (this.params.beforePrompt) this.prepare(this.params.beforePrompt, this.query);
      for await (const msg of this.query) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          this.initSeen = true;
          this.resolveInit({ sessionId: msg.session_id, permissionMode: msg.permissionMode });
          continue;
        }
        if (msg.type === 'result') {
          this.sessionId ||= msg.session_id;
          costUsd = msg.total_cost_usd ?? costUsd;
          const queued = !!(msg.queued_turn_count && msg.queued_turn_count > 0);
          if (!this.recalled) {
            this.emit(msg);
            outcome = this.outcomeOf(msg);
            // Frozen at recall: a terminal interruption result arriving after interrupt() must not
            // clear it, or the earlier turn's success would win over the recall.
            turnPending = queued;
          }
          // One prompt, one result: unless more user sends are already queued, let the query finish.
          if (!queued) this.input.end();
          continue;
        }
        if (!this.recalled) this.emit(msg);
      }
    } catch (e) {
      thrown = errorText(e);
    } finally {
      this.input.end();
      this.lifetime.abort();
      if (this.sessionId) this.params.broker.cancelForSession(this.sessionId);
      if (!this.initSeen) this.rejectInit(new Error(thrown ?? 'session ended before init'));
    }
    if (this.recalled && (!outcome || turnPending)) {
      this.emitError(RECALLED);
      return { ok: false, errors: [RECALLED], sessionId: this.sessionId, costUsd };
    }
    if (this.prepError !== undefined && !outcome) {
      this.emitError(this.prepError);
      return { ok: false, errors: [this.prepError], sessionId: this.sessionId, costUsd };
    }
    if (outcome) return outcome;
    const detail = thrown ?? '冒險在沒有回報的情況下結束';
    this.emitError(detail);
    return { ok: false, errors: [detail], sessionId: this.sessionId, costUsd };
  }

  /** Sends the prompt once `beforePrompt` resolves; on rejection ends the input and stops the query. */
  private prepare(beforePrompt: (query: Query) => Promise<void>, query: Query): void {
    beforePrompt(query).then(
      () => {
        if (!this.input.isEnded) this.input.push(userMessage(this.params.prompt));
      },
      (err: unknown) => {
        this.prepError = errorText(err);
        this.input.end();
        this.closeQuery();
      },
    );
  }

  private outcomeOf(msg: Extract<SDKMessage, { type: 'result' }>): RunOutcome {
    const base = { sessionId: msg.session_id || this.sessionId, costUsd: msg.total_cost_usd ?? 0 };
    if (msg.subtype === 'success' && !msg.is_error) {
      const out: RunOutcome = { ok: true, resultText: msg.result, ...base };
      if (msg.structured_output !== undefined) out.structured = msg.structured_output;
      return out;
    }
    const errors = msg.subtype === 'success' ? [msg.result] : msg.errors?.length ? msg.errors : [msg.subtype];
    return { ok: false, errors, ...base };
  }
}
