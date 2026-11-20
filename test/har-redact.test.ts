import { describe, expect, it } from 'vitest';
import { harEntry, type HarEntryMeta, type HarExportItem } from '../src/backend/har';
import { collectKnown, knownPart, redactHarEntry, type EntryMeta } from '../src/backend/har-redact';
import type { BodyContent, ExchangeDetail } from '../src/shared/api';
import { KnownValues } from '../src/shared/redact-body';

// Fake tokens, built at run time so the file itself holds nothing a secret scanner flags.
const BEARER = 'mK7vQ2xZ' + '9pLw4RtY8nB3';
const PASSWORD = 'hunter2' + 'Correct9Horse';
const API_KEY = 'ak_' + 'Zx8Wv6Ut4Sr2Qp0';
const OTHER = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const NO_META: EntryMeta = { cut: { request: false, response: false }, base64Frames: [] };

const detail = (overrides: Partial<ExchangeDetail> = {}): ExchangeDetail => ({
  summary: {
    id: 'a',
    method: 'GET',
    protocol: 'https',
    httpVersion: '1.1',
    host: 'example.com',
    path: '/',
    url: 'https://example.com/',
    startedAt: 0,
    status: 200,
  },
  requestHeaders: [],
  responseHeaders: [],
  timing: { startTimestamp: 0 },
  ...overrides,
});

const body = (bytes: string | Buffer, extra: Partial<BodyContent> = {}): BodyContent => {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  return { base64: buffer.toString('base64'), size: buffer.length, truncated: false, ...extra };
};

/** harEntry's entry and meta, then redacted, with a header's bearer token known beforehand. */
function redact(item: HarExportItem, known = new KnownValues()) {
  const meta: HarEntryMeta = { cut: { request: false, response: false }, base64Frames: [] };
  const entry = harEntry(item, meta);
  collectKnown(knownPart(entry), known);
  const result = redactHarEntry(entry, meta, known);
  // Always something JSON can write and read back the same.
  expect(JSON.parse(JSON.stringify(result.entry))).toEqual(result.entry);
  return { ...result, entry: result.entry as Json, input: entry as Json };
}

/** Every string anywhere in a value, with its path. */
function leaves(value: unknown, at = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, `${at}[${i}]`));
  if (typeof value === 'object' && value !== null)
    return Object.entries(value).flatMap(([k, v]) => leaves(v, at ? `${at}.${k}` : k));
  return [];
}

describe('redactHarEntry', () => {
  it('redacts the URL, and rebuilds the query string and redirect from the redacted values', () => {
    const url = `https://example.com/cb?api_key=${API_KEY}&page=2`;
    const { entry, values } = redact({
      detail: detail({
        summary: { ...detail().summary, url, status: 302 },
        responseHeaders: [['location', `https://example.com/next?token=${OTHER}`]],
      }),
      requestBody: null,
      responseBody: null,
    });
    expect(entry.request.url).toBe('https://example.com/cb?api_key=[redacted]&page=2');
    expect(entry.request.queryString).toEqual([
      { name: 'api_key', value: '[redacted]' },
      { name: 'page', value: '2' },
    ]);
    expect(entry.response.redirectURL).toBe('https://example.com/next?token=[redacted]');
    expect(entry.response.headers).toEqual([
      { name: 'location', value: 'https://example.com/next?token=[redacted]' },
    ]);
    expect(values).toBe(2);
    expect(entry._wirescryRedactions).toEqual([
      { in: 'request.url', name: 'api_key', count: 1 },
      { in: 'response.headers', name: 'token', count: 1 },
    ]);
    expect(JSON.stringify(entry)).not.toContain(API_KEY);
    expect(JSON.stringify(entry)).not.toContain(OTHER);
  });

  it('leaves an entry without secrets as it was, with no records', () => {
    const item: HarExportItem = {
      detail: detail({
        summary: { ...detail().summary, url: 'https://example.com/a?page=2' },
        requestHeaders: [
          ['accept', 'application/json'],
          ['content-type', 'application/json'],
        ],
        responseHeaders: [
          ['content-type', 'application/json'],
          ['content-length', '13'],
        ],
        requestBody: { size: 9, stored: 9 },
        responseBody: { size: 13, stored: 13 },
      }),
      requestBody: body('{"page":2}'),
      responseBody: body('{"items":[1]}'),
    };
    const { entry, input, values, notScanned, leftOut } = redact(item);
    expect([values, notScanned, leftOut]).toEqual([0, 0, 0]);
    expect(entry._wirescryRedactions).toBeUndefined();
    expect(entry).toEqual(input);
  });

  it('redacts headers and trailers on both sides, by name', () => {
    const { entry, values } = redact({
      detail: detail({
        requestHeaders: [
          ['authorization', `Bearer ${BEARER}`],
          ['cookie', `session=${OTHER}; theme=dark`],
          ['x-request-id', 'abc'],
        ],
        responseHeaders: [['set-cookie', `sid=${OTHER}; Path=/; HttpOnly`]],
        requestTrailers: [['x-api-key', API_KEY]],
        responseTrailers: [['grpc-status', '0']],
      }),
      requestBody: null,
      responseBody: null,
    });
    expect(entry.request.headers).toEqual([
      { name: 'authorization', value: 'Bearer [redacted]' },
      // Every cookie's value: their names don't say which are secret.
      { name: 'cookie', value: 'session=[redacted]; theme=[redacted]' },
      { name: 'x-request-id', value: 'abc' },
    ]);
    expect(entry.request._trailers).toEqual([{ name: 'x-api-key', value: '[redacted]' }]);
    expect(entry.response._trailers).toEqual([{ name: 'grpc-status', value: '0' }]);
    expect(entry.response.headers[0].value).toMatch(/^sid=\[redacted\]; Path=\/; HttpOnly$/);
    expect(values).toBe(5);
    const text = JSON.stringify(entry);
    for (const secret of [BEARER, OTHER, API_KEY]) expect(text).not.toContain(secret);
  });

  it('redacts a form body, its params rebuilt from the redacted text, and takes the type from the redacted header', () => {
    const form = `user=ada&password=${PASSWORD}&remember=1`;
    const { entry, values } = redact({
      detail: detail({
        summary: { ...detail().summary, method: 'POST' },
        requestHeaders: [['content-type', 'application/x-www-form-urlencoded']],
        requestBody: { size: form.length, stored: form.length },
      }),
      requestBody: body(form),
      responseBody: null,
    });
    expect(entry.request.postData).toEqual({
      mimeType: 'application/x-www-form-urlencoded',
      text: 'user=ada&password=[redacted]&remember=1',
      params: [
        { name: 'user', value: 'ada' },
        { name: 'password', value: '[redacted]' },
        { name: 'remember', value: '1' },
      ],
    });
    expect(values).toBe(1);
    // The sizes stay as captured.
    expect(entry.request.bodySize).toBe(form.length);
  });

  it('finds a value from a header in a body, by value alone', () => {
    const page = `<p>Your token is ${BEARER}</p>`;
    const { entry } = redact({
      detail: detail({
        requestHeaders: [['authorization', `Bearer ${BEARER}`]],
        responseHeaders: [['content-type', 'text/html']],
        responseBody: { size: page.length, stored: page.length },
      }),
      requestBody: null,
      responseBody: body(page),
    });
    expect(entry.response.content.text).toBe('<p>Your token is [redacted]</p>');
    expect(entry.response.content.size).toBe(page.length);
    expect(entry._wirescryRedactions).toContainEqual(expect.objectContaining({ in: 'response.content' }));
  });

  it('redacts a JSON body, and records where and what, never the value', () => {
    const json = JSON.stringify({ access_token: OTHER, refresh_token: API_KEY, user: 'ada' });
    const { entry, values } = redact({
      detail: detail({
        responseHeaders: [['content-type', 'application/json']],
        responseBody: { size: json.length, stored: json.length },
      }),
      requestBody: null,
      responseBody: body(json),
    });
    expect(JSON.parse(entry.response.content.text)).toEqual({
      access_token: '[redacted]',
      refresh_token: '[redacted]',
      user: 'ada',
    });
    expect(values).toBe(2);
    const records = entry._wirescryRedactions as Json[];
    expect(records.every((r) => r.in === 'response.content')).toBe(true);
    expect(JSON.stringify(records)).not.toContain(OTHER);
  });

  it('redacts a body cut short, to its end under a secret name', () => {
    const json = `{"user":"ada","password":"${PASSWORD}`;
    const { entry } = redact({
      detail: detail({
        responseHeaders: [['content-type', 'application/json']],
        responseBody: { size: 1000, stored: json.length },
      }),
      requestBody: null,
      responseBody: body(json, { size: 1000, truncated: true }),
    });
    expect(entry.response.content.text).toBe('{"user":"ada","password":"[redacted]');
    expect(entry.comment).toMatch(/only part of the response body/);
  });

  it('a cut body read as whole would keep its secret: the cut flag is what finds it', () => {
    const json = `{"user":"ada","password":"${PASSWORD}`;
    const item: HarExportItem = {
      detail: detail({
        responseHeaders: [['content-type', 'application/json']],
        responseBody: { size: 1000, stored: json.length },
      }),
      requestBody: null,
      responseBody: body(json, { size: 1000, truncated: true }),
    };
    const entry = harEntry(item);
    // Read as a whole body, it isn't JSON, and the unclosed value isn't found: so harEntry's
    // meta must say it was cut.
    const notCut = redactHarEntry(entry, NO_META, new KnownValues()).entry as Json;
    expect(JSON.stringify(notCut)).toContain(PASSWORD);
  });

  describe('bodies written as base64', () => {
    it('redacts a text body that isn’t UTF-8, byte for byte (Latin-1)', () => {
      // "café" in Latin-1, which isn't valid UTF-8, so harEntry writes base64.
      const bytes = Buffer.concat([
        Buffer.from('{"name":"caf'),
        Buffer.from([0xe9]),
        Buffer.from(`","token":"${OTHER}"}`),
      ]);
      const { entry, values } = redact({
        detail: detail({
          responseHeaders: [['content-type', 'application/json; charset=iso-8859-1']],
          responseBody: { size: bytes.length, stored: bytes.length },
        }),
        requestBody: null,
        responseBody: body(bytes),
      });
      expect(entry.response.content.encoding).toBe('base64');
      const out = Buffer.from(entry.response.content.text, 'base64');
      expect(out.toString('latin1')).toBe('{"name":"café","token":"[redacted]"}');
      expect(values).toBe(1);
    });

    it('redacts UTF-16 text, by its BOM, its charset, or its NULs, and writes it back the same way', () => {
      const text = `{"token":"${OTHER}"}`;
      const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
      const be = Buffer.from(text, 'utf16le').swap16();
      const noBom = Buffer.from(text, 'utf16le');
      const cases: Array<[Buffer, string, string]> = [
        [le, 'application/json', 'utf16le'],
        [be, 'application/json; charset=utf-16be', 'utf16be'],
        [noBom, 'text/plain', 'utf16le'],
      ];
      for (const [bytes, type, order] of cases) {
        const { entry } = redact({
          detail: detail({
            responseHeaders: [['content-type', type]],
            responseBody: { size: bytes.length, stored: bytes.length },
          }),
          requestBody: null,
          responseBody: body(bytes),
        });
        const out = Buffer.from(entry.response.content.text, 'base64');
        const decoded = (order === 'utf16be' ? Buffer.from(out).swap16() : out).toString('utf16le');
        expect(decoded.replace(/^\uFEFF/, ''), type).toBe('{"token":"[redacted]"}');
        // The BOM stays where it was.
        expect(out[0] === 0xff && out[1] === 0xfe, type).toBe(order === 'utf16le' && bytes === le);
      }
    });

    it('doesn’t check a body that isn’t text, and leaves it out when it holds a value found elsewhere', () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]);
      const clean = redact({
        detail: detail({
          responseHeaders: [['content-type', 'image/png']],
          responseBody: { size: png.length, stored: png.length },
        }),
        requestBody: null,
        responseBody: body(png),
      });
      expect(Buffer.from(clean.entry.response.content.text, 'base64').equals(png)).toBe(true);
      expect([clean.notScanned, clean.leftOut]).toEqual([1, 0]);
      expect(clean.entry._wirescryRedactions).toEqual([
        { in: 'response.content', notScanned: 'binary', count: 1 },
      ]);

      const holding = Buffer.concat([png, Buffer.from(BEARER), png]);
      const leaked = redact({
        detail: detail({
          requestHeaders: [['authorization', `Bearer ${BEARER}`]],
          responseHeaders: [['content-type', 'application/octet-stream']],
          responseBody: { size: holding.length, stored: holding.length },
        }),
        requestBody: null,
        responseBody: body(holding),
      });
      expect(leaked.entry.response.content.text).toBeUndefined();
      expect(leaked.entry.response.content.size).toBe(holding.length);
      expect(leaked.leftOut).toBe(1);
      expect(leaked.entry.comment).toMatch(/response body was left out: it couldn't be redacted/);
    });

    it('doesn’t take odd-length UTF-16 for text', () => {
      const bytes = Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42]);
      const { entry, notScanned } = redact({
        detail: detail({
          responseHeaders: [['content-type', 'text/plain']],
          responseBody: { size: bytes.length, stored: bytes.length },
        }),
        requestBody: null,
        responseBody: body(bytes),
      });
      expect(notScanned).toBe(1);
      expect(Buffer.from(entry.response.content.text, 'base64').equals(bytes)).toBe(true);
    });

    it('doesn’t check a body still encoded, and leaves it out when it holds a value found elsewhere', () => {
      const raw = Buffer.from('not really gzip');
      const still = redact({
        detail: detail({
          responseHeaders: [
            ['content-type', 'application/json'],
            ['content-encoding', 'gzip'],
          ],
          responseBody: { size: raw.length, stored: raw.length },
        }),
        requestBody: null,
        responseBody: body(raw, { encoding: 'gzip', decodeError: 'bad gzip' }),
      });
      expect(still.entry._wirescryRedactions).toEqual([
        { in: 'response.content', notScanned: 'still encoded', count: 1 },
      ]);
      expect(still.entry._wirescryUndecoded).toEqual(['response body']);
      expect([still.notScanned, still.leftOut]).toEqual([1, 0]);

      const holding = Buffer.from(`xx${BEARER}xx`);
      const leaked = redact({
        detail: detail({
          requestHeaders: [['authorization', `Bearer ${BEARER}`]],
          responseHeaders: [['content-encoding', 'br']],
          responseBody: { size: holding.length, stored: holding.length },
        }),
        requestBody: null,
        responseBody: body(holding, { encoding: 'br', decodeError: 'bad br' }),
      });
      expect(JSON.stringify(leaked.entry)).not.toContain(BEARER);
      expect(leaked.leftOut).toBe(1);
    });
  });

  describe('WebSocket messages', () => {
    const socket = (
      messages: Array<{ data: Buffer; isBinary: boolean; fromClient?: boolean }>,
      known = new KnownValues(),
    ) =>
      redact(
        {
          detail: detail({
            summary: { ...detail().summary, websocket: true, status: 101 },
            requestHeaders: [['authorization', `Bearer ${BEARER}`]],
          }),
          requestBody: null,
          responseBody: null,
          messages: {
            messages: messages.map((m, index) => ({
              index,
              fromClient: m.fromClient ?? true,
              isBinary: m.isBinary,
              time: index,
              size: m.data.length,
              base64: m.data.toString('base64'),
            })),
            dropped: 0,
            total: messages.length,
          },
        },
        known,
      );

    it('redacts text messages, including ones written as base64, and leaves binary ones unchecked', () => {
      const { entry, notScanned, leftOut } = socket([
        { data: Buffer.from(JSON.stringify({ type: 'auth', token: OTHER })), isBinary: false },
        // Not valid UTF-8: written as base64.
        { data: Buffer.concat([Buffer.from(`password=${PASSWORD} `), Buffer.from([0xff])]), isBinary: false },
        { data: Buffer.from([1, 2, 3]), isBinary: true, fromClient: false },
        { data: Buffer.from(`echo ${BEARER}`), isBinary: false, fromClient: false },
      ]);
      const [first, second, third, fourth] = entry._webSocketMessages as Json[];
      expect(JSON.parse(first!.data)).toEqual({ type: 'auth', token: '[redacted]' });
      expect(first).toMatchObject({ type: 'send', opcode: 1, time: 0 });
      expect(Buffer.from(second!.data, 'base64').toString('latin1')).toBe('password=[redacted] \xff');
      expect(third).toMatchObject({
        type: 'receive',
        opcode: 2,
        data: Buffer.from([1, 2, 3]).toString('base64'),
      });
      expect(fourth!.data).toBe('echo [redacted]');
      expect([notScanned, leftOut]).toEqual([1, 0]);
      expect(entry._resourceType).toBe('websocket');
      expect(entry._wirescryRedactions).toContainEqual({
        in: 'webSocketMessages',
        notScanned: 'binary',
        count: 1,
      });
    });

    it('redacts a message cut short, to its end under a secret name', () => {
      const cut = Buffer.from(`{"type":"auth","password":"${PASSWORD}`);
      const { entry } = socket([{ data: cut, isBinary: false }]);
      expect((entry._webSocketMessages as Json[])[0]!.data).toBe('{"type":"auth","password":"[redacted]');
    });

    it('empties a binary message holding a value found elsewhere, and says so', () => {
      const { entry, leftOut } = socket([{ data: Buffer.from(`\x00${BEARER}\x00`), isBinary: true }]);
      expect((entry._webSocketMessages as Json[])[0]!.data).toBe('');
      expect(leftOut).toBe(1);
      expect(entry.comment).toMatch(/1 WebSocket message was left out: it couldn't be redacted/);
      const two = socket([
        { data: Buffer.from(`\x00${BEARER}`), isBinary: true },
        { data: Buffer.from(`${BEARER}\x00`), isBinary: true },
      ]);
      expect(two.entry.comment).toMatch(/2 WebSocket messages were left out: they couldn't be redacted/);
    });
  });

  it('sweeps Wirescry’s own messages, the status text and the rule’s name', () => {
    const url = `https://example.com/x?token=${OTHER}`;
    const { entry } = redact({
      detail: detail({
        summary: {
          ...detail().summary,
          url,
          status: undefined,
          statusMessage: `Bad token ${OTHER}`,
          handledBy: { kind: 'rule', label: `Mock with api_key=${API_KEY}` } as never,
          failure: {
            kind: 'upstream',
            code: `E ${OTHER}`,
            message: `Couldn't reach ${url}`,
            detail: `Request to ${url} failed`,
          } as never,
        },
        requestHeaders: [['authorization', `Bearer ${OTHER}`]],
      }),
      requestBody: null,
      responseBody: null,
      notes: [`Something about ${OTHER}.`],
    });
    const text = JSON.stringify(entry);
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain(API_KEY);
    expect(entry._error).toBe("Couldn't reach https://example.com/x?token=[redacted]");
    expect(entry._wirescryFailure.kind).toBe('upstream');
    expect(entry._wirescryRule).toMatch(/api_key=\[redacted\]/);
  });

  it('keeps the device a request came from', () => {
    const source = { kind: 'android' as const, id: 'serial-123', label: 'Pixel 8' };
    const { entry } = redact({
      detail: detail({ summary: { ...detail().summary, source } }),
      requestBody: null,
      responseBody: null,
    });
    expect(entry._wirescrySource).toEqual(source);
  });

  it('leaves out a body it can’t redact, and its params, with a note; the rest of the entry stays', () => {
    const entry = harEntry({
      detail: detail({
        requestHeaders: [['content-type', 'application/x-www-form-urlencoded']],
        requestBody: { size: 20, stored: 20 },
        responseHeaders: [['content-type', 'text/plain']],
        responseBody: { size: 2, stored: 2 },
      }),
      requestBody: body(`password=${PASSWORD}`),
      responseBody: body('ok'),
    }) as Json;
    for (const holder of [entry.request.postData, entry.response.content]) {
      Object.defineProperty(holder, 'text', {
        get() {
          throw new Error('unreadable');
        },
        enumerable: true,
      });
    }
    const result = redactHarEntry(entry, NO_META, new KnownValues());
    const out = result.entry as Json;
    expect(out.request.postData).toEqual({ mimeType: 'application/x-www-form-urlencoded', text: '' });
    expect(out.response.content.text).toBeUndefined();
    expect(result.leftOut).toBe(2);
    expect(out.comment).toMatch(/request body was left out.*response body was left out/);
    expect(out.response.status).toBe(200);
  });

  it('throws when the URL or headers can’t be redacted, so the entry isn’t written', () => {
    const entry = harEntry({ detail: detail(), requestBody: null, responseBody: null }) as Json;
    Object.defineProperty(entry.request, 'headers', {
      get() {
        throw new Error('unreadable');
      },
    });
    expect(() => redactHarEntry(entry, NO_META, new KnownValues())).toThrow('unreadable');
  });

  it('doesn’t change the entry it’s given', () => {
    const item: HarExportItem = {
      detail: detail({ requestHeaders: [['authorization', `Bearer ${BEARER}`]] }),
      requestBody: null,
      responseBody: null,
    };
    const entry = harEntry(item);
    const before = JSON.stringify(entry);
    redactHarEntry(entry, NO_META, new KnownValues());
    expect(JSON.stringify(entry)).toBe(before);
  });

  it('writes only the fields it knows: a value planted everywhere survives only where kept on purpose', () => {
    const MARK = 'zqMARK7' + 'vX2pL9wR4';
    const url = `https://example.com/p?token=${MARK}`;
    const json = JSON.stringify({ password: MARK });
    const item: HarExportItem = {
      detail: detail({
        summary: {
          ...detail().summary,
          method: 'POST',
          url,
          websocket: true,
          statusMessage: `x ${MARK}`,
          handledBy: { kind: 'rule', label: `rule ${MARK}` } as never,
          source: { kind: 'android', id: `id-${MARK}`, label: `label-${MARK}` },
          failure: {
            kind: 'upstream',
            code: `c ${MARK}`,
            message: `m ${MARK}`,
            detail: `d ${MARK}`,
            partial: true,
          } as never,
        },
        requestHeaders: [
          ['authorization', `Bearer ${MARK}`],
          ['content-type', 'application/json'],
        ],
        responseHeaders: [
          ['content-type', 'application/json'],
          ['location', url],
          ['set-cookie', `sid=${MARK}`],
        ],
        requestTrailers: [['x-api-key', MARK]],
        responseTrailers: [['x-auth-token', MARK]],
        requestBody: { size: json.length, stored: json.length, incomplete: true },
        responseBody: { size: json.length, stored: json.length },
      }),
      requestBody: body(json),
      responseBody: body(json),
      messages: {
        messages: [
          {
            index: 0,
            fromClient: true,
            isBinary: false,
            time: 0,
            size: 30,
            base64: Buffer.from(json).toString('base64'),
          },
          { index: 1, fromClient: false, isBinary: true, time: 1, size: 3, base64: 'AQID' },
        ],
        dropped: 2,
        total: 4,
      },
      notes: [`note ${MARK}`],
    };
    const meta: HarEntryMeta = { cut: { request: false, response: false }, base64Frames: [] };
    const entry = harEntry(item, meta) as Json;
    // A field a later harEntry might add, at every level: not known here, so never written.
    const plant = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(plant);
      else if (typeof node === 'object' && node !== null) {
        for (const value of Object.values(node)) plant(value);
        (node as Json)._later = `later ${MARK}`;
      }
    };
    plant(entry);
    const known = new KnownValues();
    collectKnown(knownPart(entry), known);
    const out = redactHarEntry(entry, meta, known).entry;
    const kept = new Set(['_wirescrySource.id', '_wirescrySource.label']);
    const survivors = leaves(out)
      .filter(([, value]) => value.includes(MARK))
      .map(([at]) => at);
    expect(survivors.sort()).toEqual([...kept].sort());
    expect(JSON.stringify(out)).not.toContain('_later');
    // And everything harEntry wrote is still there.
    expect(Object.keys(out).sort()).toEqual(
      Object.keys(entry)
        .filter((k) => k !== '_later')
        .concat('_wirescryRedactions')
        .sort(),
    );
  });
});
