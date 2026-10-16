import type { CanUseTool, Options, PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../src/agent/queryFn.js';

/**
 * One scripted step: an SDK message to yield (typed loosely, cast inside), a call to the injected
 * `canUseTool` (awaited; its result is recorded), or a pause until `n` prompt messages were read.
 */
export type FakeStep =
  | Record<string, unknown>
  | { canUseTool: { toolName: string; input: Record<string, unknown>; toolUseID?: string; decisionReason?: string } }
  | { waitForInput: number };

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
export function fakeQuery(script: FakeStep[]): FakeQuery {
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
        if ('canUseTool' in step && typeof step['canUseTool'] === 'object') {
          const s = (step as { canUseTool: { toolName: string; input: Record<string, unknown>; toolUseID?: string; decisionReason?: string } }).canUseTool;
          const canUseTool = options.canUseTool as CanUseTool;
          const controller = new AbortController();
          const opts: Parameters<CanUseTool>[2] = { signal: controller.signal, toolUseID: s.toolUseID ?? 'tu-1', requestId: 'req-1' };
          if (s.decisionReason !== undefined) opts.decisionReason = s.decisionReason;
          permissionResults.push(await canUseTool(s.toolName, s.input, opts));
        } else if ('waitForInput' in step && typeof step['waitForInput'] === 'number') {
          const n = step['waitForInput'];
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
        return undefined;
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
