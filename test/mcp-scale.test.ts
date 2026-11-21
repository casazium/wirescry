/**
 * The MCP server with a full list: 10,000 exchanges (Wirescry's limit), an agent's filtered
 * searches over all of them, and the proxy and the window kept responsive meanwhile. Masking runs
 * in a worker, so the proxy's thread should never wait on it.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import type { BodyContent, McpStatus } from '../src/shared/api';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

const SECRET = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const COUNT = 10_000;

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

describe('the MCP server with a full list', { timeout: 300_000 }, () => {
  let dir: string;
  let backend: RunningBackend;
  let upstream: http.Server;
  let upstreamPort: number;
  let api: Awaited<ReturnType<typeof apiClient>>;
  let status: McpStatus;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-mcp-scale-'));
    upstream = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as net.AddressInfo).port;
    backend = await startBackend({
      dataDir: path.join(dir, 'data'),
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      app: { version: '9.9.9', releaseDate: new Date().toISOString() },
    });
  }, 120_000);

  afterAll(async () => {
    api?.close();
    await backend?.stop();
    upstream?.close();
    await rm(dir, { recursive: true, force: true });
  });

  let loaded: Promise<void> | undefined;
  const ready = (): Promise<void> => (loaded ??= load());
  const load = async (): Promise<void> => {
    api = await apiClient(backend.apiPort);
    const started = Date.parse('2026-11-21T12:00:00.000Z');
    const entries = Array.from({ length: COUNT }, (_, i) => ({
      startedDateTime: new Date(started + i).toISOString(),
      time: 5,
      request: {
        method: 'GET',
        url: `https://api.test/item/${i}?access_token=${SECRET}`,
        httpVersion: 'HTTP/1.1',
        headers: [{ name: 'Authorization', value: `Bearer ${SECRET}` }],
      },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        content: { size: 30, mimeType: 'application/json', text: `{"token":"${SECRET}","n":${i}}` },
      },
      timings: { send: 1, wait: 3, receive: 1 },
    }));
    const file = path.join(dir, 'big.har');
    await writeFile(file, JSON.stringify({ log: { version: '1.2', entries } }));
    await backend.importHar(file);
    await expect.poll(() => exchangesIn(api.messages).length, { timeout: 120_000 }).toBe(COUNT);
    status = await api.send<McpStatus>({ command: 'setMcp', enabled: true, port: await freePort() });
  };

  let nextId = 1;
  async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; ms: number }> {
    const start = performance.now();
    const res = await fetch(status.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${status.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    return { text, ms: performance.now() - start };
  }

  /** A request through the proxy, timed. */
  function proxied(): Promise<number> {
    const start = performance.now();
    return new Promise((resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port: backend.proxyPort, path: `http://127.0.0.1:${upstreamPort}/ping` },
          (res) => {
            res.resume();
            res.on('end', () => resolve(performance.now() - start));
          },
        )
        .on('error', reject);
    });
  }

  it('searches all 10,000 masked, in reasonable time, with nothing leaked', async () => {
    await ready();
    const first = await call('list_exchanges', { limit: 50 });
    expect(first.text).not.toContain(SECRET);
    // A query matching one exchange, near the oldest: every summary is masked and matched.
    const deep = await call('list_exchanges', { query: 'path~/item/17?access', limit: 5 });
    expect(deep.text).not.toContain(SECRET);
    expect(deep.text).toContain('/item/17');
    console.log(`[scale] first page ${first.ms.toFixed(0)} ms, full search ${deep.ms.toFixed(0)} ms`);
    expect(deep.ms).toBeLessThan(60_000);
  });

  it('keeps the proxy and the window responsive while an agent searches everything', async () => {
    await ready();
    // Three agents' searches over the whole list at once.
    const searches = Promise.all(
      [1, 2, 3].map((n) => call('list_exchanges', { query: `path~/item/${n}9`, limit: 200 })),
    );
    const latencies: number[] = [];
    let searching = true;
    void searches.finally(() => (searching = false));
    // The window opens a body, masked, while they run: its job goes ahead of theirs.
    const id = exchangesIn(api.messages).at(-1)!.id;
    const windowStart = performance.now();
    const body = await api.send<BodyContent>({
      command: 'getBody',
      exchangeId: id,
      side: 'response',
      mask: true,
    });
    const windowMs = performance.now() - windowStart;
    expect(Buffer.from(body.base64, 'base64').toString()).not.toContain(SECRET);
    while (searching) {
      latencies.push(await proxied());
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const result of await searches) expect(result.text).not.toContain(SECRET);
    const worst = Math.max(...latencies);
    console.log(
      `[scale] window body ${windowMs.toFixed(0)} ms; proxy ${latencies.length} requests, worst ${worst.toFixed(0)} ms`,
    );
    expect(latencies.length).toBeGreaterThan(0);
    expect(worst).toBeLessThan(1_000);
    expect(windowMs).toBeLessThan(10_000);
  });
});
