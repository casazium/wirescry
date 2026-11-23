/**
 * A plugin MCP tool's result made safe for an agent (src/backend/mcp/plugin-result.ts): every
 * string and key collected for the mask worker, marked values masked by their kind, and the result
 * rebuilt as plain JSON. Masking here is the worker's own maskFields, run in-process.
 */
import { describe, expect, it } from 'vitest';
import { maskFields } from '../src/backend/mask-body';
import {
  collectResult,
  MAX_DEPTH,
  MAX_NODES,
  MAX_STRING_CHARS,
  ResultError,
} from '../src/backend/mcp/plugin-result';
import { KnownValues } from '../src/shared/redact-body';

// Fake secrets, built at run time so the file itself holds nothing a secret scanner flags.
const KEY = 'Zx8Wv6Ut' + '4Sr2Qp0nLm';
const PASSWORD = 'hunter2' + 'Correct9Horse';
const KNOWN = 'kv_' + 'Tq5Rw3Ep1Yz7';

/** The result as an agent would get it, with `known` as the session's known values. */
function masked(result: unknown, known: string[] = []): unknown {
  const values = new KnownValues();
  for (const value of known) values.add(value);
  const { fields, build } = collectResult(result);
  return build(maskFields(fields, values));
}

describe('a plugin tool’s result, masked', () => {
  it('keeps numbers, booleans, null and structure; strings with nothing secret stay as they are', () => {
    const result = { count: 3, ok: true, none: null, list: [1, 'two', { three: 3 }], name: 'orders' };
    expect(masked(result)).toEqual(result);
  });

  it('masks a header value by its name, which plain text of the same value doesn’t', () => {
    const header = { wirescryMask: 'header', name: 'x-api-key', value: KEY };
    expect(masked({ h: header })).toEqual({ h: { name: 'x-api-key', value: '[redacted]' } });
    // The same value as plain text has nothing to say it's a key: why marking matters.
    expect(masked({ h: KEY })).toEqual({ h: KEY });
  });

  it('masks a body by its type: a JSON password field', () => {
    const body = {
      wirescryMask: 'body',
      contentType: 'application/json',
      text: JSON.stringify({ password: PASSWORD, n: 1 }),
    };
    const out = masked({ body }) as { body: string };
    expect(out.body).not.toContain(PASSWORD);
    expect(JSON.parse(out.body)).toEqual({ password: '[redacted]', n: 1 });
  });

  it('reads a body of a type its rules can’t read as plain text instead', () => {
    const body = {
      wirescryMask: 'body',
      contentType: 'application/grpc+proto',
      text: `password=${PASSWORD}`,
    };
    expect(JSON.stringify(masked({ body }))).not.toContain(PASSWORD);
  });

  it('masks a URL’s secret query value', () => {
    const url = { wirescryMask: 'url', value: `https://api.example.com/x?api_key=${KEY}&page=2` };
    const out = masked({ url }) as { url: string };
    expect(out.url).not.toContain(KEY);
    expect(out.url).toContain('page=2');
  });

  it('hides a known value wherever it turns up: plain strings, marked text, keys', () => {
    const result = {
      note: `seen ${KNOWN} here`,
      text: { wirescryMask: 'text', value: KNOWN },
      [KNOWN]: 'as a key',
      list: [`again ${KNOWN}`],
    };
    const text = JSON.stringify(masked(result, [KNOWN]));
    expect(text).not.toContain(KNOWN);
    expect(text).toContain('as a key');
  });

  it('keeps two keys apart when they mask alike', () => {
    const other = 'kv_' + 'Ab9Cd8Ef7Gh6';
    const out = masked({ [KNOWN]: 1, [other]: 2 }, [KNOWN, other]) as Record<string, number>;
    expect(Object.values(out).sort()).toEqual([1, 2]);
    expect(Object.keys(out).join(' ')).not.toMatch(new RegExp(`${KNOWN}|${other}`));
  });

  it('refuses a marked value it can’t read, rather than masking it by weaker rules', () => {
    for (const bad of [
      { wirescryMask: 'header', name: 'x-api-key', value: KEY, extra: 'x' },
      { wirescryMask: 'cookie', name: 'sid', value: KEY },
      { wirescryMask: 'toString', value: KEY },
      { wirescryMask: 5, value: KEY },
      { wirescryMask: 'text', value: 5 },
      { wirescryMask: 'header', value: KEY },
      { wirescryMask: 'body', contentType: 5, text: KEY },
      { wirescryMask: 'body', contentType: 'text/plain' },
    ]) {
      expect(() => collectResult({ v: bad }), JSON.stringify(bad)).toThrow('marked value');
    }
  });

  it('takes a marked value with an optional field left undefined, or a body with no type', () => {
    const header = { wirescryMask: 'header', name: 'x-api-key', value: KEY, note: undefined };
    expect(masked({ h: header })).toEqual({ h: { name: 'x-api-key', value: '[redacted]' } });
    const body = { wirescryMask: 'body', contentType: undefined, text: `password=${PASSWORD}` };
    expect(JSON.stringify(masked({ body }))).not.toContain(PASSWORD);
    expect(masked({ b: { wirescryMask: 'body', text: 'plain words' } })).toEqual({ b: 'plain words' });
  });

  it('reads an ordinary field called mask as an ordinary field', () => {
    expect(masked({ update: { mask: 'name,email', value: 'x' } })).toEqual({
      update: { mask: 'name,email', value: 'x' },
    });
  });

  it('keeps what a body’s type found when another part of it couldn’t be read', () => {
    const boundary = 'b0undary';
    const text = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="private_key"; filename="k.txt"',
      'Content-Type: text/plain',
      '',
      'first line',
      KEY,
      `--${boundary}`,
      'Content-Disposition: form-data; name="f"; filename="f.bin"',
      'Content-Type: application/octet-stream',
      '',
      'binary',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const out = masked({
      b: { wirescryMask: 'body', contentType: `multipart/form-data; boundary=${boundary}`, text },
    });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it('hides a value under a key that names a secret, numbers and lists too', () => {
    const result = {
      password: PASSWORD,
      authorization: `Bearer ${KEY}`,
      'x-api-key': KEY,
      cookie: `sid=${KEY}`,
      pin: 12345678,
      passwords: [PASSWORD],
    };
    const out = masked(result) as Record<string, unknown>;
    const text = JSON.stringify(out);
    for (const secret of [PASSWORD, KEY, '12345678']) expect(text).not.toContain(secret);
    expect(out.pin).toBe('[redacted]');
    expect(out.passwords).toEqual(['[redacted]']);
  });

  it('reads a result as the JSON body rules do: the same answer for the same object', () => {
    const asBody = (value: unknown): unknown => {
      const out = masked({
        wirescryMask: 'body',
        contentType: 'application/json',
        text: JSON.stringify(value),
      }) as string;
      return JSON.parse(out);
    };
    for (const value of [
      { session: { id: 'abc123def456ghi7' } },
      { token: { id: 'abc123def456ghi7' } },
      {
        headers: [
          { name: 'authorization', value: `Bearer ${KEY}` },
          { name: 'x-api-key', value: KEY },
        ],
      },
      { headers: [{ name: 'cookie', value: `sid=${KEY}` }] },
      { passwords: [PASSWORD] },
      {
        session: {
          title: 'Monday capture',
          started: 1732300000000,
          exchanges: [{ status: 200, path: '/a' }],
        },
      },
      { auth: { type: 'basic', scheme: 'none', user: 'bob', realm: { title: 'Staff area' } } },
      { token: 12, auth: 3, session: 5 },
      { token: 'Hello' },
      {
        auth: { note: 'Uses the staging identity provider' },
        description: 'Uses the staging identity provider',
      },
    ]) {
      expect(JSON.parse(JSON.stringify(masked(value))), JSON.stringify(value)).toEqual(asBody(value));
    }
  });

  it('hides the secrets in name and value pairs and under a session’s id', () => {
    const text = JSON.stringify(
      masked({
        session: { id: 'abc123def456ghi7' },
        headers: [{ name: 'authorization', value: `Bearer ${KEY}` }],
      }),
    );
    expect(text).not.toContain('abc123def456ghi7');
    expect(text).not.toContain(KEY);
  });

  it('also reads each string by the text rules: JSON behind an anti-hijacking prefix', () => {
    const id = 'abc123def456ghi7';
    const note = `)]}'\n${JSON.stringify({ session: { id } })}`;
    expect(JSON.stringify(masked({ note }))).not.toContain(id);
  });

  it('hides a string whole when the JSON and text rules each hid a different part', () => {
    const id = 'abc123def456ghi7';
    const note = `)]}'\n${JSON.stringify({ session: { id }, link: `https://x.example/?api_key=${KEY}` })}`;
    const text = JSON.stringify(masked({ note }));
    expect(text).not.toContain(id);
    expect(text).not.toContain(KEY);
  });

  it('stays valid JSON when a known value spans JSON’s own punctuation', () => {
    expect(masked({ key: 'value1234', n: 1 }, ['key":"value1234'])).toEqual({ key: 'value1234', n: 1 });
  });

  it('can’t be confused by a string that looks like a placeholder', () => {
    const out = masked({
      password: 'wirescryMarkedValue0',
      note: { wirescryMask: 'text', value: 'plain words' },
    });
    expect(out).toEqual({ password: '[redacted]', note: 'plain words' });
  });

  it('keeps ordinary fields inside an object named for a session or for auth', () => {
    const session = { title: 'Monday capture', started: 1732300000000, status: 200 };
    expect(masked({ session })).toEqual({ session });
    expect(masked({ token: 12, session: 5 })).toEqual({ token: 12, session: 5 });
  });

  it('never weakens a value by marking it: a mark under a secret’s name is hidden whole', () => {
    for (const leaf of [
      { wirescryMask: 'text', value: PASSWORD },
      { wirescryMask: 'url', value: PASSWORD },
      { wirescryMask: 'body', text: PASSWORD },
      { wirescryMask: 'header', name: 'x-note', value: PASSWORD },
    ]) {
      expect(masked({ password: leaf })).toEqual({ password: '[redacted]' });
    }
  });

  it('keeps one marked value when another under a secret’s name is hidden', () => {
    const out = masked({
      password: { wirescryMask: 'text', value: PASSWORD },
      note: { wirescryMask: 'text', value: 'plain words' },
    });
    expect(out).toEqual({ password: '[redacted]', note: 'plain words' });
  });

  it('keeps structure when two keys mask alike, or keys look like numbers', () => {
    const other = 'kv_' + 'Ab9Cd8Ef7Gh6';
    const out = masked({ 2: 'two', [KNOWN]: { a: 1 }, 1: 'one', [other]: { b: 2 } }, [
      KNOWN,
      other,
    ]) as Record<string, unknown>;
    expect(out['1']).toBe('one');
    expect(out['2']).toBe('two');
    expect(Object.values(out)).toEqual(expect.arrayContaining([{ a: 1 }, { b: 2 }]));
  });

  it('hides a value whose place in the masked JSON changed shape, and refuses JSON it can’t read', () => {
    const { fields, build } = collectResult({ a: { b: 1 }, c: [1, 2], d: 'x', e: 5 });
    const others = fields.map((f) => f.value);
    others[0] = '{"a":"[redacted]","c":"[redacted]","d":5,"e":"[redacted]"}';
    expect(build(others)).toEqual({ a: '[redacted]', c: '[redacted]', d: '[redacted]', e: '[redacted]' });
    // A list that came back shorter, an object with fewer keys.
    others[0] = '{"a":{},"c":[1],"d":"x","e":5}';
    expect(build(others)).toMatchObject({ a: '[redacted]', c: '[redacted]' });
    for (const bad of ['"\\x"', '{"a":1', '{"a":1}x', 'nope', '{"a" 1}', '[1 2]']) {
      others[0] = bad;
      expect(() => build(others), bad).toThrow(ResultError);
    }
  });

  it('keeps values under keys that don’t name a secret, or only describe one', () => {
    const result = { token_type: 'Bearer', totalTokenCount: 41, port: 8080, name: 'orders', id: 7 };
    expect(masked(result)).toEqual(result);
  });

  it('hides a secret-named value wherever else it turns up', () => {
    const out = masked({ password: PASSWORD, note: `was ${PASSWORD}` });
    expect(JSON.stringify(out)).not.toContain(PASSWORD);
  });

  it('keeps a key called __proto__', () => {
    const value = JSON.parse('{"a":1,"__proto__":{"x":"y"},"b":2}') as unknown;
    const out = masked(value) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['a', '__proto__', 'b']);
    expect(JSON.parse(JSON.stringify(out))).toEqual(value);
  });

  it('refuses a sparse list that claims too many items, without reading them; reads a small one', () => {
    expect(() => collectResult(new Array(2 ** 32 - 1))).toThrow('too large');
    // eslint-disable-next-line no-sparse-arrays -- a hole is the point
    expect(masked([1, , 3])).toEqual([1, null, 3]);
  });

  it('counts an object’s values toward the limit', () => {
    const many = (n: number): Record<string, number> =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 1]));
    expect(() => collectResult(many(MAX_NODES - 1))).not.toThrow();
    expect(() => collectResult(many(MAX_NODES))).toThrow('too large');
  });

  it('counts a body’s type toward the text limit', () => {
    const body = { wirescryMask: 'body', contentType: 'x'.repeat(MAX_STRING_CHARS), text: 'y' };
    expect(() => collectResult({ body })).toThrow('too large');
  });

  it('drops undefined as JSON does, and turns numbers JSON can’t hold into null', () => {
    expect(masked({ a: undefined, b: [undefined, 1], c: Number.NaN, d: Infinity })).toEqual({
      b: [null, 1],
      c: null,
      d: null,
    });
  });

  it('refuses what isn’t plain JSON', () => {
    for (const bad of [new Date(), new Map(), () => 1, 10n, Symbol('s'), new (class Thing {})()]) {
      expect(() => collectResult({ bad })).toThrow(ResultError);
    }
  });

  it('refuses a result that refers to itself, but takes the same object twice side by side', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => collectResult(loop)).toThrow('refers to itself');
    const shared = { a: 'x' };
    expect(masked({ one: shared, two: shared })).toEqual({ one: { a: 'x' }, two: { a: 'x' } });
  });

  it('refuses a result nested too deeply, with too many values, or too much text; takes one just inside', () => {
    const nest = (depth: number): unknown => (depth === 0 ? 'leaf' : [nest(depth - 1)]);
    expect(() => collectResult(nest(MAX_DEPTH))).not.toThrow();
    expect(() => collectResult(nest(MAX_DEPTH + 1))).toThrow('nests too deeply');
    expect(() => collectResult(Array.from({ length: MAX_NODES - 1 }, () => 1))).not.toThrow();
    expect(() => collectResult(Array.from({ length: MAX_NODES }, () => 1))).toThrow('too large');
    expect(() => collectResult('x'.repeat(MAX_STRING_CHARS))).not.toThrow();
    expect(() => collectResult('x'.repeat(MAX_STRING_CHARS + 1))).toThrow('too large');
  });
});
