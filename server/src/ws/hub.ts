import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerMessage, Snapshot } from '@loc/shared';
import type { Config } from '../config.js';
import { originAllowed, tokenMatches } from '../http/security.js';

export const WS_PATH = '/ws';

function reject(socket: Duplex, status: 400 | 401 | 403 | 404, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(private readonly getSnapshot: () => Promise<Snapshot>) {}

  /** Handle `upgrade` on the shared HTTP server: only a correct `?token=` and an allowed Origin get through. */
  attach(server: Server, config: Pick<Config, 'token' | 'allowedOrigins'>): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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
    ws.on('error', () => ws.terminate());
    try {
      const snapshot = await this.getSnapshot();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'snapshot', ...snapshot } satisfies ServerMessage));
    } catch {
      ws.close(1011, 'snapshot failed');
    }
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  close(): void {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}
