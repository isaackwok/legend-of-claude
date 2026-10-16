import type { ServerMessage } from '@loc/shared';
import { getToken } from './http';

export const RECONNECT_MS = 2000;

/** Opens the game socket and reconnects 2 seconds after every drop. Returns a disconnect function. */
export function connectWs(onMessage: (msg: ServerMessage) => void): () => void {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(getToken())}`);
    ws = socket;
    socket.onmessage = (e) => {
      try {
        onMessage(JSON.parse(String(e.data)) as ServerMessage);
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => {
      if (ws === socket) ws = null;
      if (!stopped) timer = setTimeout(open, RECONNECT_MS);
    };
  };
  open();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
