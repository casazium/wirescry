import { describe, expect, it } from 'vitest';
import { applySpans, REDACTED } from '../src/shared/redact';
import {
  assignmentSpans,
  bodyKind,
  jsonSpans,
  KnownValues,
  redactBody,
  tagSpans,
  xmlElementSpans,
} from '../src/shared/redact-body';

// Fake tokens, built at run time so the file itself holds nothing a secret scanner flags.
const rep = (s: string, n: number): string => s.repeat(n);
const JWT = `eyJ${'hbGciOiJIUzI1NiJ9'}.eyJ${'zdWIiOiIxMjM0NTY3ODkwIn0'}.${'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'}`;
const GH = 'ghp_' + rep('aB3', 12);
const ANTHROPIC = 'sk-' + 'ant-api03-' + rep('Xy7_', 10);
const SESSION = 'Q2xA9fK3mZ7pL1sW8eR4tY6u';

/** A body redacted by its media type. */
const redact = (text: string, type: string, known?: KnownValues): string =>
  applySpans(text, redactBody(text, type, known).spans);
/** JSON redacted by the JSON rules alone; fails if it isn't JSON. */
const redactJson = (text: string, known?: KnownValues): string => {
  const spans = jsonSpans(text, known);
  if (!spans) throw new Error('not JSON');
  return applySpans(text, spans);
};

describe('JSON', () => {
  it('redacts values under secret names, leaving every other byte as it was', () => {
    const text =
      '{ "id" : 12345678901234567890, "user": {"password":"hunter2", "name":"Bob\\u00e9"},\n  "z":1.0, "a":[1,2], "password":"dup" }';
    expect(redactJson(text)).toBe(
      `{ "id" : 12345678901234567890, "user": {"password":"${REDACTED}", "name":"Bob\\u00e9"},\n  "z":1.0, "a":[1,2], "password":"${REDACTED}" }`,
    );
  });

  it('turns numbers under password and secret names into a redacted string, keeping booleans and null', () => {
    const out = redactJson(
      '{"pin":1234,"cvv":123,"api_key":98765,"secret":true,"has_password":false,"otp":null,"n":5}',
    );
    expect(out).toBe(
      `{"pin":"${REDACTED}","cvv":"${REDACTED}","api_key":"${REDACTED}","secret":true,"has_password":false,"otp":null,"n":5}`,
    );
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('keeps short or spaced strings and numbers under token and session names', () => {
    const text =
      '{"token":"Hello","session":"a b c d e f g h","access_token":12345678,"sessionId":"s3ss10nAbcdef"}';
    expect(redactJson(text)).toBe(
      `{"token":"Hello","session":"a b c d e f g h","access_token":12345678,"sessionId":"${REDACTED}"}`,
    );
  });

  it('keeps names that describe a secret, and JSON codes', () => {
    const text =
      '{"token_type":"Bearer","totalTokenCount":42,"max_tokens":100,"code":"invalid_request","SecretId":"abc123def456","token_endpoint":"https://a.example/t"}';
    expect(redactJson(text)).toBe(text);
  });

  it('gives an object under a secret name its rule for direct values, keeping described ones', () => {
    const text = `{"token":{"value":"abcdefgh1234","type":"Bearer","id":"t1","deep":{"note":"abcdefghijkl"}},"auth":{"password":"pw"}}`;
    expect(redactJson(text)).toBe(
      `{"token":{"value":"${REDACTED}","type":"Bearer","id":"t1","deep":{"note":"abcdefghijkl"}},"auth":{"password":"${REDACTED}"}}`,
    );
  });

  it('gives an array under a secret name its rule for items, but not objects in it', () => {
    const text = `{"secrets":["one","two"],"credentials":[{"label":"x"}],"keys":{"api_keys":["k1","k2"]}}`;
    expect(redactJson(text)).toBe(
      `{"secrets":["${REDACTED}","${REDACTED}"],"credentials":[{"label":"x"}],"keys":{"api_keys":["${REDACTED}","${REDACTED}"]}}`,
    );
  });

  it('gives an array its rule from where it sits: a neutral key in a secret object, or a secret array', () => {
    const text = '{"token":{"list":["abcdefgh1234"]},"secrets":[["one"]],"other":{"list":["abcdefgh1234"]}}';
    expect(redactJson(text)).toBe(
      `{"token":{"list":["${REDACTED}"]},"secrets":[["${REDACTED}"]],"other":{"list":["abcdefgh1234"]}}`,
    );
  });

  it('finds token shapes and URL secrets inside strings, escapes and all', () => {
    const text = `{"note":"see ${JWT} and https:\\/\\/a.example\\/cb?code=abc\\u0026x=1","n":1}`;
    expect(redactJson(text)).toBe(
      `{"note":"see ${REDACTED} and https:\\/\\/a.example\\/cb?code=${REDACTED}\\u0026x=1","n":1}`,
    );
  });

  it('looks into JSON inside a string, escaping what it writes back', () => {
    const inner = JSON.stringify({ api_key: ANTHROPIC, pin: 4321, q: 'ok' });
    const text = JSON.stringify({ name: 'call', arguments: inner });
    const out = redactJson(text);
    const parsed = JSON.parse(out) as { arguments: string };
    expect(JSON.parse(parsed.arguments)).toEqual({ api_key: REDACTED, pin: REDACTED, q: 'ok' });
    expect(out).not.toContain(ANTHROPIC);
  });

  it('records a redaction under the name its rule came from', () => {
    const spans = jsonSpans('{"token":{"value":"abcdefgh1234"},"secrets":["one"]}')!;
    expect(spans.map((s) => s.name)).toEqual(['token', 'secrets']);
  });

  it.each([
    ['a trailing comma', '{"a":1,}'],
    ['junk after the value', '{"a":1} x'],
    ['an unclosed string', '{"a":"b}'],
    ['a bare word', '{"a":nope}'],
    ['a missing colon', '{"a" 1}'],
    ['a bad escape', '{"a":"\\q"}'],
    ['nothing', '   '],
    ['an unclosed object', '{"a":1'],
    ['nesting past the limit', rep('[', 600) + rep(']', 600)],
  ])('isn’t JSON with %s', (_what, text) => {
    expect(jsonSpans(text)).toBeUndefined();
  });

  it('takes JSON at its top level of any kind', () => {
    expect(jsonSpans('[]')).toEqual([]);
    expect(jsonSpans('"just a string"')).toEqual([]);
    expect(jsonSpans(' 42 ')).toEqual([]);
    expect(jsonSpans('{}')).toEqual([]);
  });

  it('always leaves valid JSON', () => {
    for (const value of [
      { password: 'a"b\\c', nested: { secret: 1.5e10, list: [{ token: rep('x', 20) }] } },
      { args: JSON.stringify({ pin: 1, token: JWT }), url: `https://a/?sig=${GH}` },
      [{ apiKey: null }, { 'x-api-key': 'k' }],
    ]) {
      const text = JSON.stringify(value, null, 2);
      expect(() => JSON.parse(redactJson(text))).not.toThrow();
    }
  });
});

describe('known values', () => {
  it('finds a known value as written and percent-encoded, standing alone', () => {
    const known = new KnownValues();
    known.add(SESSION);
    known.add('Ab/12+34=5678xyZ');
    const text = `x ${SESSION} y ${encodeURIComponent('Ab/12+34=5678xyZ')} z a${SESSION} ${SESSION}b`;
    expect(applySpans(text, known.scan(text))).toBe(`x ${REDACTED} y ${REDACTED} z a${SESSION} ${SESSION}b`);
  });

  it('ignores values that aren’t distinctive, or have no run of four token characters', () => {
    const known = new KnownValues();
    for (const value of ['production', '12345678', 'short1', '!@#$%^&*()abc', 'Europe/Berlin'])
      known.add(value);
    expect(known.size).toBe(0);
    expect(known.scan('production 12345678 short1')).toEqual([]);
  });

  it('finds a value learned late in a body earlier in it too', () => {
    const known = new KnownValues();
    const text = `{"echo":"${SESSION}","password":"${SESSION}"}`;
    expect(redact(text, 'application/json', known)).toBe(`{"echo":"${REDACTED}","password":"${REDACTED}"}`);
    // The assignment rule's values aren't collected: free text is too loose a source.
    const loose = new KnownValues();
    const text2 = `first ${SESSION}\npassword=${SESSION}`;
    expect(redact(text2, 'text/plain', loose)).toBe(`first ${SESSION}\npassword=${REDACTED}`);
    expect(loose.size).toBe(0);
  });

  it('finds values from one place in another: a header’s token in a page', () => {
    const known = new KnownValues();
    known.add(SESSION);
    expect(redact(`<p data-x="${SESSION}">hi</p>`, 'text/html', known)).toBe(
      `<p data-x="${REDACTED}">hi</p>`,
    );
    // In JSON, inside strings only (escaped or not), never in numbers or structure.
    const json = `{"echo":"${SESSION}","n":12345678}`;
    expect(redact(json, 'application/json', known)).toBe(`{"echo":"${REDACTED}","n":12345678}`);
  });

  it('doesn’t match a value with a separator inside when the text runs on past either edge', () => {
    const known = new KnownValues();
    // Each value's longest run is away from the edge being checked, so the run itself still matches.
    known.add('ab.Cdefgh12xy');
    known.add('Klmnop34uv.c9');
    const text = 'zab.Cdefgh12xy ab.Cdefgh12xy Klmnop34uv.c9z Klmnop34uv.c9';
    expect(applySpans(text, known.scan(text))).toBe(`zab.Cdefgh12xy ${REDACTED} Klmnop34uv.c9z ${REDACTED}`);
  });

  it('doesn’t match inside a longer run or across a number', () => {
    const known = new KnownValues();
    known.add('ab12cd34');
    expect(known.scan('xab12cd34 ab12cd34y 9ab12cd34')).toEqual([]);
  });
});

describe('the assignment rule', () => {
  it.each([
    ['password=hunter2!', `password=${REDACTED}`],
    ['api_key: abcdef123456', `api_key: ${REDACTED}`],
    ['"token": "a b c"', `"token": "${REDACTED}"`],
    ["secret='sq\\'uote'", `secret='${REDACTED}'`],
    ['login with password=correcthorse.', `login with password=${REDACTED}.`],
    ['client_secret=s3cr3tv4lue&x=1', `client_secret=${REDACTED}&x=1`],
  ])('redacts %s', (text, expected) => {
    expect(applySpans(text, assignmentSpans(text))).toBe(expected);
  });

  it.each([
    ['a short value', 'password=abc'],
    ['code', 'password: e.target(value)'],
    ['a type', 'token: string'],
    ['null', 'secret = null'],
    ['a template', 'password=${PASSWORD}'],
    ['a session (not a strong name)', 'session=abcdefghijk'],
    ['a code name', 'code=abcdefghijk'],
    ['a name inside a word', 'mypassword_hint=abcdefghij'],
    ['prose', 'The password policy: at least eight characters'],
  ])('leaves %s alone', (_what, text) => {
    expect(assignmentSpans(text)).toEqual([]);
  });

  it('reads a value once: an assignment inside one already read is part of it', () => {
    const text = 'password=password=hunter22 then secret=s3cr3tvalue';
    expect(applySpans(text, assignmentSpans(text))).toBe(`password=${REDACTED} then secret=${REDACTED}`);
    const quoted = 'password="abc password="def" token="tok12345"';
    expect(applySpans(quoted, assignmentSpans(quoted))).toBe(
      `password="${REDACTED}"def" token="${REDACTED}"`,
    );
  });

  it('reads repeated assignments with no end quickly', () => {
    for (const text of [rep('password=', 200_000), rep('password="', 200_000), rep("secret='x", 200_000)]) {
      const start = performance.now();
      assignmentSpans(text);
      expect(performance.now() - start).toBeLessThan(1500);
    }
  });

  it('isn’t used in code, and only outside scripts and styles in HTML', () => {
    expect(redact('const password = getValueFromStore123;', 'application/javascript')).toBe(
      'const password = getValueFromStore123;',
    );
    const html = '<script>var password = "abcdefgh1";</script><p>password: abcdefgh1</p>';
    expect(redact(html, 'text/html')).toBe(
      `<script>var password = "abcdefgh1";</script><p>password: ${REDACTED}</p>`,
    );
  });
});

describe('tags', () => {
  it('redacts form inputs and meta tags by their name, either order', () => {
    const html =
      '<input type="hidden" name="csrf_token" value="tok123abc"><input value="v2v2v2v2" name="password">' +
      '<meta name="csrf-token" content="meta123abc"><input name="email" value="a@b.c">';
    expect(applySpans(html, tagSpans(html))).toBe(
      `<input type="hidden" name="csrf_token" value="${REDACTED}"><input value="${REDACTED}" name="password">` +
        `<meta name="csrf-token" content="${REDACTED}"><input name="email" value="a@b.c">`,
    );
  });

  it('redacts attributes with secret names, and .NET config’s key and value', () => {
    const xml =
      '<add key="ApiKey" value="k3yk3yk3y"/><conn password=\'p@ss\' user="sa"/><add key="Mode" value="x"/>';
    expect(applySpans(xml, tagSpans(xml))).toBe(
      `<add key="ApiKey" value="${REDACTED}"/><conn password='${REDACTED}' user="sa"/><add key="Mode" value="x"/>`,
    );
  });

  it('redacts XML elements with secret names, prefixed or with attributes', () => {
    const xml =
      '<wsse:Password Type="PasswordText">pw123</wsse:Password><Username>bob</Username><Token/><token>a</other>';
    expect(applySpans(xml, xmlElementSpans(xml))).toBe(
      `<wsse:Password Type="PasswordText">${REDACTED}</wsse:Password><Username>bob</Username><Token/><token>a</other>`,
    );
  });
});

describe('bodies by kind', () => {
  it.each([
    ['application/json; charset=utf-8', 'json'],
    ['application/vnd.api+json', 'json'],
    ['application/x-ndjson', 'ndjson'],
    ['text/event-stream', 'sse'],
    ['application/x-www-form-urlencoded', 'form'],
    ['multipart/form-data; boundary=x', 'multipart'],
    ['text/html', 'html'],
    ['application/soap+xml', 'xml'],
    ['text/javascript', 'code'],
    ['text/css', 'code'],
    ['application/grpc-web-text', 'opaque'],
    ['text/plain', 'text'],
    [undefined, 'text'],
  ] as const)('%s is %s', (type, kind) => {
    expect(bodyKind(type)).toBe(kind);
  });

  it('redacts a form', () => {
    expect(
      redact(
        `user=bob&password=hunter2&csrfmiddlewaretoken=abc&next=%2Fhome&t=${GH}`,
        'application/x-www-form-urlencoded',
      ),
    ).toBe(`user=bob&password=${REDACTED}&csrfmiddlewaretoken=${REDACTED}&next=%2Fhome&t=${REDACTED}`);
  });

  it('redacts an event stream’s JSON data lines by name and other lines by shape', () => {
    const text = `event: auth\ndata: {"access_token":"${SESSION}","n":1}\n\ndata: plain ${JWT}\nid: 7\n`;
    expect(redact(text, 'text/event-stream')).toBe(
      `event: auth\ndata: {"access_token":"${REDACTED}","n":1}\n\ndata: plain ${REDACTED}\nid: 7\n`,
    );
  });

  it('redacts NDJSON line by line', () => {
    const text = `{"password":"a"}\n{"ok":true}\r\nnot json ${GH}\n`;
    expect(redact(text, 'application/x-ndjson')).toBe(
      `{"password":"${REDACTED}"}\n{"ok":true}\r\nnot json ${REDACTED}\n`,
    );
  });

  it('redacts multipart parts: secret fields whole, JSON parts by name, and says what it skipped', () => {
    const b = 'XyZ';
    const text = [
      `--${b}`,
      'Content-Disposition: form-data; name="password"',
      '',
      'hunter2',
      `--${b}`,
      'Content-Disposition: form-data; name="meta"',
      'Content-Type: application/json',
      '',
      '{"api_key":"k1k1k1","n":2}',
      `--${b}`,
      'Content-Disposition: form-data; name="file"; filename="a.png"',
      'Content-Type: image/png',
      '',
      'PNGDATA',
      `--${b}`,
      'Content-Disposition: form-data; name="notes"; filename="notes.txt"',
      'Content-Type: text/plain',
      '',
      `see ${GH}`,
      `--${b}--`,
      '',
    ].join('\r\n');
    const result = redactBody(text, `multipart/form-data; boundary=${b}`);
    const out = applySpans(text, result.spans);
    expect(out).toContain(`name="password"\r\n\r\n${REDACTED}\r\n`);
    expect(out).toContain(`{"api_key":"${REDACTED}","n":2}`);
    expect(out).toContain('PNGDATA');
    expect(out).toContain(`see ${REDACTED}`);
    expect(result.notScanned).toBe('a file part that isn’t text');
  });

  it('says an encoded body wasn’t scanned', () => {
    expect(redactBody('AAAAAAA=', 'application/grpc-web-text')).toEqual({
      spans: [],
      records: [],
      notScanned: 'an encoded body',
    });
  });

  it('takes JSON sent as text as JSON, and falls back to text for bad JSON', () => {
    expect(redact('{"password":"x"}', 'text/plain')).toBe(`{"password":"${REDACTED}"}`);
    // Bad JSON gets the text rules, the assignment rule among them.
    expect(redact(`{"password":"x", ${JWT}`, 'application/json')).toBe(
      `{"password":"${REDACTED}", ${REDACTED}`,
    );
  });

  it('counts what it redacted', () => {
    expect(redactBody(`{"password":"a","pin":1,"t":"${GH}"}`, 'application/json').records).toEqual([
      { name: 'password', count: 1 },
      { name: 'pin', count: 1 },
      { kind: 'GitHub token', count: 1 },
    ]);
  });
});

describe('time', () => {
  const once = (run: () => void): number => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };
  const timeBoth = (small: () => void, large: () => void): [number, number] => {
    let a = Infinity;
    let b = Infinity;
    for (let i = 0; i < 5; i++) {
      a = Math.min(a, once(small));
      b = Math.min(b, once(large));
    }
    return [a, b];
  };

  it.each([
    ['repeated assignments', (n: number) => rep('password=', n), 'text/plain'],
    ['a long run of letters', (n: number) => rep('a', n * 8), 'text/plain'],
    ['repeated unclosed tags', (n: number) => rep('<input name=password value=', n), 'text/html'],
    ['repeated open elements', (n: number) => rep('<Password>', n), 'application/xml'],
    ['repeated script tags', (n: number) => rep('<script>password=abcdefgh1 ', n), 'text/html'],
    [
      'many JSON keys',
      (n: number) => `{${Array.from({ length: n }, (_, i) => `"k${i}":"${i}"`).join(',')}}`,
      'application/json',
    ],
    ['a long JSON string of escapes', (n: number) => `{"a":"${rep('\\u0041\\/', n)}"}`, 'application/json'],
    [
      'deep JSON, many times',
      (n: number) => `[${Array.from({ length: n / 50 }, () => rep('[', 50) + rep(']', 50)).join(',')}]`,
      'application/json',
    ],
    ['many lines', (n: number) => rep('data: {"token":"x"}\n', n), 'text/event-stream'],
    [
      'many multipart boundaries',
      (n: number) => rep('--b\r\n\r\nx\r\n', n),
      'multipart/form-data; boundary=b',
    ],
    ['encoded runs', (n: number) => rep('a%41', n * 2), 'text/plain'],
  ])('stays linear on %s', { timeout: 60_000 }, (_what, make, type) => {
    const known = new KnownValues();
    known.add(SESSION);
    const run = (text: string) => () => redactBody(text, type, known);
    let n = 2_000;
    run(make(n))();
    while (once(run(make(n))) < 10 && make(n).length < 2_000_000) n *= 2;
    const [t1, t2] = timeBoth(run(make(n)), run(make(n * 8)));
    expect(t2 / t1).toBeLessThan(20);
  });
});

describe('limits and edges', () => {
  it('keeps at most a few values sharing one longest run, so a scan stays quick', () => {
    const known = new KnownValues();
    for (let i = 0; i < 20; i++) known.add(`${i}.Shared_Run_Of_Text.${i}`);
    expect(known.size).toBe(8);
  });

  it('keeps at most 10,000 values in all', () => {
    const known = new KnownValues();
    for (let i = 0; i < 10_050; i++) known.add(`Val${i}ue${i}Xyz`);
    expect(known.size).toBe(10_000);
  });

  it('skips a value whose longest run is under four characters: it couldn’t be found quickly', () => {
    const known = new KnownValues();
    known.add('ab1.cd2.ef3.gh4');
    expect(known.size).toBe(0);
  });

  it('redacts a known value or token used as a JSON key, inside its quotes, and leaves numbers alone', () => {
    const known = new KnownValues();
    known.add('ab12cd34ef');
    const text = `{"ab12cd34ef":1,"v":"ab12cd34ef","${GH}":true,"n":12345678}`;
    expect(redact(text, 'application/json', known)).toBe(
      `{"${REDACTED}":1,"v":"${REDACTED}","${REDACTED}":true,"n":12345678}`,
    );
  });

  it('finds a value partly encoded', () => {
    const known = new KnownValues();
    known.add('Ab/12cd34ef56');
    const text = 'x=Ab%2F12cd34ef56&y=1';
    expect(applySpans(text, known.scan(text))).toBe(`x=${REDACTED}&y=1`);
  });

  it('ends an unquoted value at markup and quotes', () => {
    expect(applySpans('<b>password: abcdefgh1</b>', assignmentSpans('<b>password: abcdefgh1</b>'))).toBe(
      `<b>password: ${REDACTED}</b>`,
    );
    const attr = `x='password=abcdefgh1' y`;
    expect(applySpans(attr, assignmentSpans(attr))).toBe(`x='password=${REDACTED}' y`);
  });
});

describe('a whole exchange', () => {
  it('leaves none of the planted secrets anywhere, once the headers have taught it their values', async () => {
    const { redactHeaders, redactUrl } = await import('../src/shared/redact');
    const csrf = 'Cs8fT0kenV4lue9xYz';
    const known = new KnownValues();
    const url = redactUrl(`https://app.example/api/cb?code=Spl0xAbcDef&state=1`, known).url;
    const { headers } = redactHeaders(
      [
        ['authorization', `Bearer ${JWT}`],
        ['cookie', `sid=${SESSION}; theme=dark`],
        ['x-csrf-token', csrf],
      ],
      known,
    );
    const request = redact(
      JSON.stringify({ user: 'bob', password: 'hunter22', note: `copy of ${SESSION}` }),
      'application/json',
      known,
    );
    const page = redact(
      `<html><meta name="csrf-token" content="${csrf}"><script>window.jwt="${JWT}"</script><p>${encodeURIComponent(SESSION)}</p></html>`,
      'text/html',
      known,
    );
    const stream = redact(
      `data: {"delta":"echo ${SESSION}","api_key":"${ANTHROPIC}"}\n\n`,
      'text/event-stream',
      known,
    );
    const out = [url, JSON.stringify(headers), request, page, stream].join('\n');
    for (const secret of [JWT, SESSION, csrf, 'hunter22', ANTHROPIC, 'Spl0xAbcDef']) {
      expect(out).not.toContain(secret);
      expect(out).not.toContain(encodeURIComponent(secret));
    }
    // Every cookie value is redacted, but its name is kept.
    for (const kept of ['theme=', '"user":"bob"', 'state=1', '<html>', '"delta":"echo '])
      expect(out).toContain(kept);
  });
});

describe('fixes from the A2 review', () => {
  const crlfParts = (parts: string[][], b = 'B0und'): string =>
    [...parts.map(([headers, body]) => `--${b}\r\n${headers}\r\n\r\n${body}`), `--${b}--\r\n`].join('\r\n');

  it('finds known values where the JSON walk falls back to text', () => {
    const known = new KnownValues();
    known.add(SESSION);
    // A body cut short, a non-JSON NDJSON line, event-stream text lines, stream+json.
    expect(redact(`{"a":"${SESSION}","b":`, 'application/json', known)).toBe(`{"a":"${REDACTED}","b":`);
    expect(redact(`not json ${SESSION}\n{"ok":1}`, 'application/x-ndjson', known)).toBe(
      `not json ${REDACTED}\n{"ok":1}`,
    );
    expect(redact(`event: x ${SESSION}\ndata: hello ${SESSION}\n`, 'text/event-stream', known)).toBe(
      `event: x ${REDACTED}\ndata: hello ${REDACTED}\n`,
    );
    expect(bodyKind('application/stream+json')).toBe('ndjson');
  });

  it('reads JSON after a byte order mark or an XSSI guard, and JSON objects one per line', () => {
    expect(redact('\uFEFF{"password":"x"}', 'application/json')).toBe(`\uFEFF{"password":"${REDACTED}"}`);
    expect(redact(`)]}',\n{"password":"x"}`, 'application/json')).toBe(`)]}',\n{"password":"${REDACTED}"}`);
    expect(redact('while(1);{"password":"x"}', 'application/json')).toBe(
      `while(1);{"password":"${REDACTED}"}`,
    );
    expect(redact('{"password":"a"}\n{"password":"b"}', 'application/json')).toBe(
      `{"password":"${REDACTED}"}\n{"password":"${REDACTED}"}`,
    );
  });

  it('reads guarded and line-by-line JSON as JSON, not text: a short token value stays', () => {
    // As text, the assignment rule would redact "Hello"; as JSON, a token that short is kept.
    expect(redact(`)]}'\n{\n  "token": "Hello"\n}`, 'application/json')).toBe(
      `)]}'\n{\n  "token": "Hello"\n}`,
    );
    expect(redact('{"token":"Hello"}\n{"token":"World"}', 'application/json')).toBe(
      '{"token":"Hello"}\n{"token":"World"}',
    );
  });

  it('writes a bare number back quoted when JSON falls to text, so it stays JSON-shaped', () => {
    expect(redact('{"pin": 123456, "password": 12345678', 'application/json')).toBe(
      `{"pin": "${REDACTED}", "password": "${REDACTED}"`,
    );
  });

  it('redacts a session’s or token’s own id and value, and keys and values of objects in secret arrays', () => {
    expect(redactJson('{"session":{"id":"s1s2s3s4s5","user":"bob"},"token":{"value":"t1t2t3t4t5"}}')).toBe(
      `{"session":{"id":"${REDACTED}","user":"bob"},"token":{"value":"${REDACTED}"}}`,
    );
    expect(
      redactJson('{"api_keys":[{"key":"k1k2k3k4k5","label":"prod"}],"secrets":[{"value":"pw","note":"x"}]}'),
    ).toBe(
      `{"api_keys":[{"key":"${REDACTED}","label":"prod"}],"secrets":[{"value":"${REDACTED}","note":"x"}]}`,
    );
  });

  it('redacts echoed headers in JSON as the headers themselves would be', () => {
    const text =
      '{"Cookie":"sid=abc123def456; theme=dark","Authorization":"Token abc123","set-cookie":"a=1; Path=/"}';
    expect(redactJson(text)).toBe(
      `{"Cookie":"sid=${REDACTED}; theme=${REDACTED}","Authorization":"Token ${REDACTED}","set-cookie":"a=${REDACTED}; Path=/"}`,
    );
  });

  it('doesn’t take an inherited value as known: only one under its own strong name', () => {
    const known = new KnownValues();
    redactJson('{"credentials":{"username":"alice@example.com","password":"Hunter2Hunter2"}}', known);
    expect(known.scan('alice@example.com Hunter2Hunter2').length).toBe(1);
  });

  it('redacts a SAML-sized hidden input', () => {
    const saml = rep('PHNhbWxwOlJlc3BvbnNl', 400);
    const html = `<form><input type="hidden" name="SAMLResponse" value="${saml}"></form>`;
    expect(redact(html, 'text/html')).toBe(
      `<form><input type="hidden" name="SAMLResponse" value="${REDACTED}"></form>`,
    );
  });

  it('redacts a password field whatever its name, a secret textarea, and XML CDATA and keyed entries', () => {
    expect(redact('<input type="password" name="p1" value="v1v1v1">', 'text/html')).toBe(
      `<input type="password" name="p1" value="${REDACTED}">`,
    );
    expect(redact('<textarea name="secret">abc</textarea>', 'text/html')).toBe(
      `<textarea name="secret">${REDACTED}</textarea>`,
    );
    expect(
      redact('<Password><![CDATA[p<w]]></Password><entry key="password">pw2</entry>', 'application/xml'),
    ).toBe(`<Password><![CDATA[${REDACTED}]]></Password><entry key="password">${REDACTED}</entry>`);
  });

  it('reads multipart parts after a malformed one, the preamble and epilogue, and unquoted names', () => {
    const b = 'B0und';
    const text =
      `preamble ${GH}\r\n--${b}\r\nno blank line here ${JWT}\r\n--${b}\r\n` +
      `Content-Disposition: form-data; name=password\r\n\r\nhunter2\r\n--${b}--\r\nepilogue ${GH}`;
    const out = redact(text, `multipart/form-data; boundary=${b}`);
    expect(out).toBe(
      `preamble ${REDACTED}\r\n--${b}\r\nno blank line here ${REDACTED}\r\n--${b}\r\n` +
        `Content-Disposition: form-data; name=password\r\n\r\n${REDACTED}\r\n--${b}--\r\nepilogue ${REDACTED}`,
    );
  });

  it('redacts a secret-named file part whole, finds shapes in binary ones, and isn’t fooled by filename=', () => {
    const text = crlfParts([
      [
        'Content-Disposition: form-data; name="ssh_private_key"; filename="id"\r\nContent-Type: application/octet-stream',
        'KEYDATA',
      ],
      [
        'Content-Disposition: form-data; name="up"; filename="password"\r\nContent-Type: application/octet-stream',
        `bin ${GH}`,
      ],
    ]);
    const out = redact(text, 'multipart/form-data; boundary=B0und');
    expect(out).toContain(`filename="id"\r\nContent-Type: application/octet-stream\r\n\r\n${REDACTED}`);
    expect(out).toContain(`bin ${REDACTED}`);
  });

  it('stops looking into nested multipart after two levels', () => {
    let body = `password=deep1234`;
    // Deep enough to overflow the stack without the limit.
    for (let i = 0; i < 3000; i++) {
      body = crlfParts([[`Content-Type: multipart/mixed; boundary=b${i}`, body]], `b${i + 1}`);
    }
    expect(() => redactBody(body, 'multipart/mixed; boundary=b3000')).not.toThrow();
  });

  it('redacts a form field holding JSON with a secret, and known values written with + for spaces', () => {
    const known = new KnownValues();
    known.add('correct horse battery 1');
    const text = `payload=${encodeURIComponent('{"password":"x"}')}&q=correct+horse+battery+1&other=%7B%22a%22%3A1%7D`;
    expect(redact(text, 'application/x-www-form-urlencoded', known)).toBe(
      `payload=${REDACTED}&q=${REDACTED}&other=%7B%22a%22%3A1%7D`,
    );
  });

  it('finds a known value beside raw / = : @ and escapes, never leaving part of an escape', () => {
    const known = new KnownValues();
    known.add('ab12/cdEFgh+ijKL==');
    known.add('+abcDEF123456');
    const text = `x=ab12/cdEFgh%2BijKL== y=token%3D%2BabcDEF123456`;
    // A value starting inside a run of escapes takes the whole run: more, never less.
    expect(applySpans(text, known.scan(text))).toBe(`x=${REDACTED} y=token${REDACTED}`);
  });

  it('trims closing brackets from an unquoted value, and skips quoted stop words', () => {
    expect(applySpans('(password=hunter22)', assignmentSpans('(password=hunter22)'))).toBe(
      `(password=${REDACTED})`,
    );
    expect(
      applySpans('{user: bob, password: hunter22}', assignmentSpans('{user: bob, password: hunter22}')),
    ).toBe(`{user: bob, password: ${REDACTED}}`);
    expect(assignmentSpans('"password": "required"')).toEqual([]);
  });

  it('turns away values far longer than their longest run, and says when it’s full', () => {
    const known = new KnownValues();
    // 202 characters around a 4-character run: over 32 times as long.
    known.add(rep('abcd.', 40) + 'X1');
    expect(known.size).toBe(0);
    expect(known.full).toBe(false);
    for (let i = 0; i < 9; i++) known.add(`${i}.Shared_Run_Of_Text.${i}`);
    expect(known.full).toBe(true);
  });

  it('takes as JSON exactly what JSON.parse does, on a corpus', () => {
    const corpus = [
      '{}',
      '[]',
      '"s"',
      '1',
      '-0.5e3',
      'true',
      'null',
      '{"a":[1,{"b":"c\\u00e9"}],"d":null}',
      ' [ 1 , 2 ] ',
      '{',
      '}',
      '[1,]',
      '{"a":1,}',
      '{"a" 1}',
      "{'a':1}",
      '01',
      '1.',
      '.5',
      '+1',
      'tru',
      '{"a":"\\x"}',
      '[1 2]',
      '{"a":1}{"b":2}',
      '',
    ];
    for (const text of corpus) {
      let valid = true;
      try {
        JSON.parse(text);
      } catch {
        valid = false;
      }
      expect(jsonSpans(text) !== undefined, text).toBe(valid);
    }
  });

  it('always leaves JSON-shaped output on the text paths too', () => {
    const known = new KnownValues();
    known.add(SESSION);
    for (const [text, type] of [
      [`{"t":"${SESSION}","n":1700000000.123456}`, 'text/plain'],
      [`)]}',\n{"pin":1,"x":"${SESSION}"}`, 'application/json'],
      ['{"a":1}\n{"password":2}', 'application/json'],
    ] as const) {
      const out = redact(text, type, known);
      const json = out.replace(/^\)\]\}',\n/, '');
      for (const line of json.split('\n')) expect(() => JSON.parse(line), out).not.toThrow();
    }
  });
});

describe('time, after the A2 review', () => {
  const once = (run: () => void): number => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };
  it.each([
    ['multipart parts, CRLF', (n: number) => rep('--b\r\n\r\nx\r\n', n)],
    ['multipart parts, LF', (n: number) => rep('--b\n\nx\n', n)],
    [
      'ordinary multipart fields',
      (n: number) => rep('--b\r\nContent-Disposition: form-data; name="f"\r\n\r\nvalue\r\n', n),
    ],
  ])('stays linear on %s', { timeout: 60_000 }, (_what, make) => {
    const run = (text: string) => () => redactBody(text, 'multipart/form-data; boundary=b');
    let n = 2_000;
    run(make(n))();
    while (once(run(make(n))) < 10 && make(n).length < 2_000_000) n *= 2;
    let t1 = Infinity;
    let t2 = Infinity;
    for (let i = 0; i < 5; i++) {
      t1 = Math.min(t1, once(run(make(n))));
      t2 = Math.min(t2, once(run(make(n * 8))));
    }
    // Linear gives about 8; even n^1.44 would pass 20, so the limit here is tighter.
    expect(t2 / t1).toBeLessThan(14);
  });

  it('finds known values quickly when they share a short run', () => {
    const known = new KnownValues();
    for (let i = 0; i < 8; i++) known.add(`${rep('abcd.', 6)}Z${i}`);
    const text = rep('.abcd', 200_000);
    const start = performance.now();
    redactBody(text, 'text/plain', known);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('handles many small JSON strings within a budget', () => {
    const text = `[${rep('"ab",', 200_000)}"ab"]`;
    const start = performance.now();
    redactBody(text, 'application/json', new KnownValues());
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('fixes from the second A2 review', () => {
  it('redacts a digit-led value after a quoted name whole, unless it’s a whole JSON number', () => {
    for (const [text, expected] of <Array<[string, string]>>[
      ['"api_key": 4f3c2a1b9d8e7f60', `"api_key": ${REDACTED}`],
      ["'secret'=12ab34cd56ef", `'secret'=${REDACTED}`],
      ['"password": 1234-5678-abcd', `"password": ${REDACTED}`],
      ['{"pin": 123456, "x": 1', `{"pin": "${REDACTED}", "x": 1`],
      ['{"pin": -1.5e3}', `{"pin": "${REDACTED}"}`],
      // After a single-quoted name, not JSON: redacted as it is.
      ["{'pin': 1234, 'x': 1}", `{'pin': ${REDACTED}, 'x': 1}`],
    ]) {
      expect(applySpans(text, assignmentSpans(text)), text).toBe(expected);
    }
  });

  it('leaves links, buttons and resource strings named for passwords alone', () => {
    const known = new KnownValues();
    const html =
      '<a name="password-reset">Reset your password</a><button name="csrf_token" value="tok12345">Log in</button><p>Reset your password</p>';
    expect(redact(html, 'text/html', known)).toBe(
      `<a name="password-reset">Reset your password</a><button name="csrf_token" value="${REDACTED}">Log in</button><p>Reset your password</p>`,
    );
    const xml =
      '<resources><string name="error_invalid_token">Your session token is invalid</string></resources>';
    expect(redact(xml, 'application/xml', known)).toBe(xml);
    expect(known.size).toBe(1);
  });

  it('doesn’t take text found through an attribute as a known value', () => {
    const known = new KnownValues();
    const xml = '<entry key="password">Abc123Xyz789</entry><note>Abc123Xyz789</note>';
    expect(redact(xml, 'application/xml', known)).toBe(
      `<entry key="password">${REDACTED}</entry><note>Abc123Xyz789</note>`,
    );
    expect(known.size).toBe(0);
  });

  it('redacts a set-cookie array and HAR-style header pairs', () => {
    expect(
      redactJson('{"set-cookie":["sid=abcdef123456; Path=/","b=2"],"other":["sid=abcdef123456; x"]}'),
    ).toBe(`{"set-cookie":["sid=${REDACTED}; Path=/","b=${REDACTED}"],"other":["sid=abcdef123456; x"]}`);
    expect(
      redactJson(
        '[{"name":"Cookie","value":"sid=s3cr3t1234"},{"name":"Authorization","value":"Token abc123"},{"name":"Accept","value":"*/*"}]',
      ),
    ).toBe(
      `[{"name":"Cookie","value":"sid=${REDACTED}"},{"name":"Authorization","value":"Token ${REDACTED}"},{"name":"Accept","value":"*/*"}]`,
    );
  });

  it('keeps long random base64 values as known values', () => {
    // A seeded generator: the same values every run.
    let seed = 42;
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const known = new KnownValues();
    for (let n = 0; n < 50; n++) {
      // The generator's high bits: its low ones repeat every 64.
      known.add(Array.from({ length: 2048 }, () => alphabet[(next() >> 16) % 64]).join(''));
    }
    expect(known.size).toBeGreaterThanOrEqual(45);
  });

  it('finds known values in binary multipart parts and in part headers', () => {
    const known = new KnownValues();
    known.add(SESSION);
    const b = 'B0und';
    const text = `--${b}\r\nContent-Disposition: form-data; name="f"; filename="${SESSION}.bin"\r\nContent-Type: application/octet-stream\r\n\r\nbin ${SESSION} bin\r\n--${b}--\r\n`;
    expect(redact(text, `multipart/form-data; boundary=${b}`, known)).not.toContain(SESSION);
  });

  it('keeps a secret’s or key’s numeric id, but a session’s id is the secret', () => {
    expect(
      redactJson(
        '{"secret":{"id":42},"api_keys":[{"id":17,"key":"k1k2k3k4k5"}],"session":{"id":"s1s2s3s4s5"}}',
      ),
    ).toBe(`{"secret":{"id":42},"api_keys":[{"id":17,"key":"${REDACTED}"}],"session":{"id":"${REDACTED}"}}`);
  });

  it('reads CDATA after whitespace, and says when nested multipart stops being read', () => {
    expect(redact('<Password>\n  <![CDATA[x1]]></Password>', 'application/xml')).toBe(
      `<Password>\n  <![CDATA[${REDACTED}]]></Password>`,
    );
    let body = 'x';
    for (let i = 0; i < 3; i++) {
      body = `--b${i + 1}\r\nContent-Type: multipart/mixed; boundary=b${i}\r\n\r\n${body}\r\n--b${i + 1}--\r\n`;
    }
    expect(redactBody(body, 'multipart/mixed; boundary=b3').notScanned).toBe(
      'multipart nested more than two deep, read as text',
    );
  });

  it('stays quick on unclosed CDATA sections', () => {
    for (const [text, type] of [
      [rep('<Password><![CDATA[', 100_000), 'application/xml'],
      [rep('<textarea name="password"><![CDATA[', 60_000), 'text/html'],
    ] as const) {
      const start = performance.now();
      redactBody(text, type);
      expect(performance.now() - start).toBeLessThan(1500);
    }
  });
});

describe('minors from the final A2 check', () => {
  it('records header redactions under the header’s name', () => {
    expect(redactBody('{"set-cookie":["a=1"]}', 'application/json').records).toEqual([
      { name: 'set-cookie', count: 1 },
    ]);
    expect(redactBody('[{"name":"Cookie","value":"a=1"}]', 'application/json').records).toEqual([
      { name: 'Cookie', count: 1 },
    ]);
  });

  it('reads CDATA followed by whitespace before the closing tag', () => {
    expect(redact('<Password>\n<![CDATA[x1]]>\n</Password>', 'application/xml')).toBe(
      `<Password>\n<![CDATA[${REDACTED}]]>\n</Password>`,
    );
  });

  it('redacts a one-token XML property named for a password, not words', () => {
    const known = new KnownValues();
    expect(
      redact('<property name="hibernate.connection.password">hunter2zz</property>', 'application/xml', known),
    ).toBe(`<property name="hibernate.connection.password">${REDACTED}</property>`);
    expect(known.size).toBe(0);
    const words = '<string name="error_invalid_token">Your session token is invalid</string>';
    expect(redact(words, 'application/xml')).toBe(words);
  });
});
