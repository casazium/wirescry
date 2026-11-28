/**
 * An agent's stream reads when the mask worker can't check what the reader teaches it first
 * (security review 2, F10): the read fails with a plain error, and nothing is shown, rather than
 * a page masked without what the rest of the stream names. The worker is real; its answers to
 * agents' stream jobs are made to fail on demand.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunningBackend } from '../src/backend/backend';
import type { McpStatus } from '../src/shared/api';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

type RealMasker = import('../src/backend/masker').Masker;

const failing = vi.hoisted(() => ({ on: false }));

vi.mock('../src/backend/masker', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/backend/masker')>();
  class Masker extends real.Masker {
    override async maskMessages(...args: Parameters<RealMasker['maskMessages']>) {
      if (failing.on && args[0].startsWith(real.AGENT_GROUP)) return { failed: real.MASK_FAILED };
      return super.maskMessages(...args);
    }
    override async maskEvents(...args: Parameters<RealMasker['maskEvents']>) {
      if (failing.on && args[0].startsWith(real.AGENT_GROUP)) return { failed: real.MASK_FAILED };
      return super.maskEvents(...args);
    }
  }
  return { ...real, Masker };
});

const { startBackend } = await import('../src/backend/backend');

// A fake secret, built at run time so the file itself holds nothing a secret scanner flags.
const PASSWORD = 'hunter2' + 'Correct9Horse';

describe('an agent’s stream read when teaching fails', () => {
  let dir: string;
  let backend: RunningBackend;
  let status: McpStatus;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-mcp-teach-'));
    backend = await startBackend({
      dataDir: path.join(dir, 'data'),
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
    });
    const source = path.join(dir, 'streams.har');
    const at = '2026-11-20T12:00:00.000Z';
    await writeFile(
      source,
      JSON.stringify({
        log: {
          entries: [
            {
              startedDateTime: at,
              _resourceType: 'websocket',
              request: { method: 'GET', url: 'wss://example.com/socket', headers: [] },
              response: { status: 101, statusText: 'Switching Protocols' },
              _webSocketMessages: [
                { type: 'receive', time: 1, opcode: 1, data: `note ${PASSWORD}` },
                { type: 'receive', time: 2, opcode: 1, data: JSON.stringify({ password: PASSWORD }) },
              ],
            },
            {
              startedDateTime: at,
              request: { method: 'GET', url: 'https://example.com/events', headers: [] },
              response: {
                status: 200,
                headers: [{ name: 'content-type', value: 'text/event-stream' }],
                content: {
                  mimeType: 'text/event-stream',
                  text: `data: note ${PASSWORD}\n\ndata: {"password":"${PASSWORD}"}\n\n`,
                },
              },
            },
          ],
        },
      }),
    );
    const api = await apiClient(backend.apiPort);
    await backend.importHar(source);
    await vi.waitFor(() => expect(exchangesIn(api.messages)).toHaveLength(2));
    for (const e of exchangesIn(api.messages)) ids[new URL(e.url).pathname.slice(1)] = e.id;
    const s = net.createServer();
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    const port = (s.address() as net.AddressInfo).port;
    await new Promise((resolve) => s.close(resolve));
    status = await api.send<McpStatus>({ command: 'setMcp', enabled: true, port });
    api.close();
  });

  afterAll(async () => {
    await backend?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  let nextId = 1;
  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError?: boolean }> {
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
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return { text: json.result.content.map((c) => c.text).join('\n'), isError: json.result.isError };
  }

  it('fails a WebSocket read plainly, showing nothing, then works once the worker can check it', async () => {
    failing.on = true;
    try {
      const out = await call('get_websocket_messages', { id: ids.socket, limit: 1 });
      expect(out.isError).toBe(true);
      expect(out.text).toContain('Couldn’t check this stream for secrets');
      expect(out.text).not.toContain(PASSWORD);
    } finally {
      failing.on = false;
    }
    const out = await call('get_websocket_messages', { id: ids.socket, limit: 1 });
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain('note [redacted]');
  });

  it('fails an event stream read plainly the same way, then works', async () => {
    failing.on = true;
    try {
      const out = await call('get_sse_events', { id: ids.events });
      expect(out.isError).toBe(true);
      expect(out.text).toContain('Couldn’t check this stream for secrets');
      expect(out.text).not.toContain(PASSWORD);
    } finally {
      failing.on = false;
    }
    const out = await call('get_sse_events', { id: ids.events });
    expect(out.isError).toBeFalsy();
    expect(out.text).not.toContain(PASSWORD);
    expect(out.text).toContain('[redacted]');
  });
});
