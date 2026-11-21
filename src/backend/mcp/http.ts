/**
 * The MCP server's listener: Streamable HTTP on 127.0.0.1 only, one path (`/mcp`), POST only.
 * Before the SDK sees anything, a request must:
 *
 * - name this server in its Host header (127.0.0.1 or localhost, this port): DNS rebinding;
 * - carry no Origin header: MCP clients don't send one, browsers always do, so no web page can call
 *   it (not even one served from this computer);
 * - carry the token: `Authorization: Bearer <token>`, compared in constant time;
 * - be at most 1 MiB, and not open a subscription stream (this server has nothing to stream).
 *
 * Then the SDK (createMcpHandler) serves it: the 2026-07-28 protocol, and 2025-era clients through
 * its stateless fallback, from one set of tools (tools.ts).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { Reader } from './reader';
import { createServer, type Call } from './tools';

export const MCP_PATH = '/mcp';
export const MAX_BODY = 1024 * 1024;
/** Calls kept for the app's activity list. */
export const MAX_ACTIVITY = 50;

export interface Activity extends Call {
  /** When it finished, ms since the epoch. */
  at: number;
  /** What the client calls itself (its User-Agent), cut short: its own words, not checked. */
  client: string;
}

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();

/** Whether the Authorization header carries `token`, compared in constant time. */
export function hasToken(header: string | undefined, token: string): boolean {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  // Hashed first, so the comparison takes the same time whatever the lengths.
  return timingSafeEqual(digest(match?.[1] ?? ''), digest(token)) && match !== null;
}

/** Whether a Host header names this server: 127.0.0.1 or localhost, on this port. */
export function isOwnHost(host: string | undefined, port: number): boolean {
  const lower = (host ?? '').toLowerCase();
  return lower === `127.0.0.1:${port}` || lower === `localhost:${port}`;
}

/** Whether a JSON-RPC body asks for a subscription stream, which this server doesn't serve. */
function asksToListen(body: Buffer): boolean {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.some(
      (m) =>
        typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'subscriptions/listen',
    );
  } catch {
    // Not JSON: the SDK answers that.
    return false;
  }
}

function refuse(
  res: http.ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(message);
}

/** Reads a request's body, up to `max` bytes; undefined past that. */
function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > max) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface McpServerOptions {
  reader: Reader;
  /** One line per call, for the log. */
  log(line: string): void;
  /** Told of each call, after it finishes. */
  onCall(activity: Activity): void;
}

/** The listener, started and stopped as the user turns it on and off. */
export class McpHttpServer {
  private server: http.Server | undefined;
  private handler: McpHttpHandler | undefined;
  private port = 0;
  private token = '';

  constructor(private readonly options: McpServerOptions) {}

  /** The port it listens on, or undefined when off. */
  get listening(): number | undefined {
    return this.server ? this.port : undefined;
  }

  /**
   * Listens on 127.0.0.1:`port`, stopping any earlier listener first (so an old token stops
   * working at once). Rejects if the port can't be had; nothing else is tried.
   */
  async start(port: number, token: string): Promise<void> {
    await this.stop();
    const handler = createMcpHandler(
      (ctx) => {
        // Per request: the client that sent it.
        const client = (ctx.requestInfo?.headers.get('user-agent') ?? '').slice(0, 100);
        return createServer(this.options.reader, (call) => this.called(call, client));
      },
      {
        responseMode: 'json',
        maxRequestBodySize: MAX_BODY,
        keepAliveMs: 0,
        onerror: (error) => this.options.log(`MCP: ${error.message}`),
      },
    );
    const server = http.createServer((req, res) => void this.serve(req, res, handler));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.handler = handler;
    this.port = (server.address() as AddressInfo).port;
    this.token = token;
  }

  /** Stops listening, ends every open connection, and drops the token. */
  async stop(): Promise<void> {
    const server = this.server;
    const handler = this.handler;
    this.server = undefined;
    this.handler = undefined;
    this.token = '';
    await handler?.close?.();
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private called(call: Call, client: string): void {
    const activity: Activity = { ...call, at: Date.now(), client };
    this.options.log(
      `MCP: ${activity.tool} (${activity.args}) ${activity.ok ? 'ok' : 'failed'} for ${activity.client || 'a client'}`,
    );
    this.options.onCall(activity);
  }

  private async serve(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: McpHttpHandler,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!isOwnHost(req.headers.host, this.port)) return refuse(res, 403, 'Forbidden: wrong Host.');
      if (req.headers.origin !== undefined)
        return refuse(res, 403, 'Forbidden: browsers can’t use this server.');
      if (!this.token || !hasToken(req.headers.authorization, this.token)) {
        return refuse(
          res,
          401,
          'Unauthorized: send Authorization: Bearer <token> (see Wirescry’s Setup page).',
          {
            'www-authenticate': 'Bearer',
          },
        );
      }
      if (url.pathname !== MCP_PATH) return refuse(res, 404, `Not found: the MCP endpoint is ${MCP_PATH}.`);
      if (req.method !== 'POST') return refuse(res, 405, 'Method not allowed: POST only.', { allow: 'POST' });
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return refuse(res, 413, 'Too large.');
      const body = await readBody(req, MAX_BODY);
      if (body === undefined) return refuse(res, 413, 'Too large.');
      if (asksToListen(body)) return refuse(res, 404, 'Not found: this server has no subscriptions.');

      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
      }
      const request = new Request(`http://${req.headers.host}${url.pathname}${url.search}`, {
        method: 'POST',
        headers,
        body: new Uint8Array(body),
        signal: abort.signal,
      });
      const response = await handler.fetch(request);
      const out: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        out[name] = value;
      });
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      this.options.log(`MCP: ${(error as Error).message}`);
      if (!res.headersSent) refuse(res, 500, 'Something went wrong.');
      else res.destroy();
    }
  }
}
