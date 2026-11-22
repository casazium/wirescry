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
import { createServer, sweep, type Call } from './tools';

export const MCP_PATH = '/mcp';
export const MAX_BODY = 1024 * 1024;
/** Calls kept for the app's activity list. */
export const MAX_ACTIVITY = 50;
/** At most this much more of a too-large body is read (and dropped) before answering 413. */
const DRAIN_LIMIT = 16 * 1024 * 1024;
/** Requests served at once, and waiting, before an agent is told to slow down (429). */
export const MAX_BUSY = 8;

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
    // As the SDK reads it: a leading BOM is dropped.
    const parsed = JSON.parse(body.toString('utf8').replace(/^\uFEFF/, '')) as unknown;
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
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return; // Read and dropped, so the answer can be sent; the connection closes after.
      length += chunk.length;
      if (length > max) {
        over = true;
        chunks.length = 0;
        resolve(undefined);
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
        // The client's own words: printable characters only, short, and swept like any message.
        const client = sweep(
          (ctx.requestInfo?.headers.get('user-agent') ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 100),
        );
        return createServer(this.options.reader, (call) => this.called(call, client));
      },
      {
        responseMode: 'json',
        maxRequestBodySize: MAX_BODY,
        // No subscription streams: nothing here changes for a client to hear about.
        maxSubscriptions: 0,
        keepAliveMs: 0,
        onerror: (error) => this.logError(error),
      },
    );
    const server = http.createServer((req, res) => void this.serve(req, res, handler));
    // An agent is one or two clients: no need for many connections, or for slow ones to linger.
    server.maxConnections = 16;
    server.headersTimeout = 10_000;
    server.requestTimeout = 60_000;
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

  /** An error, for the log: swept, since it can quote what a client sent. */
  logError(error: unknown): void {
    this.options.log(`MCP: ${sweep(error instanceof Error ? error.message : String(error))}`);
  }

  /** Calls being served, and waiting: an agent can't queue unbounded work. */
  private busy = 0;

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
      // Too large: the rest of the body read and dropped, then answered, then the connection closed.
      // Answering first would close it with data still arriving, which resets it, and the client can
      // lose the answer. At most 16 MB more and 5 s: past that, the connection is just closed.
      const tooLarge = (): void => {
        let dropped = 0;
        const timer = setTimeout(() => req.socket.destroy(), 5000);
        timer.unref();
        req.on('data', (chunk: Buffer) => {
          dropped += chunk.length;
          if (dropped > DRAIN_LIMIT) req.socket.destroy();
        });
        const answer = (): void => {
          clearTimeout(timer);
          if (!res.headersSent && !req.socket.destroyed)
            refuse(res, 413, 'Too large.', { connection: 'close' });
        };
        if (req.readableEnded) answer();
        else req.on('end', answer);
        req.on('close', () => clearTimeout(timer));
        req.resume();
      };
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return tooLarge();
      const body = await readBody(req, MAX_BODY);
      if (body === undefined) return tooLarge();
      if (asksToListen(body)) return refuse(res, 404, 'Not found: this server has no subscriptions.');
      if (this.busy >= MAX_BUSY) {
        return refuse(res, 429, 'Too many requests at once: wait for the others to finish.', {
          'retry-after': '1',
        });
      }
      this.busy += 1;
      res.on('close', () => (this.busy -= 1));

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
      this.logError(error);
      if (!res.headersSent) refuse(res, 500, 'Something went wrong.');
      else res.destroy();
    }
  }
}
