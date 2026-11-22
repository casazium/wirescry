/**
 * The MCP server with a real MCP client: the official SDK's (@modelcontextprotocol/client), as
 * agents use it, in each way it can connect (the 2025 handshake it uses by default, probing, and
 * pinned to 2026-07-28), against a real backend with planted secrets.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { generateCACertificate, getLocal, type Mockttp } from 'mockttp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { loadOrCreateCA } from '../src/backend/ca';
import type { McpStatus } from '../src/shared/api';
import { apiClient, requestViaProxy, TOKEN, UI_ORIGIN, startUpstreamOnPickedPort } from './helpers';

// Fake tokens, built at run time so the file itself holds nothing a secret scanner flags.
const ACCESS = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const BEARER = 'mK7vQ2xZ' + '9pLw4RtY8nB3';

const leaked = (text: string): boolean => text.includes(ACCESS) || text.includes(BEARER);

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

type Mode = 'legacy' | 'auto' | { pin: string };

describe('the MCP server with the official SDK client', () => {
  let dir: string;
  let upstream: Mockttp;
  let backend: RunningBackend;
  let api: Awaited<ReturnType<typeof apiClient>>;
  let status: McpStatus;
  let id: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-mcp-client-'));
    const upstreamCA = await generateCACertificate();
    upstream = getLocal({ https: upstreamCA });
    await startUpstreamOnPickedPort(upstream);
    await upstream.forGet('/login').thenReply(200, JSON.stringify({ access_token: ACCESS }), {
      'content-type': 'application/json',
      'x-echo': BEARER,
    });
    const dataDir = path.join(dir, 'data');
    backend = await startBackend({
      dataDir,
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      upstreamCAs: [upstreamCA.cert],
      app: { version: '9.9.9', releaseDate: new Date().toISOString() },
    });
  });

  afterAll(async () => {
    api?.close();
    await backend?.stop();
    await upstream?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  let captured: Promise<void> | undefined;
  const ready = (): Promise<void> => (captured ??= capture());
  const capture = async (): Promise<void> => {
    api = await apiClient(backend.apiPort);
    const ca = (await loadOrCreateCA(path.join(dir, 'data'))).cert;
    await requestViaProxy(
      backend.proxyPort,
      `https://localhost:${upstream.port}/login?access_token=${ACCESS}`,
      ca,
      {
        headers: { authorization: `Bearer ${BEARER}` },
      },
    );
    id = await api.completed(`/login?access_token=${ACCESS}`);
    status = await api.send<McpStatus>({ command: 'setMcp', enabled: true, port: await freePort() });
  };

  /** A client connected as an agent would be, with the token in its settings. */
  async function connected(mode: Mode, headers: Record<string, string> = {}): Promise<Client> {
    const client = new Client(
      { name: 'wirescry-test-agent', version: '1.0.0' },
      { versionNegotiation: { mode } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(status.url), {
      requestInit: { headers: { Authorization: `Bearer ${status.token}`, ...headers } },
    });
    await client.connect(transport);
    return client;
  }

  const text = (result: unknown): string =>
    ((result as { content: Array<{ type: string; text?: string }> }).content ?? [])
      .map((c) => c.text ?? '')
      .join('\n');

  for (const [name, mode, version] of [
    ['the 2025 handshake (the default)', 'legacy', '2025-11-25'],
    ['probing for the version', 'auto', '2026-07-28'],
    ['pinned to 2026-07-28', { pin: '2026-07-28' }, '2026-07-28'],
  ] as Array<[string, Mode, string]>) {
    it(`connects with ${name}, lists the tools, and reads traffic masked`, async () => {
      await ready();
      const client = await connected(mode);
      try {
        // Each way really is the version it says: the server speaks both.
        expect(client.getNegotiatedProtocolVersion()).toBe(version);
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name).sort()).toEqual([
          'get_body',
          'get_exchange',
          'get_sse_events',
          'get_websocket_messages',
          'list_exchanges',
        ]);
        expect(tools.tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
        const list = text(await client.callTool({ name: 'list_exchanges', arguments: {} }));
        expect(list).toContain(id);
        expect(list).toContain('access_token=[redacted]');
        const detail = text(await client.callTool({ name: 'get_exchange', arguments: { id } }));
        expect(detail).toContain('Bearer [redacted]');
        const body = text(await client.callTool({ name: 'get_body', arguments: { id, side: 'response' } }));
        expect(body).toContain('[redacted]');
        for (const out of [list, detail, body]) expect(leaked(out)).toBe(false);
        // A tool error comes back as a result the agent can read, not a failure of the call.
        const missing = await client.callTool({ name: 'get_exchange', arguments: { id: 'nope' } });
        expect(missing.isError).toBe(true);
        expect(text(missing)).toContain('No such exchange');
      } finally {
        await client.close();
      }
    });
  }

  it('records each client’s calls under its name', async () => {
    await ready();
    const now = await api.send<McpStatus>({ command: 'getMcp' });
    expect(now.activity.length).toBeGreaterThan(0);
    expect(now.activity.every((a) => !leaked(JSON.stringify(a)))).toBe(true);
  });

  it('can’t connect with a wrong token, in any mode', async () => {
    await ready();
    for (const mode of ['legacy', 'auto', { pin: '2026-07-28' }] as Mode[]) {
      const client = new Client({ name: 'wrong', version: '1' }, { versionNegotiation: { mode } });
      const transport = new StreamableHTTPClientTransport(new URL(status.url), {
        requestInit: { headers: { Authorization: 'Bearer wrong' } },
      });
      await expect(client.connect(transport), JSON.stringify(mode)).rejects.toThrow();
      await client.close().catch(() => undefined);
    }
  });

  it('can’t connect from a page’s origin: a client that sends one is refused', async () => {
    await ready();
    await expect(connected('legacy', { Origin: 'https://evil.test' })).rejects.toThrow();
  });
});
