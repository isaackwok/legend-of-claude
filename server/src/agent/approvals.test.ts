import type { ServerMessage } from '@loc/shared';
import { describe, expect, it } from 'vitest';
import { ApprovalBroker } from './approvals.js';

const meta = { npcId: 'npc-1', questId: 'q-1', sessionId: 's-1', toolName: 'Bash', summary: 'rm -rf build' };

describe('ApprovalBroker', () => {
  it('lists a pending request and broadcasts it', () => {
    const broker = new ApprovalBroker();
    const seen: ServerMessage[] = [];
    broker.onChange((m) => seen.push(m));
    void broker.request(meta, new AbortController().signal);
    const list = broker.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject(meta);
    expect(typeof list[0]!.id).toBe('string');
    expect(typeof list[0]!.createdAt).toBe('number');
    expect(seen).toEqual([{ type: 'approval', approval: list[0] }]);
  });

  it('resolves allow and deny (deny with the default message)', async () => {
    const broker = new ApprovalBroker();
    const seen: ServerMessage[] = [];
    broker.onChange((m) => seen.push(m));
    const p1 = broker.request(meta, new AbortController().signal);
    const p2 = broker.request(meta, new AbortController().signal);
    const [a1, a2] = broker.list();
    broker.resolve(a1!.id, { allow: true });
    broker.resolve(a2!.id, { allow: false });
    expect(await p1).toEqual({ behavior: 'allow' });
    expect(await p2).toEqual({ behavior: 'deny', message: '會長拒絕了這個請求' });
    expect(broker.list()).toEqual([]);
    expect(seen.filter((m) => m.type === 'approval_resolved')).toEqual([
      { type: 'approval_resolved', id: a1!.id },
      { type: 'approval_resolved', id: a2!.id },
    ]);
  });

  it('uses a custom deny message and ignores unknown or repeated ids', async () => {
    const broker = new ApprovalBroker();
    const p = broker.request(meta, new AbortController().signal);
    const id = broker.list()[0]!.id;
    broker.resolve(id, { allow: false, message: '先別刪' });
    broker.resolve(id, { allow: true });
    broker.resolve('nope', { allow: true });
    expect(await p).toEqual({ behavior: 'deny', message: '先別刪' });
  });

  it('cancelForSession denies every pending request of that session only', async () => {
    const broker = new ApprovalBroker();
    const seen: ServerMessage[] = [];
    broker.onChange((m) => seen.push(m));
    const p1 = broker.request(meta, new AbortController().signal);
    const p2 = broker.request(meta, new AbortController().signal);
    void broker.request({ ...meta, sessionId: 's-2' }, new AbortController().signal);
    broker.cancelForSession('s-1');
    expect((await p1).behavior).toBe('deny');
    expect((await p2).behavior).toBe('deny');
    expect(broker.list().map((a) => a.sessionId)).toEqual(['s-2']);
    expect(seen.filter((m) => m.type === 'approval_resolved')).toHaveLength(2);
  });

  it('denies when the signal aborts, and immediately for an already-aborted signal', async () => {
    const broker = new ApprovalBroker();
    const c = new AbortController();
    const p = broker.request(meta, c.signal);
    c.abort();
    expect((await p).behavior).toBe('deny');
    expect(broker.list()).toEqual([]);
    expect((await broker.request(meta, AbortSignal.abort())).behavior).toBe('deny');
    expect(broker.list()).toEqual([]);
  });

  it('onChange returns an unsubscribe function', () => {
    const broker = new ApprovalBroker();
    const seen: ServerMessage[] = [];
    const off = broker.onChange((m) => seen.push(m));
    off();
    void broker.request(meta, new AbortController().signal);
    expect(seen).toEqual([]);
  });
});
