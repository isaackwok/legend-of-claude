import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerMessage, Snapshot } from '@loc/shared';
import type { Config } from '../config.js';
import { hostAllowed, originAllowed, tokenMatches } from '../http/security.js';

export const WS_PATH = '/ws';

function reject(socket: Duplex, status: 400 | 401 | 403 | 404, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

const MAX_PAYLOAD = 64 * 1024;

export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  /** Broadcasts that arrived while a new client's snapshot was still being built; flushed right after it. */
  private readonly pending = new Map<WebSocket, string[]>();

  constructor(private readonly getSnapshot: () => Promise<Snapshot>) {}

  /** Handle `upgrade` on the shared HTTP server: only a correct `?token=` and an allowed Origin get through. */
  attach(server: Server, config: Pick<Config, 'token' | 'allowedOrigins' | 'port' | 'clientPort'>): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => socket.destroy());
      if (!hostAllowed(req.headers.host, config)) return reject(socket, 403, 'Forbidden');
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1');
      } catch {
        return reject(socket, 400, 'Bad Request');
      }
      if (url.pathname !== WS_PATH) return reject(socket, 404, 'Not Found');
      if (!tokenMatches(url.searchParams.get('token'), config.token)) return reject(socket, 401, 'Unauthorized');
      if (!originAllowed(req.headers.origin ?? null, config)) return reject(socket, 403, 'Forbidden');
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        void this.onConnection(ws);
      });
    });
  }

  private async onConnection(ws: WebSocket): Promise<void> {
    // Not sent to until its snapshot is out, so the snapshot is always the first message.
    this.pending.set(ws, []);
    ws.on('error', () => ws.terminate());
    ws.on('close', () => this.pending.delete(ws));
    try {
      const snapshot = await this.getSnapshot();
      const queued = this.pending.get(ws);
      this.pending.delete(ws);
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'snapshot', ...snapshot } satisfies ServerMessage));
      for (const data of queued ?? []) ws.send(data);
    } catch {
      this.pending.delete(ws);
      ws.close(1011, 'snapshot failed');
    }
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const queue = this.pending.get(client);
      if (queue) queue.push(data);
      else client.send(data);
    }
  }

  close(): void {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}
