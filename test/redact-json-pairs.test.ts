import { describe, expect, it } from 'vitest';
import { maskBytes } from '../src/backend/mask-body';
import { redactHarEntry } from '../src/backend/har-redact';
import { applySpans, REDACTED } from '../src/shared/redact';
import { jsonSpans, KnownValues, redactBody } from '../src/shared/redact-body';
import { expectGrowthUnder, timeOnce as once } from './timing';

// A made-up value, built at run time so the file holds nothing a secret scanner flags.
const S = ['Zq7', 'mK2', 'pL9', 'xW4'].join('-');
const T = ['Hv3', 'nB8', 'cD1', 'rY6'].join('-');

const redact = (text: string, known?: KnownValues): string => {
  const spans = jsonSpans(text, known);
  if (!spans) throw new Error('not JSON');
  return applySpans(text, spans);
};
const j = (value: unknown): string => JSON.stringify(value);

describe('JSON name/value pairs: secrets are masked', () => {
  const leaks: Array<[string, unknown]> = [
    ['value before name', { value: S, name: 'authorization' }],
    ['value before name, far apart', { value: S, note: 'x', other: [1, 2], name: 'password' }],
    ['capitalized keys', { Name: 'Authorization', Value: S }],
    ['upper-case keys', { NAME: 'password', VALUE: S }],
    ['capitalized, value first', { Value: S, Name: 'password' }],
    ['x-api-key', { name: 'x-api-key', value: S }],
    ['api_key', { name: 'api_key', value: S }],
    ['password', { name: 'password', value: S }],
    ['client secret', { name: 'client_secret', value: S }],
    ['a key/value tag', { Key: 'password', Value: S }],
    ['a field/value error', { field: 'password', value: S, message: 'too short' }],
    ['a header/value pair', { header: 'x-auth-token', value: S }],
    ['val', { name: 'password', val: S }],
    ['values', { name: 'x-api-key', values: [S, T] }],
    ['a list of values', { name: 'x-api-key', value: [S, T] }],
    ['nested lists', { name: 'password', value: [[S], [[T]]] }],
    ['an object value', { name: 'password', value: { current: S, previous: { old: T } } }],
    ['a value with spaces', { name: 'x-auth-token', value: `${S} ${T}` }],
    ['a short password', { name: 'password', value: 'hunter2' }],
    ['a tuple', [['authorization', S]]],
    ['a tuple, capitalized', [['Authorization', S]]],
    ['a password tuple', [['password', S]]],
    ['an API key tuple', [['x-api-key', S]]],
    [
      'a tuple among others',
      [
        ['accept', '*/*'],
        ['x-api-key', S],
        ['host', 'a.test'],
      ],
    ],
    ['a tuple with a list', [['x-api-key', [S, T]]]],
    ['tuples under a key', { headers: [['proxy-authorization', S]] }],
    ['a pair in JSON in a string', { body: j({ value: S, name: 'password' }) }],
  ];

  it.each(leaks)('%s', (_label, doc) => {
    const out = redact(j(doc));
    expect(out).not.toContain(S);
    expect(out).not.toContain(T);
    expect(out).not.toContain('hunter2');
    expect(() => JSON.parse(out) as unknown).not.toThrow();
    expect(out).toContain(REDACTED);
  });

  it('keeps a cookie’s name and an authorization’s scheme, in either order', () => {
    expect(redact(j({ value: `sid=${S}`, name: 'Cookie' }))).toBe(
      j({ value: `sid=${REDACTED}`, name: 'Cookie' }),
    );
    expect(redact(j([['cookie', `sid=${S}`]]))).toBe(j([['cookie', `sid=${REDACTED}`]]));
    expect(redact(j({ Value: `Bearer ${S}`, Name: 'Authorization' }))).toBe(
      j({ Value: `Bearer ${REDACTED}`, Name: 'Authorization' }),
    );
  });

  it('masks a PIN’s number, written back as a string', () => {
    expect(redact(j({ value: 123456, name: 'pin' }))).toBe(j({ value: REDACTED, name: 'pin' }));
    expect(redact(j([['pin', 123456]]))).toBe(j([['pin', REDACTED]]));
  });

  it('reads keys and names written with escapes', () => {
    const text = `{"v\\u0061lue":"${S}","n\\u0061me":"p\\u0061ssword"}`;
    expect(redact(text)).not.toContain(S);
  });

  it('treats any secret name in the object as the name, when it has two', () => {
    expect(redact(j({ name: 'accept', key: 'password', value: S }))).not.toContain(S);
    expect(redact(`{"name":"password","name":"accept","value":"${S}"}`)).not.toContain(S);
  });

  it('masks a value cut short after its name', () => {
    const text = `{"name":"password","value":"${S}`;
    const spans = jsonSpans(text, undefined, 0, true);
    expect(applySpans(text, spans!)).not.toContain(S);
  });

  it('learns a pair’s value, so a copy elsewhere is masked too', () => {
    const known = new KnownValues();
    const text = j({ note: `saw ${S} here`, pair: { value: S, name: 'password' } });
    const out = applySpans(text, redactBody(text, 'application/json', known).spans);
    expect(out).not.toContain(S);
  });

  it('reads past escaped quotes and backslashes to find the name', () => {
    expect(redact(`{"note":"a\\"b","value":"${S}","name":"password"}`)).not.toContain(S);
    expect(redact(`{"note":"a\\\\","value":"${S}","name":"password"}`)).not.toContain(S);
    expect(redact(`[["a\\"b","c"],["password","${S}"]]`)).not.toContain(S);
  });

  it('records a masked number without the pair’s name', () => {
    const { records } = redactBody(j({ value: 123456, name: 'pin' }), 'application/json');
    expect(records).toEqual([{ name: 'name/value pair', count: 1 }]);
  });

  it.each([
    ['a Bearer token as the name', { value: 'x', name: `Bearer ${S}${S}` }],
    ['a sentence as the name', [['my password is hunter2 ok?', 'noted']]],
    ['words with only spaces as the name', [['my password is hunter2', 'noted']]],
    ['a name too long to be one', { name: `password_${'a'.repeat(80)}`, value: 'x' }],
  ])('never records a free-text name: %s', (_label, doc) => {
    const { records } = redactBody(j(doc), 'application/json');
    const written = j(records);
    expect(written).not.toContain(S);
    expect(written).not.toContain('hunter2');
    expect(written).toContain('name/value pair');
  });

  it.each([
    ['in a secret list', { api_keys: [{ key: 'secret-9f8e7d6c5b4a3928', value: 'prod' }] }],
    ['a tuple in a secret list', { secrets: [['apikey-9f8e7d6c5b4a3928', 'x']] }],
    ['under a secret key', { password: { key: 'my-secret-passw0rd', value: 'x' } }],
  ])('never records a name the body masks: %s', (_label, doc) => {
    const written = j(redactBody(j(doc), 'application/json').records);
    expect(written).not.toContain('9f8e7d6c');
    expect(written).not.toContain('passw0rd');
  });

  it('masks a header pair whatever the case of its name', () => {
    for (const name of ['AuThOrIzAtIoN', 'pRoXy-AuThOrIzAtIoN', 'CoOkIe', 'sEt-CoOkIe']) {
      expect(redact(j({ Value: `Bearer ${S}`, Name: name }))).not.toContain(S);
      expect(redact(j([[name, `a=${S}`]]))).not.toContain(S);
    }
  });

  it('records a standard header’s name as written', () => {
    const { records } = redactBody(j({ value: `Bearer ${S}`, name: 'Authorization' }), 'application/json');
    expect(records).toEqual([{ name: 'Authorization', count: 1 }]);
  });

  it('leaves the known values’ “full” flag alone', () => {
    const known = new KnownValues();
    // Distinct endings: values sharing their last eight past a limit mark the set full (that's
    // tested with the known-value forms).
    const secrets = Array.from({ length: 12 }, (_, i) => `sk_test_abcdefghijklmnop${i}`);
    const text = j({ tokens: secrets, pair: { name: 'x-api-key', value: 'other-value-123' } });
    redactBody(text, 'application/json', known);
    expect(known.full).toBe(false);
  });

  it('never records a name holding a known value', () => {
    const known = new KnownValues();
    known.add(S);
    const { records } = redactBody(j([[`token_${S}`, 'x']]), 'application/json', known);
    expect(j(records)).not.toContain(S);
  });

  it('judges a name however long it is', () => {
    expect(redact(j({ name: `password ${'x'.repeat(1600)}`, value: S }))).not.toContain(S);
    expect(redact(j({ name: `password${' '.repeat(260)}`, value: S }))).not.toContain(S);
  });

  it.each([
    ['type', { type: 'password', value: S }],
    ['id', { id: 'password', value: S }],
    ['label', { label: 'Password', value: S }],
    ['param', { param: 'client_secret', value: S }],
    ['parameter', { parameter: 'api_key', value: S }],
    ['property', { property: 'password', value: S }],
    ['attribute', { attribute: 'password', value: S }],
    ['k and v', { k: 'password', v: S }],
    ['Keycloak’s shape', { credentials: [{ type: 'password', value: 'hunter2' }] }],
  ])('masks a password or secret named by %s', (_label, doc) => {
    const out = redact(j(doc));
    expect(out).not.toContain(S);
    expect(out).not.toContain('hunter2');
  });

  it('learns a value from a tuple and from under a pair', () => {
    for (const pair of [[['password', S]], { name: 'password', value: { a: [S] } }]) {
      const text = j({ note: `saw ${S} here`, pair });
      const out = applySpans(text, redactBody(text, 'application/json', new KnownValues()).spans);
      expect(out).not.toContain(S);
    }
  });

  it.each([
    ['a JSON prefix', `)]}'\n{"value":"${S}","name":"password"}`, 'application/json'],
    ['a byte order mark', '\uFEFF' + `{"value":"${S}","name":"password"}`, 'application/json'],
    ['leading space', `  \n{"value":"${S}","name":"password"}`, 'application/json'],
    ['NDJSON', `{"a":1}\n{"value":"${S}","name":"password"}\n`, 'application/x-ndjson'],
  ])('masks a pair after %s', (_label, text, type) => {
    expect(applySpans(text, redactBody(text, type).spans)).not.toContain(S);
  });

  it('records neither the pair’s free-text name nor its value', () => {
    const { records } = redactBody(j({ value: S, name: 'x-api-key' }), 'application/json');
    expect(records).toEqual([{ name: 'name/value pair', count: 1 }]);
  });
});

describe('JSON name/value pairs: everything else is kept', () => {
  const kept: Array<[string, unknown]> = [
    ['an ordinary pair', { name: 'accept', value: 'text/html' }],
    ['ordinary, value first', { value: 'text/html', name: 'accept' }],
    ['a name that describes a secret', { name: 'token_type', value: 'bearer' }],
    ['a count of tokens', { name: 'total_tokens', value: 'many words' }],
    ['a secret name in another field', { title: 'password', value: 'kept-value' }],
    ['a person named in a pair', { name: 'Ada Lovelace', value: 'kept-value' }],
    ['a name with no value key', { name: 'password', description: 'Your password' }],
    ['a plain list of words', ['password', 'kept-value']],
    ['a list of three', [['password', 'kept-value', 'more']]],
    ['a list of one', [['password']]],
    ['a tuple with an ordinary name', [['accept', 'text/html']]],
    ['a secret name second', [['kept-value', 'password']]],
    ['a tuple not in a list', { pair: ['password', 'kept-value'] }],
    ['a name that isn’t a string', { name: 42, value: 'kept-value' }],
    ['a sibling of a pair', { name: 'password', value: S, label: 'kept-value' }],
    [
      'the next pair in a list',
      [
        { name: 'password', value: S },
        { name: 'accept', value: 'kept-value' },
      ],
    ],
    ['a nested name doesn’t reach its parent', { value: 'kept-value', inner: { name: 'password' } }],
    ['a parent’s name doesn’t reach a sibling object', { name: 'password', other: { value: 'kept-value' } }],
  ];

  it.each(kept)('%s', (_label, doc) => {
    const text = j(doc);
    const out = redact(text);
    expect(out).not.toContain(S);
    if (text.includes('kept-value')) expect(out).toContain('kept-value');
    if (!text.includes(S)) expect(out).toBe(text);
  });

  it.each([
    ['a streamed word', { type: 'token', value: 'Hello' }],
    ['a session label', { label: 'Session', value: 'Morning' }],
    ['a token id', { id: 'token', value: 'kept-value' }],
    ['an ordinary type', { type: 'text', value: 'kept-value' }],
  ])('keeps weak-key labels that aren’t passwords or secrets: %s', (_label, doc) => {
    const text = j(doc);
    expect(redact(text)).toBe(text);
  });

  it('keeps a value of only spaces', () => {
    const text = j({ name: 'password', value: '   ' });
    expect(redact(text)).toBe(text);
  });

  it('keeps the pair’s name itself, and a tuple’s', () => {
    expect(redact(j({ name: 'password', value: S }))).toContain('"name":"password"');
    expect(redact(j([['password', S]]))).toContain('"password"');
  });

  it('keeps an empty value, and booleans and null', () => {
    for (const value of ['', true, false, null]) {
      const text = j({ name: 'password', value });
      expect(redact(text)).toBe(text);
    }
  });

  it('keeps a token pair’s number, as tokens’ numbers are kept', () => {
    const text = j({ name: 'x-auth-token', value: 12345 });
    expect(redact(text)).toBe(text);
  });
});

describe('JSON name/value pairs: every feature that masks a body', () => {
  const body = j([{ value: S, name: 'x-api-key' }, ['ignored'], [['Authorization', T]]]);

  it('Hide Secrets and MCP bodies', () => {
    const masked = maskBytes(Buffer.from(body), 'application/json', false, new KnownValues());
    if (!('bytes' in masked)) throw new Error('hidden');
    const out = Buffer.from(masked.bytes).toString();
    expect(out).not.toContain(S);
    expect(out).not.toContain(T);
  });

  it('redacted HAR export', () => {
    const entry = {
      startedDateTime: '2026-11-23T00:00:00.000Z',
      time: 1,
      request: {
        method: 'POST',
        url: 'https://a.test/',
        httpVersion: 'HTTP/1.1',
        headers: [],
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: body.length,
        postData: { mimeType: 'application/json', text: body },
      },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [],
        cookies: [],
        content: { size: body.length, mimeType: 'application/json', text: body },
        redirectURL: '',
        headersSize: -1,
        bodySize: body.length,
      },
      cache: {},
      timings: { send: 0, wait: 1, receive: 0 },
    };
    const meta = { cut: { request: false, response: false }, base64Frames: [], cutFrames: [] };
    const out = j(redactHarEntry(entry, meta, new KnownValues()).entry);
    expect(out).not.toContain(S);
    expect(out).not.toContain(T);
  });
});

describe('JSON name/value pairs: hostile input', () => {
  const linear = (make: (n: number) => string): void => {
    const run = (text: string) => (): void => void jsonSpans(text);
    let n = 1000;
    while (once(run(make(n))) < 10 && make(n).length < 4_000_000) n *= 2;
    expectGrowthUnder(run(make(n)), run(make(n * 8)), 20);
  };

  it('stays linear on many pairs', () => {
    linear((n) => `[${Array.from({ length: n }, () => '{"value":"x","name":"password"}').join(',')}]`);
  });

  it('stays linear on many tuples', () => {
    linear((n) => `[${Array.from({ length: n }, () => '["password","x"]').join(',')}]`);
  });

  it('stays linear on pairs nested in each other’s values', () => {
    linear((n) => {
      const depth = Math.min(n, 400);
      const unit = '{"value":'.repeat(depth) + '"x"' + ',"name":"password"}'.repeat(depth);
      return `[${Array.from({ length: Math.ceil(n / depth) }, () => unit).join(',')}]`;
    });
  });

  it('judges a costly name once, however many values it holds', () => {
    const name = `${'key '.repeat(63)}api${'x'.repeat(1200)}`;
    const items = (n: number, item: string): string => Array.from({ length: n }, () => item).join(',');
    linear((n) => `{"name":"${name}","value":[${items(n, '1')}]}`);
    linear((n) => `{"name":"${name}","value":[${items(n, '"a"')}]}`);
    const text = `{"name":"${name}","value":[${items(200_000, '"a"')}]}`;
    const started = performance.now();
    jsonSpans(text);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('stays linear when each line’s pair teaches a new value', () => {
    const lines = (n: number): string =>
      Array.from({ length: n }, (_, k) => `{"name":"password","value":"Qx${k}-unique-value-${n}-zz"}`).join(
        '\n',
      );
    const run = (text: string) => (): void =>
      void redactBody(text, 'application/x-ndjson', new KnownValues());
    expectGrowthUnder(run(lines(500)), run(lines(4000)), 20);
  });

  it('stays linear on a long run of backslashes', () => {
    linear((n) => `{"name":"${'\\\\'.repeat(n)}","value":"x"}`);
  });

  it('doesn’t treat a quote inside a string as structure', () => {
    const text = j({ note: '{"name":"password","value":"kept-value"', value: 'kept-too' });
    expect(redact(text)).toBe(text);
  });

  it('still refuses what isn’t JSON', () => {
    expect(jsonSpans('{"name":"password","value":}')).toBeUndefined();
    expect(jsonSpans('[["password","x"')).toBeUndefined();
  });

  it('gets through nesting past the limit without throwing', () => {
    expect(() => jsonSpans('['.repeat(5000))).not.toThrow();
    expect(() => jsonSpans('{"name":"password","value":'.repeat(5000))).not.toThrow();
  });
});
