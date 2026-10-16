import type { CanUseTool, Options, PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../src/agent/queryFn.js';

/** An SDK message to yield; typed loosely (cast inside) but must carry `type`. */
export type FakeMessageStep = { type: string; [k: string]: unknown };
export interface FakeCanUseToolStep {
  /** Call the injected `canUseTool` and record its result. Awaited unless `detach` is set. */
  canUseTool: { toolName: string; input: Record<string, unknown>; toolUseID?: string; decisionReason?: string; detach?: boolean };
}
export interface FakeWaitStep {
  /** Pause until `n` prompt messages were read (or the prompt ended, or the query was stopped). */
  waitForInput: number;
}
export type FakeStep = FakeMessageStep | FakeCanUseToolStep | FakeWaitStep;

const isCanUseToolStep = (s: FakeStep): s is FakeCanUseToolStep => typeof (s as Partial<FakeCanUseToolStep>).canUseTool === 'object';
const isWaitStep = (s: FakeStep): s is FakeWaitStep => typeof (s as Partial<FakeWaitStep>).waitForInput === 'number';

export interface FakeQueryOptions {
  /** What `interrupt()` resolves to (the SDK's interrupt receipt). Default `undefined` (older CLI). */
  interruptReceipt?: { still_queued: string[] };
}

export interface FakeQuery {
  fn: QueryFn;
  /** Options each `query()` call received. */
  calls: Options[];
  /** Every message read from the streaming prompt, in order. */
  inputs: SDKUserMessage[];
  /** What the injected `canUseTool` returned for each `canUseTool` step. */
  permissionResults: Array<PermissionResult | null>;
  readonly interrupted: boolean;
  readonly closed: boolean;
  /** Whether the prompt iterable has ended. */
  readonly inputEnded: boolean;
}

/** A scripted fake `QueryFn`. Stops yielding once `interrupt()` or `close()` was called. */
export function fakeQuery(script: FakeStep[], fakeOptions: FakeQueryOptions = {}): FakeQuery {
  const state = { interrupted: false, closed: false, inputEnded: false };
  const calls: Options[] = [];
  const inputs: SDKUserMessage[] = [];
  const permissionResults: Array<PermissionResult | null> = [];
  let wake: Array<() => void> = [];
  const notify = () => {
    const w = wake;
    wake = [];
    for (const f of w) f();
  };
  const until = async (cond: () => boolean) => {
    while (!cond()) await new Promise<void>((r) => wake.push(r));
  };
  const stopped = () => state.interrupted || state.closed;

  const fn = ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const options = params.options ?? {};
    calls.push(options);
    const prompt = params.prompt;
    if (typeof prompt !== 'string') {
      void (async () => {
        for await (const m of prompt) {
          inputs.push(m);
          notify();
        }
        state.inputEnded = true;
        notify();
      })();
    }
    async function* gen() {
      for (const step of script) {
        if (stopped()) return;
        if (isCanUseToolStep(step)) {
          const s = step.canUseTool;
          const canUseTool = options.canUseTool as CanUseTool;
          const controller = new AbortController();
          const opts: Parameters<CanUseTool>[2] = { signal: controller.signal, toolUseID: s.toolUseID ?? 'tu-1', requestId: 'req-1' };
          if (s.decisionReason !== undefined) opts.decisionReason = s.decisionReason;
          const call = canUseTool(s.toolName, s.input, opts);
          if (s.detach) {
            const index = permissionResults.push(null) - 1;
            void call.then((r) => {
              permissionResults[index] = r;
            });
          } else {
            permissionResults.push(await call);
          }
        } else if (isWaitStep(step)) {
          const n = step.waitForInput;
          await until(() => inputs.length >= n || state.inputEnded || stopped());
        } else {
          yield step;
        }
      }
    }
    const q = gen() as unknown as Query;
    Object.assign(q, {
      interrupt: async () => {
        state.interrupted = true;
        notify();
        return fakeOptions.interruptReceipt;
      },
      close: () => {
        state.closed = true;
        notify();
      },
    });
    return q;
  }) as unknown as QueryFn;

  return {
    fn,
    calls,
    inputs,
    permissionResults,
    get interrupted() {
      return state.interrupted;
    },
    get closed() {
      return state.closed;
    },
    get inputEnded() {
      return state.inputEnded;
    },
  };
}
