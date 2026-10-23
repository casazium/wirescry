import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { API_PROTOCOL, TOKEN_PROTOCOL_PREFIX, type ClientCommand, type ServerMessage } from '../shared/api';

export interface ApiHandlers {
  /** Sent to each client when it connects. */
  hello(): ServerMessage;
  /** Handles a command from the UI. Throw to send an error back. */
  command(command: ClientCommand): Promise<unknown>;
}

export interface ApiServerOptions {
  token: string;
  /** Origins allowed to connect, e.g. the dev server or the app's own protocol. */
  allowedOrigins: string[];
  handlers: ApiHandlers;
  port?: number;
}

export interface RunningApiServer {
  port: number;
  broadcast(message: ServerMessage): void;
  stop(): Promise<void>;
}

function tokensMatch(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenFromProtocols(header: string | undefined): string | undefined {
  const protocols = (header ?? '').split(',').map((p) => p.trim());
  return protocols.find((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX))?.slice(TOKEN_PROTOCOL_PREFIX.length);
}

/**
 * The local API the UI uses: a single WebSocket on 127.0.0.1.
 *
 * Every connection must:
 * - send the per-launch token (as a WebSocket subprotocol, since browsers can't set headers),
 * - come from an allowed Origin when it sends one (all browsers do), and
 * - use a loopback Host header, which blocks DNS-rebinding attacks.
 */
export async function startApiServer(options: ApiServerOptions): Promise<RunningApiServer> {
  const { token, allowedOrigins, handlers } = options;

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has(API_PROTOCOL) ? API_PROTOCOL : false),
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const reject = (status: number, reason: string): void => {
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    };

    const port = (httpServer.address() as AddressInfo).port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? '')) return reject(403, 'Forbidden');

    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin)) return reject(403, 'Forbidden');

    if (!tokensMatch(token, tokenFromProtocols(req.headers['sec-websocket-protocol']))) {
      return reject(401, 'Unauthorized');
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws: WebSocket, message: ServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };

  wss.on('connection', (ws: WebSocket) => {
    // A protocol error (such as a message over maxPayload) closes this connection; without a
    // listener it would be an uncaught exception that takes the whole backend down.
    ws.on('error', (error) => {
      console.error('[leverframe] API connection error:', error.message);
      ws.terminate();
    });
    send(ws, handlers.hello());
    ws.on('message', async (data) => {
      let command: ClientCommand;
      try {
        command = JSON.parse(data.toString()) as ClientCommand;
      } catch {
        return;
      }
      if (typeof command?.id !== 'number') return;
      try {
        const value = await handlers.command(command);
        send(ws, { type: 'result', id: command.id, ok: true, value });
      } catch (error) {
        send(ws, {
          type: 'result',
          id: command.id,
          ok: false,
          error: String((error as Error).message ?? error),
        });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });

  return {
    port: (httpServer.address() as AddressInfo).port,
    broadcast(message) {
      const data = JSON.stringify(message);
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(data);
      }
    },
    async stop() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
