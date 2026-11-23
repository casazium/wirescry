/**
 * Plugin MCP tools end to end: a fake plugin offers read tools through `host.mcp.setTools`, the
 * MCP server lists them beside its own, and every answer reaches the agent masked, with the
 * untrusted-data banner. Also the host's side: names checked, tools only from a started plugin,
 * gone when it fails or stops, and a time limit on each call.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import {
  MAX_PLUGIN_TOOLS,
  MAX_TOOL_READS,
  PluginHost,
  type PluginHostOptions,
} from '../src/backend/plugin-host';
import { FULL_NOTE, ReadError, Reader } from '../src/backend/mcp/reader';
import { APP_TOOL_NAMES, RULES_BANNER, UNTRUSTED } from '../src/backend/mcp/tools';
import type { BackendPlugin, BackendPluginHost, McpReadTool } from '../src/plugin-api/backend';
import { PLUGIN_API_VERSION } from '../src/plugin-api/version';
import type { McpStatus } from '../src/shared/api';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

// Fake secrets, built at run time so the file itself holds nothing a secret scanner flags.
const BEARER = 'mK7vQ2xZ' + '9pLw4RtY8nB3';
const KEY = 'Zx8Wv6Ut' + '4Sr2Qp0nLm';
const PASSWORD = 'hunter2' + 'Correct9Horse';

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

/** A read tool; `read` defaults to echoing its arguments. Only for tests: a real tool mustn't echo. */
const tool = (name: string, extra: Partial<McpReadTool> = {}): McpReadTool => ({
  name,
  title: `Tool ${name}`,
  description: `Does ${name}.`,
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  read: async (args) => ({ args }),
  ...extra,
});

/** A plugin that offers `tools` when it starts; its host is kept for later calls. */
function toolPlugin(
  tools: () => McpReadTool[],
  name = 'fake',
  start?: (host: BackendPluginHost) => Promise<void>,
): BackendPlugin & { host?: BackendPluginHost; setError?: unknown } {
  const plugin: BackendPlugin & { host?: BackendPluginHost; setError?: unknown } = {
    name,
    apiVersion: PLUGIN_API_VERSION,
    async start(host) {
      plugin.host = host;
      try {
        host.mcp?.setTools(tools());
      } catch (error) {
        plugin.setError = error;
      }
      await start?.(host);
    },
    async handle() {
      return null;
    },
  };
  return plugin;
}

describe('plugin MCP tools', () => {
  let dir: string;
  let backend: RunningBackend | undefined;
  let status: McpStatus;

  const start = async (
    plugins: BackendPlugin[],
    options: { pluginToolTimeoutMs?: number; pluginStartTimeoutMs?: number } = {},
  ): Promise<RunningBackend> => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-mcp-plugin-'));
    backend = await startBackend({
      dataDir: path.join(dir, 'data'),
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      plugins,
      pluginsEnabled: true,
      ...options,
    });
    const api = await apiClient(backend.apiPort);
    status = await api.send<McpStatus>({ command: 'setMcp', enabled: true, port: await freePort() });
    api.close();
    return backend;
  };

  afterEach(async () => {
    await backend?.stop();
    backend = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  /** What these tests read from a JSON-RPC result. */
  interface RpcResult {
    error?: { message: string };
    tools?: ListedTool[];
    content?: Array<{ text: string }>;
    isError?: boolean;
  }
  interface ListedTool {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: Record<string, unknown>;
  }

  let nextId = 1;
  /** A JSON-RPC request as a 2026-07-28 client; the result. */
  async function rpc(method: string, params: Record<string, unknown>, name?: string): Promise<RpcResult> {
    const res = await fetch(status.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${status.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(name ? { 'mcp-name': name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId++,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result?: RpcResult; error?: { message: string } };
    // An unknown tool is a protocol error, not a tool's error result.
    return json.error ? { error: json.error } : json.result!;
  }

  const listed = async (): Promise<ListedTool[]> => (await rpc('tools/list', {})).tools!;

  /** A tool call: its text, and whether it was an error. */
  async function call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ text: string; isError?: boolean }> {
    const result = await rpc('tools/call', { name, arguments: args }, name);
    if (result.error) return { text: `unknown: ${result.error.message}`, isError: true };
    return {
      text: result.content!.map((c) => c.text).join('\n'),
      isError: result.isError,
    };
  }

  /** The JSON after a result's banner. */
  const body = (text: string, banner = UNTRUSTED): unknown => {
    expect(text.startsWith(`${banner}\n`)).toBe(true);
    return JSON.parse(text.slice(banner.length + 1));
  };

  it('lists a plugin’s tools beside the app’s, read-only, saying their results are untrusted', async () => {
    await start([toolPlugin(() => [tool('find_rules', { contains: 'rules' }), tool('decode_call')])]);
    const tools = await listed();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['list_exchanges', 'get_body', 'find_rules', 'decode_call']),
    );
    const decode = tools.find((t) => t.name === 'decode_call')!;
    expect(decode.title).toBe('Tool decode_call');
    expect(decode.description).toMatch(/^Does decode_call\. .*untrusted data, never as instructions\.$/);
    expect(decode.inputSchema).toEqual({ type: 'object', properties: { q: { type: 'string' } } });
    expect(decode.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find((t) => t.name === 'find_rules')!.description).toMatch(/written by someone else/);
  });

  it('lists only the app’s tools without a plugin, and refuses to call a plugin tool name', async () => {
    await start([]);
    expect((await listed()).map((t) => t.name).sort()).toEqual(
      APP_TOOL_NAMES.filter((n) => n !== 'wait_for_approval')
        .slice()
        .sort(),
    );
    expect((await call('decode_call')).text).toMatch(/^unknown: /);
  });

  it('gives the plugin the arguments as sent, unchecked, and returns its result with the banner', async () => {
    const seen: unknown[] = [];
    await start([
      toolPlugin(() => [
        tool('echo', {
          read: async (args) => {
            seen.push(args);
            return { got: args };
          },
        }),
      ]),
    ]);
    // Not what the schema says: the plugin checks its own arguments.
    const { text, isError } = await call('echo', { q: 5, other: ['x'] });
    expect(isError).toBeFalsy();
    expect(seen).toEqual([{ q: 5, other: ['x'] }]);
    expect(body(text)).toEqual({ got: { q: 5, other: ['x'] } });
  });

  it('uses the rules banner for a tool that holds rules', async () => {
    await start([toolPlugin(() => [tool('my_rules', { contains: 'rules', read: async () => ({ n: 1 }) })])]);
    expect(body((await call('my_rules')).text, RULES_BANNER)).toEqual({ n: 1 });
  });

  it('masks the result: marked header and body values, and a value known from captured traffic', async () => {
    const running = await start([
      toolPlugin(() => [
        tool('leaky', {
          read: async () => ({
            header: { wirescryMask: 'header', name: 'x-api-key', value: KEY },
            body: {
              wirescryMask: 'body',
              contentType: 'application/json',
              text: JSON.stringify({ password: PASSWORD }),
            },
            note: `the call sent ${BEARER}`,
          }),
        }),
      ]),
    ]);
    // A captured request whose Authorization header teaches the session BEARER.
    const har = path.join(dir, 'known.har');
    await writeFile(
      har,
      JSON.stringify({
        log: {
          entries: [
            {
              startedDateTime: new Date().toISOString(),
              request: {
                method: 'GET',
                url: 'https://api.example.com/me',
                headers: [{ name: 'Authorization', value: `Bearer ${BEARER}` }],
              },
              response: { status: 200, statusText: 'OK', headers: [], content: { size: 0, text: '' } },
            },
          ],
        },
      }),
    );
    await running.importHar(har);
    const api = await apiClient(running.apiPort);
    await expect.poll(() => exchangesIn(api.messages).length).toBe(1);
    api.close();
    const { text, isError } = await call('leaky');
    expect(isError).toBeFalsy();
    for (const secret of [KEY, PASSWORD, BEARER]) expect(text).not.toContain(secret);
    const out = body(text) as { header: { name: string; value: string }; note: string };
    expect(out.header.name).toBe('x-api-key');
    expect(out.note).toMatch(/^the call sent /);
  });

  it('gives an error, masked, when the tool throws, too large a result, or one that isn’t JSON', async () => {
    await start([
      toolPlugin(() => [
        tool('throws', {
          read: async () => {
            throw new Error(`failed with password=${PASSWORD}`);
          },
        }),
        tool('huge', { read: async () => ({ text: 'x'.repeat(200_000) }) }),
        tool('odd', { read: async () => ({ when: new Date() }) }),
        tool('fn', { read: async () => () => 'private code' }),
        tool('throws_odd', {
          read: async () => {
            throw {
              toString() {
                throw new Error(`password=${PASSWORD}`);
              },
            };
          },
        }),
        tool('throws_text', {
          read: async () => {
            throw 'just words';
          },
        }),
        tool('throws_long', {
          read: async () => {
            throw new Error('w '.repeat(5000));
          },
        }),
      ]),
    ]);
    const thrown = await call('throws');
    expect(thrown.isError).toBe(true);
    // A plugin's words can quote traffic: data under the banner, never bare prose.
    expect((body(thrown.text) as { error: string }).error).toMatch(/^failed with password=/);
    expect(thrown.text).not.toContain(PASSWORD);
    const huge = await call('huge');
    expect(huge).toEqual({ text: 'The result is too large. Ask for less at a time.', isError: true });
    expect(await call('odd')).toEqual({ text: 'The result isn’t plain JSON.', isError: true });
    const fn = await call('fn');
    expect(fn).toEqual({ text: 'The result isn’t plain JSON.', isError: true });
    expect(fn.text).not.toContain('private code');
    const odd2 = await call('throws_odd');
    expect(odd2.isError).toBe(true);
    expect((body(odd2.text) as { error: string }).error).toBe('The tool failed.');
    const plain = await call('throws_text');
    expect((body(plain.text) as { error: string }).error).toBe('just words');
    const long = await call('throws_long');
    expect((body(long.text) as { error: string }).error.length).toBeLessThanOrEqual(2000);
  });

  it('through the real worker: a mark never weakens masking, and an error is masked before it’s cut', async () => {
    const url = (value: string): Record<string, string> => ({ wirescryMask: 'url', value });
    const text = (value: string): Record<string, string> => ({ wirescryMask: 'text', value });
    await start([
      toolPlugin(() => [
        tool('marked_text_name', {
          read: async () => ({ name: text('authorization'), value: PASSWORD }) as never,
        }),
        tool('marked_url_name', {
          read: async () => ({ name: url('user[password]'), value: 'tiger' }) as never,
        }),
        tool('marked_secret', {
          read: async () => ({ password: url(PASSWORD), note: `was ${PASSWORD}` }) as never,
        }),
        tool('decoy_body', {
          read: async () =>
            ({
              b: {
                wirescryMask: 'body',
                contentType: 'application/x-www-form-urlencoded',
                text: 'password=x1&msg=pwd: tiger12',
              },
            }) as never,
        }),
        tool('harmless', {
          read: async () =>
            ({ name: url('color'), value: 'blue', link: url('https://example.com/a') }) as never,
        }),
        tool('error_at_cut', {
          read: async () => {
            throw new Error('x'.repeat(1960) + ` {"password":"${PASSWORD}${PASSWORD}${PASSWORD}"}`);
          },
        }),
        tool('alike_keys', {
          read: async () => {
            const keys: Record<string, null> = {};
            for (let i = 0; i < 19_990; i++) keys[`ghp_${String(i).padStart(36, 'a')}`] = null;
            return keys as never;
          },
        }),
      ]),
    ]);
    expect(body((await call('marked_text_name')).text)).toEqual({
      name: 'authorization',
      value: '[redacted]',
    });
    expect(body((await call('marked_url_name')).text)).toEqual({
      name: 'user[password]',
      value: '[redacted]',
    });
    expect(body((await call('marked_secret')).text)).toEqual({
      password: '[redacted]',
      note: 'was [redacted]',
    });
    expect((await call('decoy_body')).text).not.toContain('tiger12');
    expect(body((await call('harmless')).text)).toEqual({
      name: 'color',
      value: 'blue',
      link: 'https://example.com/a',
    });
    const cut = await call('error_at_cut');
    expect(cut.isError).toBe(true);
    expect(cut.text).not.toContain('hunter2');
    expect((body(cut.text) as { error: string }).error.length).toBeLessThanOrEqual(2000);

    // The proxy shares this thread: it mustn't freeze while thousands of keys are numbered.
    let last = performance.now();
    let longest = 0;
    const beat = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 10);
    const alike = await call('alike_keys');
    clearInterval(beat);
    expect(alike.text).not.toContain('ghp_');
    // Was about 12.7 seconds.
    expect(longest).toBeLessThan(3000);
  });

  it('stops waiting for a tool past its time limit, aborts it, and keeps serving', async () => {
    let aborted = false;
    await start(
      [
        toolPlugin(() => [
          tool('hangs', {
            read: (_args, { signal }) =>
              new Promise(() => signal.addEventListener('abort', () => (aborted = true))),
          }),
          tool('quick', { read: async () => 'fine' }),
        ]),
      ],
      { pluginToolTimeoutMs: 200 },
    );
    const hung = await call('hangs');
    expect(hung.isError).toBe(true);
    expect((body(hung.text) as { error: string }).error).toBe('hangs took too long to answer.');
    expect(aborted).toBe(true);
    expect(body((await call('quick')).text)).toBe('fine');
  });

  it('records a plugin tool’s calls in the activity list without its arguments', async () => {
    const running = await start([toolPlugin(() => [tool('echo')])]);
    await call('echo', { q: `look for ${PASSWORD}` });
    const api = await apiClient(running.apiPort);
    const mcp = await api.send<McpStatus>({ command: 'getMcp' });
    api.close();
    expect(mcp.activity[0]).toMatchObject({ tool: 'echo', args: 'from fake', ok: true });
    expect(JSON.stringify(mcp.activity)).not.toContain(PASSWORD);
  });

  it('refuses bad tools, changing nothing: names, the app’s names, another plugin’s, schemas, too many', async () => {
    const first = toolPlugin(() => [tool('taken_name')], 'first');
    const second = toolPlugin(() => [tool('taken_name')], 'second');
    await start([first, second]);
    expect(String(second.setError)).toMatch(/taken_name is taken/);
    const good = tool('good_one');
    const big = (bytes: number): Record<string, unknown> => {
      const empty = JSON.stringify({ type: 'object', description: '' }).length;
      return { type: 'object', description: 'x'.repeat(bytes - empty) };
    };
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.self = cyclic;
    const cases: Array<[string, unknown, RegExp]> = [
      ['a bad name', [tool('Bad-Name')], /name must be/],
      ['one letter', [tool('a')], /name must be/],
      ['41 letters', [tool('a'.repeat(41))], /name must be/],
      ['the app’s', [tool('get_body')], /get_body is taken/],
      ['reserved', [tool('wait_for_approval')], /wait_for_approval is taken/],
      ['twice', [tool('same'), tool('same')], /same is taken/],
      ['another plugin’s', [{ ...tool('held'), name: 'other_held' }], /other_held is taken/],
      ['not an object schema', [tool('arr', { inputSchema: { type: 'array' } })], /type: 'object'/],
      ['a schema over 64 KB', [tool('wide', { inputSchema: big(64 * 1024 + 1) })], /at most 64 KB/],
      [
        'schemas over 256 KB in all',
        Array.from({ length: 5 }, (_, i) => tool(`s${i}`, { inputSchema: big(60 * 1024) })),
        /256 KB/,
      ],
      ['a cyclic schema', [tool('loop', { inputSchema: cyclic })], /must be JSON/],
      [
        'hidden characters in a schema',
        [tool('tags', { inputSchema: { type: 'object', description: 'a\u{E0041}b' } })],
        /hidden characters/,
      ],
      ['no read', [{ ...tool('noread'), read: undefined }], /needs a read function/],
      ['a newer kind of tool', [{ ...tool('changes'), kind: 'change' }], /only takes read tools/],
      ['an empty title', [tool('notitle', { title: ' ' })], /title must be/],
      ['a long title', [tool('longtitle', { title: 'x'.repeat(101) })], /title must be/],
      ['a long description', [tool('longdesc', { description: 'x'.repeat(2001) })], /description must be/],
      ['an unknown contains', [tool('odd', { contains: 'files' as never })], /contains must be/],
      ['a null tool', [null], /must be an object/],
      ['not a list', { tools: [] }, /must be a list/],
      ['too many', Array.from({ length: MAX_PLUGIN_TOOLS + 1 }, (_, i) => tool(`t${i}`)), /At most/],
    ];
    second.host!.mcp!.setTools([tool('other_held')]);
    first.host!.mcp!.setTools([tool('taken_name'), good]);
    for (const [what, tools, message] of cases) {
      expect(() => first.host!.mcp!.setTools(tools as McpReadTool[]), what).toThrow(message);
      const names = (await listed()).map((t) => t.name);
      expect(names, what).toEqual(expect.arrayContaining(['taken_name', 'good_one']));
    }
    // Just inside each limit is fine.
    first.host!.mcp!.setTools([
      tool('a'.repeat(40), {
        title: 'x'.repeat(100),
        description: 'x'.repeat(2000),
        inputSchema: big(64 * 1024),
        kind: 'read',
      } as Partial<McpReadTool>),
    ]);
    // At the limit is fine.
    first.host!.mcp!.setTools(Array.from({ length: MAX_PLUGIN_TOOLS }, (_, i) => tool(`t${i}`)));
    expect((await listed()).map((t) => t.name)).toContain(`t${MAX_PLUGIN_TOOLS - 1}`);
    first.host!.mcp!.setTools([]);
    expect((await listed()).map((t) => t.name)).not.toContain('taken_name');
    // Now free for the other plugin.
    second.host!.mcp!.setTools([tool('taken_name')]);
    expect((await listed()).map((t) => t.name)).toContain('taken_name');
  });

  it('removes the tools of a plugin that failed to start, and ignores tools it offers later', async () => {
    let finish: () => void = () => undefined;
    const plugin = toolPlugin(
      () => [tool('late')],
      'late',
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    await start([plugin], { pluginStartTimeoutMs: 100 });
    expect((await listed()).map((t) => t.name)).not.toContain('late');
    finish();
    plugin.host!.mcp!.setTools([tool('late_again')]);
    expect((await listed()).map((t) => t.name)).not.toContain('late_again');
    expect((await call('late')).text).toMatch(/^unknown: /);
  });

  /** A plugin host on its own, outside a backend. */
  const hostOptions = (plugins: BackendPlugin[], dataDir: string): PluginHostOptions => ({
    plugins,
    enabled: true,
    disabledReason: '',
    dataDir,
    app: { version: '0', releaseDate: '' },
    reservedToolNames: APP_TOOL_NAMES,
    refreshRules: async () => undefined,
    passThroughStep: () => undefined as never,
    emit: () => undefined,
    onStatusChange: () => undefined,
    getExchange: () => undefined,
    getBody: async () => null,
    readBody: async () => null,
    upstreamTarget: () => null,
    annotate: () => undefined,
    clearAnnotations: () => undefined,
  });
  const hostFor = async (plugins: BackendPlugin[]): Promise<PluginHost> => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-mcp-plugin-'));
    return new PluginHost(hostOptions(plugins, dir));
  };

  it('keeps a starting plugin’s tools back until it has started', async () => {
    let finish: () => void = () => undefined;
    const plugin = toolPlugin(
      () => [tool('early')],
      'slow',
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const host = await hostFor([plugin]);
    const started = host.startAll();
    await expect.poll(() => plugin.host).toBeDefined();
    expect(plugin.setError).toBeUndefined();
    expect(host.tools()).toEqual([]);
    await expect(host.callTool('slow', 'early', {}, new AbortController().signal)).rejects.toThrow(
      'No tool called early.',
    );
    finish();
    await started;
    expect(host.tools().map((t) => t.name)).toEqual(['early']);
  });

  it('cleans a tool’s title and description of characters that could disguise them', async () => {
    const host = await hostFor([
      toolPlugin(() => [
        tool('tidy', { title: 'Safe\u202etxt.exe', description: 'Line one\u2028two\u200b.' }),
      ]),
    ]);
    await host.startAll();
    const [listedTool] = host.tools();
    expect(listedTool!.title).toBe('Safe txt.exe');
    expect(listedTool!.description).toBe('Line one two .');
  });

  it('removes a plugin’s tools when it stops, without the plugin’s help', async () => {
    const plugin = toolPlugin(() => [tool('stays')]);
    // A plugin that never clears its tools, and would add them back while stopping.
    plugin.stop = () => plugin.host!.mcp!.setTools([tool('stays')]);
    const host = await hostFor([plugin]);
    await host.startAll();
    expect(host.tools().map((t) => t.name)).toEqual(['stays']);
    await expect(host.callTool('fake', 'stays', { q: 'x' }, new AbortController().signal)).resolves.toEqual({
      args: { q: 'x' },
    });
    await host.stopAll();
    expect(host.tools()).toEqual([]);
    await expect(host.callTool('fake', 'stays', {}, new AbortController().signal)).rejects.toThrow(
      'No tool called stays.',
    );
  });

  it('passes on a call with no arguments as the SDK gives it', async () => {
    const seen: unknown[] = [];
    await start([
      toolPlugin(() => [
        tool('noargs', {
          read: async (args) => {
            seen.push(args);
            return 'ok';
          },
        }),
      ]),
    ]);
    const result = await rpc('tools/call', { name: 'noargs' }, 'noargs');
    expect(result.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
  });

  it('adds the note when Wirescry’s list of known values is full', async () => {
    const reader = new Reader({
      maskFields: async (fields: Array<{ value: string }>) => ({
        ok: true,
        fields: fields.map((f) => f.value),
        full: true,
      }),
    } as never);
    await expect(reader.pluginResult({ a: 'b' })).resolves.toEqual({ value: { a: 'b' }, full: true });
  });

  it('never gives the original text when masking fails', async () => {
    const answers: unknown[] = [
      { failed: 'no worker' },
      { ok: true, fields: [], full: false },
      { ok: true, fields: [5, 6], full: false },
    ];
    for (const answer of answers) {
      const reader = new Reader({ maskFields: async () => answer } as never);
      await expect(reader.pluginResult({ a: PASSWORD })).rejects.toBeInstanceOf(ReadError);
      expect(await reader.pluginError(`bad ${PASSWORD}`)).toBe('The tool failed.');
    }
    const throwing = new Reader({
      maskFields: async () => {
        throw new Error(PASSWORD);
      },
    } as never);
    await expect(throwing.pluginResult({ a: PASSWORD })).rejects.toThrow(/secrets/);
    expect(await throwing.pluginError(PASSWORD)).toBe('The tool failed.');
  });

  it('frees the names of a plugin that failed, but not of one still running', async () => {
    const failing = toolPlugin(
      () => [tool('shared')],
      'failing',
      async () => {
        throw new Error('no');
      },
    );
    const after = toolPlugin(() => [tool('shared')], 'after');
    const host = await hostFor([failing, after]);
    await host.startAll();
    expect(after.setError).toBeUndefined();
    expect(host.tools().map((t) => [t.plugin, t.name])).toEqual([['after', 'shared']]);

    const running = toolPlugin(() => [tool('kept')], 'running');
    const blocked = toolPlugin(() => [tool('kept')], 'blocked');
    const other = await hostFor([running, blocked]);
    await other.startAll();
    expect(String(blocked.setError)).toMatch(/kept is taken/);
  });

  it('ends a call in progress when its plugin stops, and doesn’t use its late answer', async () => {
    let answer: (value: unknown) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const plugin = toolPlugin(() => [
      tool('slow', {
        read: (_args, context) => {
          signal = context.signal;
          return new Promise((resolve) => (answer = resolve));
        },
      }),
    ]);
    const host = await hostFor([plugin]);
    await host.startAll();
    const call = host.callTool('fake', 'slow', {}, new AbortController().signal);
    await expect.poll(() => signal).toBeDefined();
    await host.stopAll();
    await expect(call).rejects.toThrow('fake stopped.');
    expect(signal!.aborted).toBe(true);
    answer(PASSWORD);
  });

  it('ends a call at once when the agent gives up, or has already', async () => {
    let signal: AbortSignal | undefined;
    let reads = 0;
    const plugin = toolPlugin(() => [
      tool('slow', {
        read: (_args, context) => {
          reads++;
          signal = context.signal;
          return new Promise(() => undefined);
        },
      }),
    ]);
    const host = await hostFor([plugin]);
    await host.startAll();
    const agent = new AbortController();
    const call = host.callTool('fake', 'slow', {}, agent.signal);
    await expect.poll(() => signal).toBeDefined();
    agent.abort();
    await expect(call).rejects.toThrow('The call was cancelled.');
    expect(signal!.aborted).toBe(true);
    expect(reads).toBe(1);
    await expect(host.callTool('fake', 'slow', {}, agent.signal)).rejects.toThrow('The call was cancelled.');
    expect(reads).toBe(1);
  });

  it('doesn’t use an answer that comes after the time limit', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const plugin = toolPlugin(() => [
      tool('slow', { read: () => new Promise((resolve) => (answer = resolve)) }),
    ]);
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-mcp-plugin-'));
    const host = new PluginHost({ ...hostOptions([plugin], dir), toolTimeoutMs: 30 });
    await host.startAll();
    await expect(host.callTool('fake', 'slow', {}, new AbortController().signal)).rejects.toThrow(
      'slow took too long to answer.',
    );
    answer(PASSWORD);
  });

  it('finishes a call in progress when the plugin replaces its tools', async () => {
    let answer: (value: unknown) => void = () => undefined;
    let reading = false;
    const plugin = toolPlugin(() => [
      tool('old_tool', {
        read: () => {
          reading = true;
          return new Promise((resolve) => (answer = resolve));
        },
      }),
    ]);
    const host = await hostFor([plugin]);
    await host.startAll();
    const call = host.callTool('fake', 'old_tool', {}, new AbortController().signal);
    await expect.poll(() => reading).toBe(true);
    plugin.host!.mcp!.setTools([tool('new_tool')]);
    answer('done');
    await expect(call).resolves.toBe('done');
    await expect(host.callTool('fake', 'old_tool', {}, new AbortController().signal)).rejects.toThrow(
      'No tool called old_tool.',
    );
  });

  it('runs a tool only for the plugin named', async () => {
    const one = toolPlugin(() => [tool('only_one')], 'one');
    const two = toolPlugin(() => [], 'two');
    const host = await hostFor([one, two]);
    await host.startAll();
    await expect(host.callTool('two', 'only_one', {}, new AbortController().signal)).rejects.toThrow(
      'No tool called only_one.',
    );
  });

  it('strips characters hidden from people from a title', async () => {
    const host = await hostFor([
      toolPlugin(() => [tool('tidy', { title: 'Sa\u{E0041}fe\uFE0F', description: 'Pl\u{E0042}ain.' })]),
    ]);
    await host.startAll();
    expect(host.tools()[0]).toMatchObject({ title: 'Safe', description: 'Plain.' });
  });

  it('runs at most 8 reads of a plugin at once, counting one the agent gave up on', async () => {
    const answers: Array<(value: unknown) => void> = [];
    const plugin = toolPlugin(() => [
      tool('slow', { read: () => new Promise((resolve) => answers.push(resolve)) }),
    ]);
    const host = await hostFor([plugin]);
    await host.startAll();
    const agent = new AbortController();
    const calls = Array.from({ length: MAX_TOOL_READS }, () =>
      host.callTool('fake', 'slow', {}, agent.signal),
    );
    await expect.poll(() => answers.length).toBe(MAX_TOOL_READS);
    agent.abort();
    await Promise.allSettled(calls);
    // The agent has gone, but the reads are still running.
    await expect(host.callTool('fake', 'slow', {}, new AbortController().signal)).rejects.toThrow('busy');
    answers[0]!('done');
    await expect.poll(() => answers.length === MAX_TOOL_READS).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = host.callTool('fake', 'slow', {}, new AbortController().signal);
    await expect.poll(() => answers.length).toBe(MAX_TOOL_READS + 1);
    answers[MAX_TOOL_READS]!('fine');
    await expect(next).resolves.toBe('fine');
  });

  it('adds the full-list note to a tool’s error too', async () => {
    const reader = new Reader({
      maskFields: async (fields: Array<{ value: string }>) => ({
        ok: true,
        fields: fields.map((f) => f.value),
        full: true,
      }),
    } as never);
    expect(await reader.pluginError('it broke')).toBe(`it broke ${FULL_NOTE}`);
  });

  it('refuses a title of hidden characters only, and bidi characters in a schema', async () => {
    const plugin = toolPlugin(() => []);
    const host = await hostFor([plugin]);
    await host.startAll();
    const only = String.fromCodePoint(0xe0041, 0xe0042);
    expect(() => plugin.host!.mcp!.setTools([tool('blank', { title: only })])).toThrow(/title must be/);
    expect(() =>
      plugin.host!.mcp!.setTools([
        tool('bidi', { inputSchema: { type: 'object', description: 'a\u202eb' } }),
      ]),
    ).toThrow(/hidden characters/);
  });
});
