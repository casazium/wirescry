/**
 * Hidden characters in what agents read (security review 2, F9): tag characters, bidi controls,
 * zero-width characters, line separators and the like, written as visible `\uXXXX` escapes in
 * every MCP tool result, losslessly for the JSON. The function itself, the character set at its
 * edges and over every code point, every exit of the server (traffic tools, plugin tools, their
 * errors, a failure the tool didn't expect), and plugin tool metadata.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type RunningBackend } from '../src/backend/backend';
import { McpHttpServer } from '../src/backend/mcp/http';
import { FULL_NOTE, Reader, type ReaderBackend } from '../src/backend/mcp/reader';
import { guarded, RULES_BANNER, shown, UNTRUSTED } from '../src/backend/mcp/tools';
import { validateTools } from '../src/backend/plugin-host';
import type { BackendPlugin, McpReadTool } from '../src/plugin-api/backend';
import { PLUGIN_API_VERSION } from '../src/plugin-api/version';
import type { McpStatus } from '../src/shared/api';
import { INVISIBLE, visible } from '../src/shared/visible';
import { apiClient, exchangesIn, TOKEN, UI_ORIGIN } from './helpers';

// Spelled with escapes, so this file shows what it holds.
const TAG_A = '\u{E0041}'; // TAG LATIN CAPITAL LETTER A
const LS = '\u2028';
const RLO = '\u202e';
const ZWSP = '\u200b';
const ZWJ = '\u200d';
const VS16 = '\ufe0f';
const VS_SUP = '\u{E0100}'; // VARIATION SELECTOR-17, used to carry bytes
const BOM = '\ufeff';
const NEL = '\u0085';
const DEL = '\u007f';
/** Tags spelling "ignore", the way an instruction is hidden. */
const HIDDEN = [...'ignore'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
const NASTY = `ok${TAG_A}${LS}${RLO}${ZWSP}${HIDDEN}end`;

/** Any character a person wouldn't see, raw (tab and newline aside). */
const RAW = new RegExp(INVISIBLE.source, 'u');

/** Every string in a parsed value, keys included. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      strings(v, out);
    }
  }
  return out;
}

/** A small seeded generator, so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('visible()', () => {
  const escaped = (cp: number): boolean => visible(String.fromCodePoint(cp)) !== String.fromCodePoint(cp);

  it('escapes what the finding showed, as JSON writes it', () => {
    expect(visible(TAG_A)).toBe('\\udb40\\udc41');
    expect(visible(LS)).toBe('\\u2028');
    expect(visible(RLO)).toBe('\\u202e');
    expect(visible(`a${ZWSP}b`)).toBe('a\\u200bb');
    expect(visible(NEL + DEL)).toBe('\\u0085\\u007f');
    expect(visible(BOM)).toBe('\\ufeff');
    expect(visible(VS_SUP)).toBe('\\udb40\\udd00');
  });

  it('escapes on both sides of each edge of the set, and leaves the neighbours alone', () => {
    const yes = [
      0x7f, 0x80, 0x9f, 0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180e, 0x180f, 0x200b,
      0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2064, 0x2065, 0x2066, 0x2069,
      0x206a, 0x206f, 0x3164, 0xfe00, 0xfe0f, 0xfeff, 0xffa0, 0xfff0, 0xfff9, 0xfffb, 0xfffe, 0xffff, 0xe000,
      0xf8ff, 0xe0000, 0xe0001, 0xe0020, 0xe007f, 0xe0080, 0xe0100, 0xe01ef, 0xe01f0, 0xe0fff, 0xd, 0x1d173,
      0xf0000, 0x10ffff,
    ];
    const no = [
      0x20, 0x41, 0x7e, 0xa0, 0xae, 0xe9, 0x34e, 0x5d0, 0x627, 0x115e, 0x17b3, 0x200a, 0x2010, 0x2019, 0x2027,
      0x202f, 0x205f, 0x2070, 0x3000, 0x3163, 0x65e5, 0xfe10, 0xfffc, 0xfffd, 0x1f600,
    ];
    for (const cp of yes) expect(escaped(cp), cp.toString(16)).toBe(true);
    for (const cp of no) expect(escaped(cp), cp.toString(16)).toBe(false);
  });

  it('keeps tab and newline, and escapes carriage return', () => {
    expect(visible('a\tb\nc')).toBe('a\tb\nc');
    expect(visible('shown\rhidden')).toBe('shown\\u000dhidden');
  });

  it('over every code point: each one Unicode marks hidden comes back as plain ASCII', () => {
    const hidden = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u;
    let checked = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const char = String.fromCodePoint(cp);
      if (char === '\t' || char === '\n' || !hidden.test(char)) continue;
      const out = visible(char);
      if (!/^(\\u[0-9a-f]{4}){1,2}$/.test(out)) throw new Error(`U+${cp.toString(16)} came back as ${out}`);
      expect(JSON.parse(`"${out}"`)).toBe(char);
      checked++;
    }
    expect(checked).toBeGreaterThan(900_000);
  });

  it('escapes a lone surrogate, as in a plain-text error', () => {
    expect(visible('a\ud800b')).toBe('a\\ud800b');
    expect(visible('a\udc00')).toBe('a\\udc00');
    // A pair is one character, escaped only if it is one of the set.
    expect(visible('😀')).toBe('😀');
  });

  it('leaves ordinary text from many scripts unchanged', () => {
    for (const text of ['café', '日本語', 'שלום', 'مرحبا', 'Привет', 'naïve—“quoted”', '😀🎉', '½ ° € ™']) {
      expect(visible(text)).toBe(text);
    }
  });

  it('leaves a literal backslash-u text alone: JSON already wrote its backslash doubled', () => {
    const json = JSON.stringify({ note: '\\u202e is how it looks' });
    expect(visible(json)).toBe(json);
    expect(JSON.parse(visible(json))).toEqual({ note: '\\u202e is how it looks' });
  });

  it('is lossless for JSON: random values parse back the same, with nothing hidden left', () => {
    const next = rng(20261127);
    const alphabet = [
      'a',
      'Z',
      '0',
      ' ',
      '\\',
      '"',
      '/',
      '\\u202e',
      '\t',
      '\n',
      '\r',
      '\0',
      DEL,
      NEL,
      TAG_A,
      LS,
      '\u2029',
      RLO,
      ZWSP,
      ZWJ,
      VS16,
      VS_SUP,
      BOM,
      '\ud800',
      '\udc00',
      '😀',
      'é',
      '\u{E01F0}',
      '\uf8ff',
      '\u00a0',
    ];
    const str = (): string =>
      Array.from(
        { length: Math.floor(next() * 12) },
        () => alphabet[Math.floor(next() * alphabet.length)],
      ).join('');
    const value = (depth: number): unknown => {
      const r = next();
      if (depth > 3 || r < 0.35) return str();
      if (r < 0.45) return Math.floor(next() * 1e6) / 7;
      if (r < 0.5) return next() < 0.5;
      if (r < 0.55) return null;
      if (r < 0.75) return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1));
      return Object.fromEntries(
        Array.from({ length: Math.floor(next() * 4) }, () => [str(), value(depth + 1)]),
      );
    };
    for (let i = 0; i < 3_000; i++) {
      const v = value(0);
      const json = JSON.stringify(v);
      const out = visible(json);
      expect(RAW.test(out), json).toBe(false);
      expect(JSON.parse(out)).toEqual(JSON.parse(json));
      expect(visible(out)).toBe(out);
    }
  });

  it('is quick on a megabyte of zero-width spaces', () => {
    const text = ZWSP.repeat(1_000_000);
    const started = performance.now();
    const out = visible(text);
    expect(out.length).toBe(6_000_000);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('leaves the banners and notes as they are', () => {
    for (const text of [UNTRUSTED, RULES_BANNER, FULL_NOTE, `${UNTRUSTED} ${FULL_NOTE}`]) {
      expect(visible(text)).toBe(text);
    }
  });
});

describe('shown()', () => {
  it('escapes every text item and keeps the rest of the result', () => {
    const result = shown({
      content: [
        { type: 'text', text: `a${RLO}` },
        { type: 'text', text: `b${LS}` },
      ],
      isError: true,
    });
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'a\\u202e' },
        { type: 'text', text: 'b\\u2028' },
      ],
      isError: true,
    });
  });

  it('refuses structured content or an item that isn’t text, which a client would decode', () => {
    expect(() => shown({ content: [], structuredContent: { a: RLO } })).toThrow();
    expect(() => shown({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] })).toThrow();
  });
});

describe('guarded()', () => {
  const fixed = { content: [{ type: 'text', text: 'Something went wrong.' }], isError: true };
  const quiet = <T>(run: () => Promise<T>): Promise<T> => {
    const error = console.error;
    console.error = () => undefined;
    return run().finally(() => (console.error = error));
  };

  it('shows what the handler returns', async () => {
    const tool = guarded('t', async () => ({ content: [{ type: 'text' as const, text: RLO }] }));
    expect(await tool({}, {})).toEqual({ content: [{ type: 'text', text: '\\u202e' }] });
  });

  it('gives the fixed message for a throw, structured content or an item that isn’t text', async () => {
    const results = await quiet(() =>
      Promise.all([
        guarded('t', async () => {
          throw new Error(`raw ${RLO}`);
        })({}, {}),
        guarded('t', async () => ({ content: [], structuredContent: { a: RLO } }))({}, {}),
        guarded('t', async () => ({
          content: [{ type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }],
        }))({}, {}),
      ]),
    );
    for (const result of results) expect(result).toEqual(fixed);
  });

  it('logs the kind of error and the tool, never the message', async () => {
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.join(' '));
    try {
      await guarded('my_tool', async () => {
        throw new TypeError(`secret ${RLO}`);
      })({}, {});
    } finally {
      console.error = error;
    }
    expect(lines).toEqual(['[wirescry] MCP tool my_tool failed: TypeError']);
  });

  it('gives a new result each time, so one changed can’t change the next', async () => {
    const fail = guarded('t', async () => {
      throw new Error('x');
    });
    const [a, b] = await quiet(() => Promise.all([fail({}, {}), fail({}, {})]));
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('plugin tool metadata', () => {
  const tool = (extra: Partial<McpReadTool>): McpReadTool => ({
    name: 'tidy',
    title: 'Tidy',
    description: 'Tidies.',
    inputSchema: { type: 'object' },
    read: async () => ({}),
    ...extra,
  });
  const one = (extra: Partial<McpReadTool>) => validateTools('p', [tool(extra)], new Set())[0]!;

  it('drops characters that carry text unseen from a title and description', () => {
    expect(one({ title: `Safe${HIDDEN}` }).title).toBe('Safe');
    expect(one({ description: `Reads${VS_SUP}${VS16}\u{E0FFF}.` }).description).toBe('Reads.');
    // Halves of a tag character with a carrier between: joined once it's dropped, and still not
    // shown.
    expect(one({ title: `X\udb40${VS16}\udc41Y` }).title).toBe('X Y');
  });

  it('makes any other hidden character a space', () => {
    expect(one({ title: `a${ZWJ}b${'\u00ad'}c${'\u034f'}d` }).title).toBe('a b c d');
    expect(one({ title: 'one\ntwo\tthree' }).title).toBe('one two three');
    expect(one({ description: `one\rtwo${'\u3164'}three${'\uf8ff'}.` }).description).toBe('one two three .');
  });

  it('keeps ordinary text, with its curly quotes and accents', () => {
    expect(one({ title: 'Café’s “rules”' }).title).toBe('Café’s “rules”');
  });

  it('refuses a schema holding a hidden character, and takes one that doesn’t', () => {
    for (const char of [ZWJ, '\u00ad', VS_SUP, '\u3164', '\uf8ff', TAG_A, RLO]) {
      expect(() => one({ inputSchema: { type: 'object', description: `x${char}` } })).toThrow(/hidden/);
    }
    // Controls and lone surrogates, which JSON writes as escapes a client decodes.
    for (const text of ['a\rb', '\u001b[2K', '\b\b', '\u0000', '\ud800', `x${NEL}`]) {
      expect(() => one({ inputSchema: { type: 'object', description: text } }), JSON.stringify(text)).toThrow(
        /hidden/,
      );
    }
    // In a key, and deep inside.
    expect(() =>
      one({ inputSchema: { type: 'object', properties: { [`q${RLO}`]: { type: 'string' } } } }),
    ).toThrow(/hidden/);
    expect(() =>
      one({
        inputSchema: { type: 'object', properties: { q: { type: 'string', enum: ['a', `b${ZWSP}`] } } },
      }),
    ).toThrow(/hidden/);
    // Tab and newline are fine, as JSON writes them.
    expect(one({ inputSchema: { type: 'object', description: 'one\ntwo\tthree' } }).inputSchema).toEqual({
      type: 'object',
      description: 'one\ntwo\tthree',
    });
    expect(one({ inputSchema: { type: 'object', description: 'Café “q”' } }).inputSchema).toEqual({
      type: 'object',
      description: 'Café “q”',
    });
  });
});

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

interface RpcResult {
  error?: { message: string };
  tools?: Array<{ name: string; title?: string; description?: string }>;
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
  instructions?: string;
}

let nextId = 1;
/** A JSON-RPC request as a 2026-07-28 client: the raw answer and its result. */
async function rpc(
  url: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
  name?: string,
): Promise<{ raw: string; result: RpcResult }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(name ? { 'mcp-name': name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: { ...params, _meta: META } }),
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  const json = JSON.parse(raw) as { result?: RpcResult; error?: { message: string } };
  return { raw, result: json.error ? { error: json.error } : json.result! };
}

/** The text an agent gets from a tool, checked for hidden characters, both raw and as sent. */
async function callTool(
  url: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  const { raw, result } = await rpc(url, token, 'tools/call', { name, arguments: args }, name);
  expect(result.error, name).toBeUndefined();
  const text = result.content!.map((c) => c.text).join('\n');
  expect(RAW.test(text), `${name}: ${text.slice(0, 200)}`).toBe(false);
  // The envelope can't carry one either: the escapes are in the text, so the JSON-RPC layer
  // writes their backslashes doubled rather than decoding them.
  expect(RAW.test(raw)).toBe(false);
  return { text, isError: result.isError };
}

/** The JSON after a result's banner line. */
function after(text: string, banner: string): unknown {
  expect(text.startsWith(`${banner}\n`)).toBe(true);
  return JSON.parse(text.slice(banner.length + 1));
}

describe('every exit of the server, with a stand-in reader', () => {
  const servers: McpHttpServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop();
  });

  const summary = {
    id: 'a',
    method: 'GET',
    protocol: 'https',
    httpVersion: '1.1',
    host: 'h.test',
    path: `/x${RLO}`,
    url: `https://h.test/x${RLO}`,
    startedAt: 0,
    statusCode: 200,
    statusMessage: NASTY,
  };
  const backend: ReaderBackend = {
    summaries: () => [summary as never],
    detail: () => undefined,
    maskFields: async (fields) => ({ fields: fields.map((f) => f.value), full: false }),
    part: () => ({}),
    body: async () => null,
    wsPage: () => ({ messages: [], dropped: 0, total: 0 }),
    maskMessages: async (_d, page) => page,
    sseRead: async () => null,
    maskEvents: async (_d, view) => view,
    generation: () => 1,
  };

  async function start(options: {
    onCall?: () => void;
    plugins?: ConstructorParameters<typeof McpHttpServer>[0]['plugins'];
  }): Promise<string> {
    const server = new McpHttpServer({
      reader: new Reader(backend),
      log: () => undefined,
      onCall: options.onCall ?? (() => undefined),
      plugins: options.plugins,
    });
    servers.push(server);
    await server.start(0, TOKEN);
    return `http://127.0.0.1:${server.listening}/mcp`;
  }

  it('escapes captured text in a list, and the parsed JSON holds it exactly', async () => {
    const url = await start({});
    const { text } = await callTool(url, TOKEN, 'list_exchanges', {});
    expect(text).toContain('\\udb40\\udc41\\u2028\\u202e\\u200b');
    const all = strings(after(text, UNTRUSTED));
    expect(all).toContain(NASTY);
    expect(all).toContain(`https://h.test/x${RLO}`);
  });

  it('without the escape, the same list would carry them raw (the check can see a miss)', () => {
    expect(RAW.test(JSON.stringify({ statusMessage: NASTY }))).toBe(true);
  });

  it('turns a failure the tool didn’t expect into a fixed message, not the SDK’s raw text', async () => {
    const url = await start({
      onCall: () => {
        throw new Error(`log failed ${RLO}${TAG_A}`);
      },
    });
    const { text, isError } = await callTool(url, TOKEN, 'list_exchanges', {});
    expect(isError).toBe(true);
    expect(text).toBe('Something went wrong.');
  });

  it('escapes a plugin tool’s result, its thrown error, and Wirescry’s own error about its result', async () => {
    const plugins = {
      list: () => [
        {
          plugin: 'p',
          name: 'echo_tool',
          title: 'Echo',
          description: 'Echoes.',
          inputSchema: { type: 'object' },
          contains: 'traffic' as const,
        },
        {
          plugin: 'p',
          name: 'throws_tool',
          title: 'Throws',
          description: 'Throws.',
          inputSchema: { type: 'object' },
          contains: 'rules' as const,
        },
        {
          plugin: 'p',
          name: 'bad_tool',
          title: 'Bad',
          description: 'Bad.',
          inputSchema: { type: 'object' },
          contains: 'traffic' as const,
        },
      ],
      call: async (_plugin: string, name: string) => {
        if (name === 'echo_tool') return { [`key${ZWJ}`]: [NASTY] };
        if (name === 'throws_tool') throw new Error(`nope ${NASTY}`);
        return { when: new Date() };
      },
    };
    const url = await start({ plugins: plugins as never });
    const echoed = await callTool(url, TOKEN, 'echo_tool', {});
    expect(after(echoed.text, UNTRUSTED)).toEqual({ [`key${ZWJ}`]: [NASTY] });
    const thrown = await callTool(url, TOKEN, 'throws_tool', {});
    expect(thrown.isError).toBe(true);
    expect(strings(after(thrown.text, RULES_BANNER)).join(' ')).toContain(NASTY);
    const bad = await callTool(url, TOKEN, 'bad_tool', {});
    expect(bad).toEqual({ text: 'The result isn’t plain JSON.', isError: true });
  });

  it('turns a failure the plugin tool didn’t expect into the fixed message too', async () => {
    const plugins = {
      list: () => [
        {
          plugin: 'p',
          name: 'echo_tool',
          title: 'Echo',
          description: 'Echoes.',
          inputSchema: { type: 'object' },
          contains: 'traffic' as const,
        },
      ],
      call: async () => ({ found: NASTY }),
    };
    const url = await start({
      plugins: plugins as never,
      onCall: () => {
        throw new Error(`log failed ${RLO}`);
      },
    });
    expect(await callTool(url, TOKEN, 'echo_tool', {})).toEqual({
      text: 'Something went wrong.',
      isError: true,
    });
  });

  it('answers arguments that don’t fit without quoting them', async () => {
    const url = await start({});
    const { raw, result } = await rpc(
      url,
      TOKEN,
      'tools/call',
      { name: 'get_exchange', arguments: { id: 7, [`x${RLO}`]: `y${TAG_A}${LS}` } },
      'get_exchange',
    );
    expect(RAW.test(raw)).toBe(false);
    expect(result.error ?? result.isError).toBeTruthy();
  });

  it('escapes a plugin tool’s error about a result too large, counted as sent', async () => {
    // 20,000 zero-width spaces are 120,000 characters escaped: past the 100,000 limit.
    const plugins = {
      list: () => [
        {
          plugin: 'p',
          name: 'big_tool',
          title: 'Big',
          description: 'Big.',
          inputSchema: { type: 'object' },
          contains: 'traffic' as const,
        },
        {
          plugin: 'p',
          name: 'fits_tool',
          title: 'Fits',
          description: 'Fits.',
          inputSchema: { type: 'object' },
          contains: 'traffic' as const,
        },
      ],
      call: async (_plugin: string, name: string) =>
        name === 'big_tool' ? { s: ZWSP.repeat(20_000) } : { s: ZWSP.repeat(16_000) },
    };
    const url = await start({ plugins: plugins as never });
    const big = await callTool(url, TOKEN, 'big_tool', {});
    expect(big.isError).toBe(true);
    expect(big.text).toMatch(/too large/);
    const fits = await callTool(url, TOKEN, 'fits_tool', {});
    expect(fits.isError).toBeFalsy();
    expect(after(fits.text, UNTRUSTED)).toEqual({ s: ZWSP.repeat(16_000) });
  });
});

describe('every tool, end to end with real captured traffic and a plugin', () => {
  let dir: string;
  let backend: RunningBackend;
  let status: McpStatus;
  const ids: Record<string, string> = {};
  // Fake secret, built at run time so the file holds nothing a secret scanner flags.
  const BEARER = 'mK7vQ2xZ' + '9pLw4RtY8nB3';
  const BODY = `{"note":"${NASTY}","bearer":"${BEARER}${ZWSP}"}`;
  const plugin: BackendPlugin = {
    name: 'fake',
    apiVersion: PLUGIN_API_VERSION,
    async start(host) {
      host.mcp?.setTools([
        {
          name: 'hidden_tool',
          title: `Hidden${HIDDEN}${RLO}`,
          description: `Reads${ZWJ}${LS}things.`,
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string', description: 'One\ntwo “q”.' } },
          },
          read: async () => ({ found: NASTY }),
        },
      ]);
    },
    async handle() {
      return null;
    },
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-mcp-visible-'));
    backend = await startBackend({
      dataDir: path.join(dir, 'data'),
      token: TOKEN,
      allowedOrigins: [UI_ORIGIN],
      plugins: [plugin],
      pluginsEnabled: true,
    });
    const api = await apiClient(backend.apiPort);
    const t = Date.parse('2026-11-27T12:00:00.000Z');
    const entry = (url: string, extra: Record<string, unknown>) => ({
      startedDateTime: new Date(t).toISOString(),
      time: 1,
      request: {
        method: 'GET',
        url,
        httpVersion: 'HTTP/1.1',
        headers: [
          { name: 'authorization', value: `Bearer ${BEARER}` },
          { name: `x-note${RLO}`, value: NASTY },
        ],
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: 0,
      },
      cache: {},
      timings: { send: 0, wait: 1, receive: 0 },
      ...extra,
    });
    const file = path.join(dir, 'hidden.har');
    await writeFile(
      file,
      JSON.stringify({
        log: {
          version: '1.2',
          creator: { name: 'test', version: '1' },
          entries: [
            entry(`https://h.test/p${RLO}?q=${encodeURIComponent(NASTY)}`, {
              response: {
                status: 200,
                statusText: NASTY,
                httpVersion: 'HTTP/1.1',
                headers: [{ name: 'content-type', value: 'application/json' }],
                cookies: [],
                content: { size: BODY.length, mimeType: 'application/json', text: BODY },
                redirectURL: '',
                headersSize: -1,
                bodySize: BODY.length,
              },
            }),
            {
              ...entry('wss://h.test/socket', {}),
              _resourceType: 'websocket',
              response: { status: 101, statusText: 'Switching Protocols', headers: [] },
              _webSocketMessages: [{ type: 'receive', time: t / 1000, opcode: 1, data: NASTY }],
            },
            entry('https://h.test/events', {
              response: {
                status: 200,
                statusText: 'OK',
                httpVersion: 'HTTP/1.1',
                headers: [{ name: 'content-type', value: 'text/event-stream' }],
                cookies: [],
                content: { mimeType: 'text/event-stream', text: `data: ${NASTY}\n\n` },
                redirectURL: '',
                headersSize: -1,
                bodySize: -1,
              },
            }),
          ],
        },
      }),
    );
    await backend.importHar(file);
    for (let tries = 0; exchangesIn(api.messages).filter((e) => e.imported).length < 3; tries++) {
      if (tries > 200) throw new Error('The HAR wasn’t imported.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const e of exchangesIn(api.messages)) {
      if (e.url.includes('/socket')) ids.ws = e.id;
      else if (e.url.includes('/events')) ids.events = e.id;
      else ids.json = e.id;
    }
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    status = await api.send<McpStatus>({ command: 'setMcp', enabled: true, port });
    api.close();
  });

  afterAll(async () => {
    await backend?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    callTool(status.url, status.token!, name, args);

  it('list_exchanges: the status message escaped, parsing back to it, and the URL encoded', async () => {
    const { text } = await call('list_exchanges', {});
    const all = strings(after(text, UNTRUSTED));
    expect(all).toContain(NASTY);
    // A URL is kept percent-encoded, so nothing in it is hidden.
    expect(all.some((s) => s.includes(`/p${encodeURIComponent(RLO)}`))).toBe(true);
  });

  it('get_exchange: a header name (a JSON key or field) and value escaped, the secret still masked', async () => {
    const { text } = await call('get_exchange', { id: ids.json });
    expect(text).not.toContain(BEARER);
    const all = strings(after(text, UNTRUSTED));
    expect(all).toContain(`x-note${RLO}`);
    expect(all).toContain(NASTY);
  });

  it('get_body: escaped, the secret beside a zero-width space masked, and paging counts unchanged', async () => {
    const { text } = await call('get_body', { id: ids.json, side: 'response' });
    expect(text).not.toContain(BEARER);
    expect(text).toContain('[redacted]');
    const whole = after(text, UNTRUSTED) as { text: string; totalChars: number; more?: true };
    expect(whole.text).toContain(NASTY);
    expect(whole.totalChars).toBe(whole.text.length);
    expect(whole.more).toBeUndefined();
    // A part: the offsets count the characters as captured, not as escaped.
    const part = await call('get_body', { id: ids.json, side: 'response', offset: 10, maxChars: 5 });
    const parsed = after(part.text, UNTRUSTED) as { text: string; totalChars: number; more?: true };
    expect(parsed).toMatchObject({
      text: whole.text.slice(10, 15),
      totalChars: whole.totalChars,
      more: true,
    });
    // One that starts inside a tag character's pair: its second half alone, escaped.
    const at = whole.text.indexOf(TAG_A) + 1;
    const split = await call('get_body', { id: ids.json, side: 'response', offset: at, maxChars: 3 });
    expect(split.text).toContain('"text":"\\udc41');
    expect((after(split.text, UNTRUSTED) as { text: string }).text).toBe(whole.text.slice(at, at + 3));
  });

  it('get_websocket_messages: a message escaped', async () => {
    const { text } = await call('get_websocket_messages', { id: ids.ws });
    expect(strings(after(text, UNTRUSTED))).toContain(NASTY);
  });

  it('get_sse_events: an event escaped', async () => {
    const { text } = await call('get_sse_events', { id: ids.events });
    expect(strings(after(text, UNTRUSTED)).join('\n')).toContain(NASTY);
  });

  it('an error quoting the agent’s own text is escaped too', async () => {
    const { text, isError } = await call('list_exchanges', { query: `status=x${RLO}${TAG_A}` });
    expect(isError).toBe(true);
    expect(text).toContain('x\\u202e\\udb40\\udc41');
  });

  it('a plugin’s tool: its result escaped, and its listed title and description cleaned', async () => {
    const { text } = await call('hidden_tool', {});
    expect(after(text, UNTRUSTED)).toEqual({ found: NASTY });
    const { raw, result } = await rpc(status.url, status.token!, 'tools/list', {});
    const listed = result.tools!.find((t) => t.name === 'hidden_tool')!;
    expect(listed.title).toBe('Hidden ');
    expect(listed.description).toMatch(/^Reads {2}things\./);
    expect(RAW.test(raw)).toBe(false);
    for (const t of result.tools!) expect(RAW.test(`${t.title}${t.description}`), t.name).toBe(false);
    expect((listed as { inputSchema?: unknown }).inputSchema).toEqual({
      type: 'object',
      properties: { q: { type: 'string', description: 'One\ntwo “q”.' } },
    });
  });
});
