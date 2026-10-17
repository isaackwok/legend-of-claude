import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@loc/shared';
import { connectWs, LOST_AFTER_FAILURES, reconnectDelay, type ConnectionStatus } from './ws';

class FakeWs {
  static instances: FakeWs[] = [];
  static throwOnConstruct = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    if (FakeWs.throwOnConstruct) throw new Error('boom');
    FakeWs.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  // test helpers
  open() { this.onopen?.(); }
  drop() { this.onclose?.(); }
  send(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}
const live = () => FakeWs.instances.filter((w) => !w.closed);
const last = () => FakeWs.instances.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWs.instances = [];
  FakeWs.throwOnConstruct = false;
  vi.stubGlobal('WebSocket', FakeWs);
  sessionStorage.setItem('loc.token', 'tok');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('reconnectDelay', () => {
  it('backs off 2s, 4s, 8s then caps at 10s', () => {
    expect([0, 1, 2, 3, 4, 9].map(reconnectDelay)).toEqual([2000, 4000, 8000, 10000, 10000, 10000]);
  });
});

describe('connectWs', () => {
  it('connects with the token and delivers messages', () => {
    const got: ServerMessage[] = [];
    connectWs((m) => got.push(m));
    expect(last().url).toMatch(/^ws:\/\/[^/]+\/ws\?token=tok$/);
    last().open();
    last().send({ type: 'approval_resolved', id: 'a' });
    expect(got).toEqual([{ type: 'approval_resolved', id: 'a' }]);
  });

  it('reconnects 2 seconds after an established connection drops', () => {
    connectWs(() => undefined);
    last().open();
    last().drop();
    vi.advanceTimersByTime(1999);
    expect(FakeWs.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWs.instances).toHaveLength(2);
  });

  it('does not reconnect after disconnect()', () => {
    const disconnect = connectWs(() => undefined);
    last().open();
    disconnect();
    expect(FakeWs.instances[0]!.closed).toBe(true);
    FakeWs.instances[0]!.drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(1);
  });

  it('disconnect() cancels a pending retry', () => {
    const disconnect = connectWs(() => undefined);
    last().drop();
    disconnect();
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(1);
  });

  it('connect, disconnect, connect leaves exactly one live socket', () => {
    const d1 = connectWs(() => undefined);
    last().open();
    d1();
    connectWs(() => undefined);
    last().open();
    FakeWs.instances[0]!.drop(); // the old socket's late close must not spawn another
    vi.advanceTimersByTime(60_000);
    expect(live()).toHaveLength(1);
    expect(FakeWs.instances).toHaveLength(2);
  });

  it('ignores messages from a socket that is no longer current or after stop', () => {
    const got: ServerMessage[] = [];
    const disconnect = connectWs((m) => got.push(m));
    const first = last();
    first.open();
    disconnect();
    first.send({ type: 'approval_resolved', id: 'late' });
    expect(got).toEqual([]);
  });

  it('counts consecutive failures with backoff, and resets on a successful open', () => {
    const statuses: ConnectionStatus[] = [];
    connectWs(() => undefined, (s) => statuses.push(s));
    expect(statuses.at(-1)).toEqual({ state: 'connecting', failures: 0 });

    last().drop(); // failure 1 -> 4s
    expect(statuses.at(-1)).toEqual({ state: 'retrying', failures: 1 });
    vi.advanceTimersByTime(3999);
    expect(FakeWs.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWs.instances).toHaveLength(2);

    last().drop(); // failure 2 -> 8s
    vi.advanceTimersByTime(8000);
    last().drop(); // failure 3 -> 10s
    expect(statuses.at(-1)).toEqual({ state: 'retrying', failures: LOST_AFTER_FAILURES });
    vi.advanceTimersByTime(10_000);
    expect(FakeWs.instances).toHaveLength(4);

    last().open();
    expect(statuses.at(-1)).toEqual({ state: 'open', failures: 0 });
    last().drop();
    expect(statuses.at(-1)).toEqual({ state: 'retrying', failures: 0 });
  });

  it('retries when the WebSocket constructor throws synchronously', () => {
    FakeWs.throwOnConstruct = true;
    const statuses: ConnectionStatus[] = [];
    connectWs(() => undefined, (s) => statuses.push(s));
    expect(statuses.at(-1)).toEqual({ state: 'retrying', failures: 1 });
    FakeWs.throwOnConstruct = false;
    vi.advanceTimersByTime(4000);
    expect(FakeWs.instances).toHaveLength(1);
    last().open();
    expect(statuses.at(-1)).toEqual({ state: 'open', failures: 0 });
  });
});
