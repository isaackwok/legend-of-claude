import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { GameEvent } from '@loc/shared';
import { describe, expect, it, vi } from 'vitest';
import { fakeQuery, type FakeQueryOptions, type FakeStep } from '../../test/fakeQuery.js';
import { ApprovalBroker } from './approvals.js';
import { AgentRun } from './runner.js';

const init = { type: 'system', subtype: 'init', session_id: 's-1', permissionMode: 'auto' };
const bashUse = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf build' } }] },
  parent_tool_use_id: null,
  session_id: 's-1',
};
const bashResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, parent_tool_use_id: null, session_id: 's-1' };
const canUse: FakeStep = { canUseTool: { toolName: 'Bash', input: { command: 'rm -rf build' }, decisionReason: '刪除資料夾' } };
const success = { type: 'result', subtype: 'success', is_error: false, result: '完成了', structured_output: { ok: 1 }, total_cost_usd: 0.25, session_id: 's-1' };

const baseOptions = { model: 'claude-haiku-5-5', permissionMode: 'auto' } as Options;

function start(script: FakeStep[], extra: Partial<Parameters<typeof AgentRun.start>[0]> = {}, fakeOptions: FakeQueryOptions = {}) {
  const fake = fakeQuery(script, fakeOptions);
  const broker = new ApprovalBroker();
  const events: GameEvent[] = [];
  const run = AgentRun.start({
    queryFn: fake.fn,
    options: baseOptions,
    prompt: '修好測試',
    npcId: 'npc-1',
    questId: 'q-1',
    broker,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { fake, broker, events, run };
}

describe('AgentRun', () => {
  it('starts in streaming-input mode with the prompt first and injects canUseTool', async () => {
    const { fake, run } = start([init, success]);
    const out = await run.done;
    expect(out.ok).toBe(true);
    expect(fake.inputs[0]).toMatchObject({ type: 'user', message: { role: 'user', content: '修好測試' }, parent_tool_use_id: null, origin: { kind: 'human' } });
    expect(typeof fake.calls[0]!.canUseTool).toBe('function');
    expect(fake.calls[0]!.model).toBe('claude-haiku-5-5');
    expect(baseOptions.canUseTool).toBeUndefined();
    expect(await run.init).toEqual({ sessionId: 's-1', permissionMode: 'auto' });
  });

  it('routes canUseTool to the broker and finishes after the approval is resolved', async () => {
    const { fake, broker, events, run } = start([init, bashUse, canUse, bashResult, success]);
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    expect(broker.list()[0]).toMatchObject({ npcId: 'npc-1', questId: 'q-1', sessionId: 's-1', toolName: 'Bash', summary: 'rm -rf build', reason: '刪除資料夾' });
    broker.resolve(broker.list()[0]!.id, { allow: true });
    const out = await run.done;
    expect(out).toEqual({ ok: true, resultText: '完成了', structured: { ok: 1 }, sessionId: 's-1', costUsd: 0.25 });
    expect(fake.permissionResults).toEqual([{ behavior: 'allow' }]);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['tool_start', 'tool_end', 'result']);
    expect(kinds.indexOf('tool_start')).toBeLessThan(kinds.indexOf('result'));
    expect(events.every((e) => e.npcId === 'npc-1' && e.questId === 'q-1')).toBe(true);
  });

  it('ends the input stream after the result', async () => {
    const { fake, run } = start([init, success]);
    await run.done;
    await vi.waitFor(() => expect(fake.inputEnded).toBe(true));
  });

  it('send() pushes a human message with priority next into the input stream', async () => {
    const { fake, run } = start([init, { waitForInput: 2 }, success]);
    await run.init;
    run.send('先別改');
    const out = await run.done;
    expect(out.ok).toBe(true);
    expect(fake.inputs[1]).toMatchObject({ type: 'user', message: { role: 'user', content: '先別改' }, priority: 'next', origin: { kind: 'human' } });
    expect(() => run.send('還在嗎')).toThrow();
  });

  it('cancels pending approvals on interrupt', async () => {
    const { fake, broker, run } = start([init, bashUse, canUse, bashResult, success]);
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    await expect(run.recall()).resolves.toBeUndefined();
    expect(broker.list()).toEqual([]);
    expect(fake.interrupted).toBe(true);
    expect(fake.closed).toBe(false);
    expect(fake.permissionResults[0]?.behavior).toBe('deny');
    const out = await run.done;
    expect(out).toMatchObject({ ok: false, errors: ['已被召回'], sessionId: 's-1' });
    await expect(run.recall()).resolves.toBeUndefined();
    expect(() => run.send('回來')).toThrow();
  });

  it('recall before init denies a waiting permission check and resolves not ok', async () => {
    const { fake, broker, run } = start([{ canUseTool: { toolName: 'Bash', input: { command: 'ls' } } }, init, success]);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    await run.recall();
    expect(fake.permissionResults).toEqual([{ behavior: 'deny', message: '已被召回' }]);
    expect(broker.list()).toEqual([]);
    expect(await run.done).toMatchObject({ ok: false, errors: ['已被召回'], sessionId: '' });
    await expect(run.init).rejects.toThrow();
  });

  it('closes the query on recall when sends are still queued after the interrupt', async () => {
    const { fake, run } = start([init, { waitForInput: 2 }, { waitForInput: 99 }, success], {}, { interruptReceipt: { still_queued: ['u-2'] } });
    await run.init;
    run.send('等等');
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(2));
    expect(typeof fake.inputs[1]!.uuid).toBe('string');
    await run.recall();
    expect(fake.interrupted).toBe(true);
    expect(fake.closed).toBe(true);
    expect((await run.done).errors).toEqual(['已被召回']);
  });

  it('a recall during a queued follow-up turn overrides the earlier result', async () => {
    const queued = { ...success, queued_turn_count: 1 };
    const { events, run } = start([init, queued, { waitForInput: 99 }]);
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'result')).toBe(true));
    await run.recall();
    expect(await run.done).toMatchObject({ ok: false, errors: ['已被召回'] });
  });

  it('a recall during a queued follow-up stays recalled when the SDK then emits an interruption result', async () => {
    const queued = { ...success, result: 'first turn completed', queued_turn_count: 1 };
    const interruption = { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['interrupted'], terminal_reason: 'aborted_streaming', queued_turn_count: 0, total_cost_usd: 0.3, session_id: 's-1' };
    const { events, run } = start([init, queued, { waitForInput: 99 }], {}, { afterInterrupt: [interruption] });
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'result')).toBe(true));
    await run.recall();
    expect(await run.done).toMatchObject({ ok: false, errors: ['已被召回'] });
  });

  it('a queued follow-up turn that finishes replaces the earlier result', async () => {
    const queued = { ...success, result: '第一輪', queued_turn_count: 1 };
    const { run } = start([init, queued, { ...success, result: '第二輪' }]);
    expect(await run.done).toMatchObject({ ok: true, resultText: '第二輪' });
  });

  it('reports failure when a queued follow-up ends without its own result', async () => {
    const { events, run } = start([init, { ...success, queued_turn_count: 1 }]);
    expect(await run.done).toEqual({
      ok: false,
      errors: ['冒險在沒有回報的情況下結束'],
      sessionId: 's-1',
      costUsd: 0.25,
    });
    expect(events.at(-1)).toMatchObject({ kind: 'error', detail: '冒險在沒有回報的情況下結束' });
  });

  it('reports the SDK error when a queued follow-up crashes before its result', async () => {
    const fake = fakeQuery([init, { ...success, queued_turn_count: 1 }]);
    const throwing = ((params: Parameters<typeof fake.fn>[0]) => {
      const inner = fake.fn(params);
      return (async function* () {
        yield* inner;
        throw new Error('worker disconnected during follow-up');
      })();
    }) as unknown as typeof fake.fn;
    const { events, run } = start([], { queryFn: throwing });
    expect(await run.done).toEqual({
      ok: false,
      errors: ['worker disconnected during follow-up'],
      sessionId: 's-1',
      costUsd: 0.25,
    });
    expect(events.at(-1)).toMatchObject({ kind: 'error', detail: 'worker disconnected during follow-up' });
  });

  it('denies a permission check with a not-started message when the run ends without init', async () => {
    const { fake, run } = start([{ canUseTool: { toolName: 'Bash', input: { command: 'ls' }, detach: true } }]);
    expect((await run.done).ok).toBe(false);
    await vi.waitFor(() => expect(fake.permissionResults).toEqual([{ behavior: 'deny', message: '冒險尚未開始，無法執行' }]));
  });

  it('reports an error result as not ok with its errors and cost', async () => {
    const { run } = start([init, { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many'], total_cost_usd: 1.5, session_id: 's-1' }]);
    expect(await run.done).toEqual({ ok: false, errors: ['too many'], sessionId: 's-1', costUsd: 1.5 });
  });

  it('never rejects done: a thrown SDK error resolves not ok and init rejects', async () => {
    const fake = fakeQuery([]);
    const throwing = ((params: Parameters<typeof fake.fn>[0]) => {
      fake.fn(params);
      return (async function* () {
        throw new Error('spawn failed');
      })();
    }) as unknown as typeof fake.fn;
    const run = AgentRun.start({ queryFn: throwing, options: baseOptions, prompt: 'x', npcId: 'npc-1', broker: new ApprovalBroker(), onEvent: () => {} });
    expect(await run.done).toEqual({ ok: false, errors: ['spawn failed'], sessionId: '', costUsd: 0 });
    await expect(run.init).rejects.toThrow();
  });

  it('resolves not ok when the stream ends without a result', async () => {
    const { run } = start([init]);
    const out = await run.done;
    expect(out.ok).toBe(false);
    expect(out.sessionId).toBe('s-1');
    expect(out.errors?.length).toBe(1);
  });

  it('beforePrompt runs with the query first; the prompt is sent only after it resolves', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let seenQuery: unknown;
    const { fake, run } = start([{ waitForInput: 1 }, init, success], {
      beforePrompt: async (q) => {
        seenQuery = q;
        await gate;
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(seenQuery).toBeDefined();
    expect(fake.inputs).toEqual([]);
    release();
    expect((await run.done).ok).toBe(true);
    expect(fake.inputs.map((m) => m.message.content)).toEqual(['修好測試']);
  });

  it('a rejecting beforePrompt never sends the prompt and ends not ok with its message', async () => {
    const { fake, events, run } = start([{ waitForInput: 1 }, init, success], { beforePrompt: () => Promise.reject(new Error('連線尚未就緒')) });
    const out = await run.done;
    expect(out).toMatchObject({ ok: false, errors: ['連線尚未就緒'] });
    expect(fake.inputs).toEqual([]);
    expect(fake.closed).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'error', detail: '連線尚未就緒' });
  });
});
