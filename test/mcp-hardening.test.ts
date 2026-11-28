/**
 * Small hardening from security review 2 (F14): an agent's search can't confirm a secret sent as a
 * request's method, and the MCP server's token is passed to the app's log scrubber when it's loaded
 * and each time it's made anew.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { Reader, type ReaderBackend } from '../src/backend/mcp/reader';
import type { McpStatus } from '../src/shared/api';
import { apiClient, TOKEN, UI_ORIGIN } from './helpers';

// A fake secret, built at run time so the file holds nothing a secret scanner flags.
const SECRET = 'Q2xA9fK3' + 'mZ7pL1sW8eR4';

describe('search over what agents see', () => {
  /** A backend whose masking hides SECRET wherever it appears, as a known value would be. */
  const backend = (method: string): ReaderBackend => ({
    summaries: () => [
      {
        id: 'a',
        method,
        protocol: 'https',
        httpVersion: '1.1',
        host: 'h.test',
        path: '/x',
        url: 'https://h.test/x',
        startedAt: 0,
      },
    ],
    detail: () => undefined,
    maskFields: async (fields) => ({
      fields: fields.map((f) => f.value.split(SECRET).join('[redacted]')),
      full: false,
    }),
    part: () => ({}),
    body: async () => null,
    wsPage: () => ({ messages: [], dropped: 0, total: 0 }),
    maskMessages: async (_d, page) => page,
    sseRead: async () => null,
    maskEvents: async (_d, view) => view,
    generation: () => 1,
  });

  it('can’t confirm a secret sent as the method, by field or by text', async () => {
    const reader = new Reader(backend(SECRET));
    expect((await reader.list(`method=${SECRET}`, 50, undefined)).exchanges).toEqual([]);
    expect((await reader.list(SECRET, 50, undefined)).exchanges).toEqual([]);
    expect((await reader.list(SECRET.slice(0, 10), 50, undefined)).exchanges).toEqual([]);
    expect((await reader.list(`method~${SECRET.slice(2, 12)}`, 50, undefined)).exchanges).toEqual([]);
    // Nor by leaving it out: excluding the secret keeps the exchange, as it would any other method.
    expect((await reader.list(`-method=${SECRET}`, 50, undefined)).exchanges).toHaveLength(1);
    // What the agent sees is what it can search: the masked method.
    const all = await reader.list(undefined, 50, undefined);
    expect(all.exchanges[0]!.method).toBe('[redacted]');
    expect((await reader.list('method=[redacted]', 50, undefined)).exchanges).toHaveLength(1);
  });

  it('still finds an ordinary method', async () => {
    const reader = new Reader(backend('PATCH'));
    expect((await reader.list('method=PATCH', 50, undefined)).exchanges).toHaveLength(1);
    expect((await reader.list('PATCH', 50, undefined)).exchanges).toHaveLength(1);
    expect((await reader.list('method=GET', 50, undefined)).exchanges).toEqual([]);
    expect((await reader.list('method~ATC', 50, undefined)).exchanges).toHaveLength(1);
    expect((await reader.list('-method=PATCH', 50, undefined)).exchanges).toEqual([]);
  });
});

describe('the MCP token and the log', () => {
  let dir: string;
  let backend: RunningBackend | undefined;
  afterEach(async () => {
    await backend?.stop();
    backend = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  const freePort = async (): Promise<number> => {
    const s = net.createServer();
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    const port = (s.address() as net.AddressInfo).port;
    await new Promise((resolve) => s.close(resolve));
    return port;
  };

  it('is told when made, again when made anew, and once on the next start', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-mcp-secret-'));
    const told: string[] = [];
    const start = () =>
      startBackend({
        dataDir: path.join(dir, 'data'),
        token: TOKEN,
        allowedOrigins: [UI_ORIGIN],
        onSecret: (secret) => told.push(secret),
      });
    backend = await start();
    // None yet: MCP has never been turned on, so there's no token.
    expect(told).toEqual([]);
    const api = await apiClient(backend.apiPort);
    const on = await api.send<McpStatus>({ command: 'setMcp', enabled: true, port: await freePort() });
    expect(told).toEqual([on.token]);
    // The same token again (a port change) isn't told twice.
    await api.send<McpStatus>({ command: 'setMcp', port: await freePort() });
    expect(told).toEqual([on.token]);
    const reset = await api.send<McpStatus>({ command: 'setMcp', resetToken: true });
    expect(reset.token).not.toBe(on.token);
    expect(told).toEqual([on.token, reset.token]);
    // Turned off, the token is kept, and told on the next start.
    await api.send<McpStatus>({ command: 'setMcp', enabled: false });
    api.close();
    await backend.stop();
    told.length = 0;
    backend = await start();
    expect(told).toEqual([reset.token]);
  });

  it('is told before the rest of startup, so nothing logged while starting can show it', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-mcp-secret-'));
    const events: string[] = [];
    const start = () =>
      startBackend({
        dataDir: path.join(dir, 'data'),
        token: TOKEN,
        allowedOrigins: [UI_ORIGIN],
        onSecret: () => events.push('secret'),
        onStartupStep: (s) => events.push(s),
      });
    backend = await start();
    const api = await apiClient(backend.apiPort);
    await api.send<McpStatus>({ command: 'setMcp', enabled: true, port: await freePort() });
    api.close();
    await backend.stop();
    events.length = 0;
    backend = await start();
    // Right after the settings are read: only the certificate step comes first.
    expect(events.slice(0, 2)).toEqual(['certificate', 'secret']);
    expect(events.filter((e) => e === 'secret')).toHaveLength(1);
  });
});
