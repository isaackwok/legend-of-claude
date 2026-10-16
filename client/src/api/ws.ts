import type { ServerMessage } from '@loc/shared';
import { getToken } from './http';

export const RECONNECT_BASE_MS = 2000;
export const RECONNECT_MAX_MS = 10000;
/** Consecutive failed attempts after which the UI tells the user to reopen the server's URL (stale token). */
export const LOST_AFTER_FAILURES = 3;

export type ConnectionState = 'connecting' | 'open' | 'retrying';
export interface ConnectionStatus {
  state: ConnectionState;
  /** Consecutive attempts that ended without ever opening; reset by a successful open. */
  failures: number;
}

export function reconnectDelay(failures: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** failures, RECONNECT_MAX_MS);
}

/**
 * Opens the game socket and reconnects with capped backoff (2 s, 4 s, 8 s, then 10 s) after every drop.
 * Returns a disconnect function; after it runs, no further reconnects or messages are delivered.
 */
export function connectWs(
  onMessage: (msg: ServerMessage) => void,
  onStatus: (status: ConnectionStatus) => void = () => undefined,
): () => void {
  let current: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let failures = 0;

  const report = (state: ConnectionState) => onStatus({ state, failures });

  const scheduleRetry = () => {
    if (stopped) return;
    report('retrying');
    timer = setTimeout(open, reconnectDelay(failures));
  };

  const open = () => {
    timer = undefined;
    if (stopped) return;
    report('connecting');
    let socket: WebSocket;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(getToken())}`);
    } catch {
      failures += 1;
      scheduleRetry();
      return;
    }
    current = socket;
    let opened = false;
    socket.onopen = () => {
      if (stopped || current !== socket) return;
      opened = true;
      failures = 0;
      report('open');
    };
    socket.onmessage = (e) => {
      if (stopped || current !== socket) return;
      try {
        onMessage(JSON.parse(String(e.data)) as ServerMessage);
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => {
      if (current !== socket) return;
      current = null;
      if (!opened) failures += 1;
      scheduleRetry();
    };
  };
  open();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const socket = current;
    current = null;
    socket?.close();
  };
}
