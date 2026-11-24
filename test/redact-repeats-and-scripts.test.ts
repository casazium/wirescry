/**
 * Three leaks found by an independent review of 0.1.40: a secret repeated outside a named field in
 * a redacted HAR, secrets in scripts, and what a user typed in a rule reaching agents by its label.
 */
import { describe, expect, it } from 'vitest';
import { collectKnown, redactHarEntry } from '../src/backend/har-redact';
import { Reader } from '../src/backend/mcp/reader';
import { maskFields } from '../src/backend/mask-body';
import { KnownValues, redactBody } from '../src/shared/redact-body';
import { applySpans } from '../src/shared/redact';
import type { ExchangeSummary } from '../src/shared/api';
import { describeRuleEnded } from '../src/shared/failure';

// Fake secrets, built at run time so the file itself holds nothing a secret scanner flags.
const SECRET = 'Zq9x' + 'Tk7Lm2Pw4Rt8Vn6Yb3';
const OTHER = 'Hb4c' + 'Ws1Dj6Fg9Kp2Mx5Nz8';

type Json = Record<string, unknown>;

function harEntry(request: Json = {}, response: Json = {}): Json {
  return {
    startedDateTime: '2026-11-23T00:00:00.000Z',
    time: 1,
    request: {
      method: 'GET',
      url: 'https://api.example/ok',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Authorization', value: `Bearer ${SECRET}` }],
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: 0,
      ...request,
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [],
      cookies: [],
      content: { size: 0, mimeType: 'text/plain' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 0,
      ...response,
    },
    cache: {},
    timings: { send: 0, wait: 1, receive: 0 },
  };
}

const META = { cut: { request: false, response: false }, base64Frames: [] };

function redacted(...entries: Json[]): Array<{ entry: Json; values: number }> {
  const known = new KnownValues();
  for (const entry of entries) collectKnown(entry, known);
  return entries.map((entry) => {
    const out = redactHarEntry(entry, META as never, known) as unknown as { entry: Json; values: number };
    return out;
  });
}

const headersOf = (entry: Json, side: 'request' | 'response'): Array<{ name: string; value: string }> =>
  (entry[side] as { headers: Array<{ name: string; value: string }> }).headers;

describe('a redacted HAR hides a repeated secret everywhere', () => {
  it('in the URL path, and in the query list rebuilt from it', () => {
    const [out] = redacted(
      harEntry({ url: `https://api.example/users/${SECRET}/profile?who=${SECRET}&page=2` }),
    );
    const request = out!.entry.request as { url: string; queryString: unknown };
    expect(request.url).toBe('https://api.example/users/[redacted]/profile?who=[redacted]&page=2');
    expect(JSON.stringify(request.queryString)).not.toContain(SECRET);
    expect(JSON.stringify(request.queryString)).toContain('page');
  });

  it('in other request and response headers, and the redirect', () => {
    const [out] = redacted(
      harEntry(
        {
          headers: [
            { name: 'Authorization', value: `Bearer ${SECRET}` },
            { name: 'X-Echo', value: SECRET },
          ],
        },
        { status: 302, headers: [{ name: 'Location', value: `/next/${SECRET}` }] },
      ),
    );
    expect(headersOf(out!.entry, 'request')[1]!.value).toBe('[redacted]');
    expect(headersOf(out!.entry, 'response')[0]!.value).toBe('/next/[redacted]');
    expect((out!.entry.response as { redirectURL: string }).redirectURL).toBe('/next/[redacted]');
    expect(JSON.stringify(out!.entry)).not.toContain(SECRET);
  });

  it('in a header’s name, trailers, and the method', () => {
    const [out] = redacted(
      harEntry(
        {
          method: SECRET,
          headers: [
            { name: 'Authorization', value: `Bearer ${SECRET}` },
            { name: `x-${SECRET}`, value: 'plain' },
          ],
          _trailers: [{ name: 'x-trailer', value: SECRET }],
        },
        { _trailers: [{ name: 'x-done', value: SECRET }] },
      ),
    );
    expect(JSON.stringify(out!.entry)).not.toContain(SECRET);
    expect((out!.entry.request as { method: string }).method).toBe('[redacted]');
    expect(headersOf(out!.entry, 'request')[1]!.value).toBe('plain');
  });

  it('when the secret was named in a different entry, before or after', () => {
    const named = harEntry();
    const repeat = harEntry({ url: `https://api.example/u/${SECRET}`, headers: [] });
    for (const order of [
      [named, repeat],
      [repeat, named],
    ]) {
      for (const out of redacted(...order)) expect(JSON.stringify(out.entry)).not.toContain(SECRET);
    }
  });

  it('counts those places in what it reports', () => {
    const without = redacted(harEntry())[0]!;
    const withRepeat = redacted(harEntry({ url: `https://api.example/u/${SECRET}` }))[0]!;
    expect(withRepeat.values).toBeGreaterThan(without.values);
  });

  it('when it’s joined to other text by a dash, underscore or letter', () => {
    const [out] = redacted(
      harEntry(
        {
          url: `https://api.example/u/user_${SECRET}/x/${SECRET}-v2?token_${SECRET}=abc`,
          headers: [
            { name: 'Authorization', value: `Bearer ${SECRET}` },
            { name: 'X-Echo', value: `id-${SECRET}` },
            { name: 'Cookie', value: `sess_${SECRET}=1` },
          ],
        },
        { status: 302, headers: [{ name: 'Location', value: `/cb/tok-${SECRET}` }] },
      ),
    );
    expect(JSON.stringify(out!.entry)).not.toContain(SECRET);
    expect(headersOf(out!.entry, 'request')[1]!.value).toBe('id-[redacted]');
    expect(headersOf(out!.entry, 'response')[0]!.value).toBe('/cb/tok-[redacted]');
  });

  it('in what it records about where it redacted', () => {
    const [out] = redacted(
      harEntry({
        url: `https://api.example/a?token.${SECRET}=abc`,
        headers: [
          { name: 'Authorization', value: `Bearer ${SECRET}` },
          { name: `X-Auth-${SECRET}`, value: 'v1' },
        ],
      }),
    );
    expect(JSON.stringify(out!.entry)).not.toContain(SECRET);
    expect(JSON.stringify(out!.entry._wirescryRedactions)).toContain('[redacted]');
  });

  it('when this entry’s own body named it', () => {
    const request = harEntry({
      method: 'POST',
      url: `https://a.example/u/${OTHER}`,
      headers: [{ name: 'X-Echo', value: OTHER }],
      postData: { mimeType: 'application/json', text: JSON.stringify({ password: OTHER }) },
    });
    const [sent] = redacted(request);
    expect(JSON.stringify(sent!.entry)).not.toContain(OTHER);
    const response = harEntry(
      { headers: [] },
      {
        status: 302,
        headers: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Location', value: `/n/${OTHER}` },
        ],
        content: { size: 1, mimeType: 'application/json', text: JSON.stringify({ access_token: OTHER }) },
      },
    );
    const [got] = redacted(response);
    expect(JSON.stringify(got!.entry)).not.toContain(OTHER);
  });

  it('with spaces written as + in a query', () => {
    const value = 'Zq9x+Tk7Lm2+Pw4Rt8Vn6';
    const [out] = redacted(
      harEntry({ url: `https://api.example/a?password=${value}&q=${value}`, headers: [] }),
    );
    expect(JSON.stringify(out!.entry)).not.toContain('Tk7Lm2');
  });

  it('in the fields Wirescry copies as they are', () => {
    const entry = harEntry({ httpVersion: SECRET }, { httpVersion: SECRET });
    entry.startedDateTime = SECRET;
    entry._wirescryFailure = { kind: SECRET, code: 'X', message: 'm' };
    entry._wirescrySource = { kind: SECRET, id: SECRET, label: SECRET };
    entry._webSocketMessages = [{ type: SECRET, time: 1, opcode: 1, data: 'hello' }];
    const [out] = redacted(entry);
    expect(JSON.stringify(out!.entry)).not.toContain(SECRET);
  });

  it('in a body’s media type', () => {
    const type = `text/plain; b=${SECRET}`;
    const [out] = redacted(
      harEntry(
        {
          method: 'POST',
          headers: [
            { name: 'Authorization', value: `Bearer ${SECRET}` },
            { name: 'Content-Type', value: type },
          ],
          postData: { mimeType: type, text: 'hello' },
        },
        {
          headers: [{ name: 'Content-Type', value: type }],
          content: { size: 5, mimeType: type, text: 'hello' },
        },
      ),
    );
    expect(JSON.stringify(out!.entry)).not.toContain(SECRET);
    expect((out!.entry.request as { postData: { mimeType: string } }).postData.mimeType).toContain(
      'text/plain',
    );
  });

  it('joined to other text in the status text, errors and notes', () => {
    const entry = harEntry({}, { statusText: `OK-${SECRET}` });
    entry._error = `e-${SECRET}`;
    entry.comment = `c_${SECRET}`;
    entry._wirescryRule = `r-${SECRET}`;
    entry._wirescryFailure = {
      kind: 'other',
      code: `c-${SECRET}`,
      message: `m-${SECRET}`,
      detail: `d-${SECRET}`,
    };
    const [out] = redacted(entry);
    expect(JSON.stringify(out!.entry)).not.toContain(SECRET);
  });

  it('joined to other text and percent-encoded', () => {
    const value = 'Zq9x+Tk7L/m2Pw4Rt8Vn6Y==';
    const [out] = redacted(
      harEntry({
        url: `https://api.example/u/id-${encodeURIComponent(value)}/x`,
        headers: [{ name: 'Authorization', value: `Bearer ${value}` }],
      }),
    );
    expect((out!.entry.request as { url: string }).url).toBe('https://api.example/u/id-[redacted]/x');
  });

  it('among many tokens from one issuer, without calling the list full', () => {
    // The same header, and a longer payload of its own, as real tokens have.
    const tokens = Array.from(
      { length: 12 },
      (_, i) => `eyJhbGci.Ab${i}Cd${i}Ef${i}Gh${i}Ij${i}Kl${i}Mn${i}Op${i}.Sg${i}`,
    );
    const known = new KnownValues();
    for (const token of tokens) known.add(token);
    expect(known.anywhere(`/cb/id_${tokens[11]}/x`)).toHaveLength(1);
    expect(known.full).toBe(false);
  });

  it('hides a field whole rather than stall on text built to nearly match', () => {
    const known = new KnownValues();
    for (let i = 0; i < 8; i++) known.add(`${'a1'.repeat(2000)}Z${i}a1a1a1a1`);
    const text = 'a1'.repeat(100_000);
    let fastest = Infinity;
    let spans: unknown;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      spans = known.anywhere(text);
      fastest = Math.min(fastest, performance.now() - started);
    }
    expect(fastest).toBeLessThan(1500);
    expect(spans).toEqual([{ start: 0, end: text.length, kind: 'known value' }]);
  });

  it('isn’t blanked by another host’s values that merely end like its URL', () => {
    const long = Array.from({ length: 17 }, (_, i) => ({
      name: `X-Token-${i}`,
      value: `Q${i}w${'e4Rt'.repeat(1000)}.example`,
    }));
    const short = Array.from({ length: 100 }, (_, i) => ({
      name: `X-Secret-${i}`,
      value: `Kp${i}Zx9Lm4Vb7Nc2Qw/api/v1/`,
    }));
    for (const headers of [long, short]) {
      const url = 'https://shop.example/api/v1/orders?page=2';
      const [, victim] = redacted(harEntry({ headers }), harEntry({ url, headers: [] }));
      expect((victim!.entry.request as { url: string }).url).toBe(url);
    }
  });

  it('leaves everything else as it was', () => {
    const [out] = redacted(
      harEntry(
        {
          method: 'POST',
          url: 'https://api.example/users/42?page=2',
          headers: [{ name: 'Accept', value: 'application/json' }],
        },
        { headers: [{ name: 'Location', value: '/next/42' }] },
      ),
    );
    const request = out!.entry.request as { method: string; url: string };
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.example/users/42?page=2');
    expect(headersOf(out!.entry, 'request')).toEqual([{ name: 'Accept', value: 'application/json' }]);
    expect(headersOf(out!.entry, 'response')).toEqual([{ name: 'Location', value: '/next/42' }]);
  });

  it('doesn’t hide a different value', () => {
    const [out] = redacted(harEntry({ url: `https://api.example/u/${OTHER}` }));
    expect((out!.entry.request as { url: string }).url).toContain(OTHER);
  });

  it('keeps a method it can’t read as absent, not as text', () => {
    const entry = harEntry();
    delete (entry.request as Json).method;
    const [out] = redacted(entry);
    expect((out!.entry.request as Json).method).toBeUndefined();
  });
});

describe('Hide Secrets and agents hide a repeated secret in short fields', () => {
  const taught = (): KnownValues => {
    const known = new KnownValues();
    known.add(SECRET);
    return known;
  };

  it('joined to other text in a URL, a header and a host', () => {
    const [url, header, host] = maskFields(
      [
        { kind: 'url', value: `https://a.example/u/user_${SECRET}/x?who=id-${SECRET}&page=2` },
        { kind: 'header', name: 'x-echo', value: `id-${SECRET}` },
        { kind: 'host', value: `x-${SECRET}.example` },
      ],
      taught(),
    );
    expect(url).toBe('https://a.example/u/user_[redacted]/x?who=id-[redacted]&page=2');
    expect(header).toBe('id-[redacted]');
    expect(host).toBe('x-[redacted].example');
  });

  it('with spaces written as + in a URL', () => {
    const known = new KnownValues();
    known.add('Zq9x Tk7Lm2 Pw4Rt8Vn6');
    const [url] = maskFields([{ kind: 'url', value: 'https://a.example/?q=Zq9x+Tk7Lm2+Pw4Rt8Vn6' }], known);
    expect(url).not.toContain('Tk7Lm2');
  });

  it('leaves a different value alone', () => {
    const [url, header] = maskFields(
      [
        { kind: 'url', value: `https://a.example/u/user_${OTHER}` },
        { kind: 'header', name: 'x-echo', value: `id-${OTHER}` },
      ],
      taught(),
    );
    expect(url).toContain(OTHER);
    expect(header).toContain(OTHER);
  });
});

const masked = (text: string, type: string): string => applySpans(text, redactBody(text, type).spans);
const CODE_TYPES = ['application/javascript', 'text/javascript'];

describe('secrets in scripts', () => {
  const quoted = [
    `window.__S={"accessToken":"${SECRET}"}`,
    `cb({"password":"${SECRET}"})`,
    `var password="${SECRET}";`,
    `const api_key = '${SECRET}';`,
    `init({client_secret: "${SECRET}"})`,
    `JSON.parse("{\\"accessToken\\":\\"${SECRET}\\"}")`,
    `self.push([1,"{\\"name\\":\\"x\\",\\"password\\" : \\"${SECRET}\\",\\"a\\":1}"])`,
  ];

  for (const code of quoted) {
    it(`hides it in JavaScript: ${code.replace(SECRET, '…').slice(0, 40)}`, () => {
      for (const type of CODE_TYPES) expect(masked(code, type)).not.toContain(SECRET);
    });

    it(`hides it in an inline script: ${code.replace(SECRET, '…').slice(0, 40)}`, () => {
      expect(masked(`<html><script>${code}</script></html>`, 'text/html')).not.toContain(SECRET);
    });
  }

  it('hides only the value, so the code around it reads the same', () => {
    expect(masked(`var password="${SECRET}"; run();`, 'text/javascript')).toBe(
      'var password="[redacted]"; run();',
    );
    expect(masked(`f("{\\"token\\":\\"${SECRET}\\",\\"page\\":\\"two\\"}")`, 'text/javascript')).toBe(
      'f("{\\"token\\":\\"[redacted]\\",\\"page\\":\\"two\\"}")',
    );
  });

  it('hides a number under a quoted secret name', () => {
    expect(masked('x={"password":123456789}', 'text/javascript')).not.toContain('123456789');
  });

  it('records nothing for an empty escaped value', () => {
    expect(redactBody('f("{\\"token\\":\\"\\"}")', 'text/javascript').spans).toEqual([]);
  });

  it('hides a long escaped value whole', () => {
    const long = 'A1b2'.repeat(2000);
    const out = masked(`f("{\\"token\\":\\"${long}\\"}")`, 'text/javascript');
    expect(out).toBe('f("{\\"token\\":\\"[redacted]\\"}")');
  });

  const moreForms = [
    `const token = \`${SECRET}\`;`,
    `init({apiKey:\`${SECRET}\`})`,
    `f("{\\"password\\":\\"ab\\\\\\"${SECRET}\\"}")`,
  ];
  for (const form of moreForms) {
    it(`hides it in: ${form.replace(SECRET, '…').slice(0, 34)}`, () => {
      for (const type of CODE_TYPES) expect(masked(form, type)).not.toContain(SECRET);
      expect(masked(`<script>${form}</script>`, 'text/html')).not.toContain(SECRET);
    });
  }

  it('hides JSON in an HTML attribute, however its quotes are written', () => {
    for (const quote of ['&quot;', '&#34;', '&#x22;', '&#X22;']) {
      const page = `<div data-page="{${quote}token${quote}:${quote}${SECRET}${quote},${quote}a${quote}:1}"></div>`;
      const out = masked(page, 'text/html');
      expect(out).not.toContain(SECRET);
      expect(out).toContain(`${quote}a${quote}:1`);
    }
  });

  it('leaves ordinary JSON in an attribute alone', () => {
    const page = '<div data-page="{&quot;color&quot;:&quot;blue-value-1234&quot;}"></div>';
    expect(masked(page, 'text/html')).toBe(page);
  });

  it('hides a value cut off at the end of what was kept', () => {
    const body = `f("{\\"token\\":\\"${SECRET}`;
    const out = applySpans(body, redactBody(body, 'text/javascript', undefined, { cut: true }).spans);
    expect(out).not.toContain(SECRET);
    expect(masked(body, 'text/javascript')).toBe(body);
  });

  it('never runs past the string a value is in', () => {
    const quoteEnds = 'var s="\\"password\\":\\"" + p; var a=1; function f(){ return g("x\\"y"); }';
    expect(masked(quoteEnds, 'text/javascript')).toBe(quoteEnds);
    const lineEnds = 'f("\\"password\\":\\"abc\n1234567890\\"")';
    expect(masked(lineEnds, 'text/javascript')).toBe(lineEnds);
  });

  it('needs a secret’s name, the real string, and no substitution', () => {
    const lines = [
      'f("\\"password\\":\\"Abcd1234efgh"+x+"\\"y")',
      'f("{\\"color\\":\\"Abcd1234efgh\\"}")',
      'const token=`${value1234}`;',
    ];
    for (const line of lines) {
      for (const type of CODE_TYPES) expect(masked(line, type)).toBe(line);
    }
  });

  it('reads escaped pairs only inside a script, and entity pairs only to their own quote', () => {
    const outside = '<p>\\"token\\":\\"Abcd1234efgh\\"</p>';
    expect(masked(outside, 'text/html')).toBe(outside);
    const crossing = '<div a="&quot;token&quot;:&quot;Abcd1234efgh" b="x&quot;"></div>';
    expect(masked(crossing, 'text/html')).toBe(crossing);
  });

  it('finds a value learned after it last looked, joined to other text', () => {
    const known = new KnownValues();
    known.add(SECRET);
    expect(known.anywhere(`id-${OTHER}`)).toEqual([]);
    known.add(OTHER);
    expect(known.anywhere(`id-${OTHER}`)).toHaveLength(1);
  });

  it('leaves URL-building code whole', () => {
    const lines = [
      'var u="/cb?access_token="+encodeURIComponent(tok)+"&v=2";',
      'x.open("GET","/a?token="+this.getToken()+"&r="+Math.random());',
      "var b='password='+encodeURIComponent(p.value)+'&user='+u;",
      "var c='a=1&secret='+value1234+'&b=2';",
      "var d='secret='+value1234+'x';",
      'f("/a?token=",value1234,"x");',
      'var s={password:"abc(123)def"};',
    ];
    for (const line of lines) {
      for (const type of CODE_TYPES) expect(masked(line, type)).toBe(line);
    }
  });

  it('leaves values that name a form of input alone', () => {
    for (const line of ['x={password:"current-password"}', 'x={token:"application/json"}']) {
      expect(masked(line, 'text/javascript')).toBe(line);
    }
  });

  it('reads backslashes before a closing quote as the string does', () => {
    const closes = `f("{\\"token\\":\\"${SECRET}\\\\\\\\\\"}")`;
    expect(masked(closes, 'text/javascript')).not.toContain(SECRET);
    const inner = `f("{\\"token\\":\\"ab\\\\\\"${SECRET}\\"}")`;
    expect(masked(inner, 'text/javascript')).not.toContain(SECRET);
  });

  it('hides any value cut off at the end of what was kept', () => {
    const bodies: Array<[string, string]> = [
      [`var password="${SECRET}`, 'text/javascript'],
      [`var token=\`${SECRET}`, 'text/javascript'],
      [`<script>var password="${SECRET}`, 'text/html'],
      [`<div data-page="{&quot;token&quot;:&quot;${SECRET}`, 'text/html'],
    ];
    for (const [body, type] of bodies) {
      const out = applySpans(body, redactBody(body, type, undefined, { cut: true }).spans);
      expect(out).not.toContain(SECRET);
      expect(masked(body, type)).toBe(body);
    }
  });

  it('keeps reading after a long value in a cut body', () => {
    const body = `var a=1;var password="${'x1'.repeat(2100)}";var b=2;var token="${SECRET}";var c="tail`;
    const out = applySpans(body, redactBody(body, 'text/javascript', undefined, { cut: true }).spans);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('var b=2');
  });

  it('reads a quote inside an entity-quoted value as part of it', () => {
    const page = `<div a="{&quot;token&quot;:&quot;ab\\&quot;${SECRET}&quot;}"></div>`;
    expect(masked(page, 'text/html')).not.toContain(SECRET);
  });

  it('leaves the words a program is full of readable', () => {
    const lines = [
      'fetch(u,{credentials:"include"});',
      'fetch(u,{credentials:"same-origin"});',
      'var t={password:"Password",forgotPassword:"Forgot your password?"};',
      'x={pin:"left"};',
      'x={signature:"(a: string) => void"};',
      'var o={"pin":1};',
      'var c=`${prefix}`, token=`${value}`;',
    ];
    for (const line of lines) {
      for (const type of CODE_TYPES) expect(masked(line, type)).toBe(line);
    }
    expect(masked('.p{pin:"z"}', 'text/css')).toBe('.p{pin:"z"}');
  });

  const code = [
    'const password = getValueFromStore123;',
    'password: e.target(value)',
    'token = nextToken(state);',
    'if (password === confirmValue) submit();',
    'const secret = process.env.APP_VALUE;',
    'var password="";',
    'f("{\\"token\\":\\"\\"}")',
    'f("{\\"token\\":\\"null\\"}")',
    'f("{\\"color\\":\\"blue\\"}")',
    'var color="blue-value-1234";',
    'f("{\\"token\\":\\"unclosed',
  ];
  for (const line of code) {
    it(`leaves code alone: ${line.slice(0, 40)}`, () => {
      for (const type of CODE_TYPES) expect(masked(line, type)).toBe(line);
      const page = `<script>${line}</script>`;
      expect(masked(page, 'text/html')).toBe(page);
    });
  }

  it('doesn’t read an escaped pair outside a script as code', () => {
    const page = `<p>\\"token\\":\\"plainwords\\"</p>`;
    expect(masked(page, 'text/html')).toContain('plainwords');
  });

  it('still masks outside a script as before', () => {
    expect(masked(`<script>run()</script><p>password: ${SECRET}</p>`, 'text/html')).toBe(
      '<script>run()</script><p>password: [redacted]</p>',
    );
  });

  it('stays linear on hostile scripts', () => {
    const inputs = [
      '\\"token\\":\\"'.repeat(80_000),
      '\\"color\\":\\"'.repeat(80_000),
      `${'\\"token\\":\\"a\\",'.repeat(50_000)}`,
    ];
    for (const input of inputs) {
      let fastest = Infinity;
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        redactBody(input, 'text/javascript');
        fastest = Math.min(fastest, performance.now() - started);
      }
      expect(fastest).toBeLessThan(3000);
    }
  });

  it('holds through what agents and the window read', () => {
    const [body] = maskFields(
      [{ kind: 'body', contentType: 'text/html', value: `<script>x={"password":"${SECRET}"}</script>` }],
      new KnownValues(),
    );
    expect(body).not.toContain(SECRET);
  });
});

describe('what a rule’s label says, for an agent', () => {
  const summary = (id: string, label?: string): ExchangeSummary =>
    ({
      id,
      method: 'GET',
      protocol: 'https',
      httpVersion: '1.1',
      host: 'api.test',
      path: '/a',
      url: 'https://api.test/a',
      startedAt: 1,
      ...(label !== undefined ? { handledBy: { plugin: 'pro', ruleId: 'r', label } } : {}),
    }) as ExchangeSummary;
  const LABEL = 'GET api.test/a ?team=internal-billing → http://10.1.2.3:9000';

  const reader = (list: ExchangeSummary[]): Reader =>
    new Reader({
      list: () => list,
      summaries: () => list,
      exchanges: () => list,
      detail: (id: string) => ({ summary: list.find((e) => e.id === id) }),
      maskFields: async (fields: Array<{ value: string }>) => ({
        ok: true,
        fields: fields.map((f) => f.value),
        full: false,
      }),
    } as never);

  it('says a rule handled it, never what the rule says', async () => {
    const out = await reader([summary('a', LABEL), summary('b')]).list(undefined, 50, undefined);
    const text = JSON.stringify(out);
    expect(text).not.toContain('internal-billing');
    expect(text).not.toContain('10.1.2.3');
    const byId = new Map(out.exchanges.map((e) => [e.id, e]));
    expect(byId.get('a')!.handledByRule).toBe(true);
    expect(byId.get('b')!.handledByRule).toBeUndefined();
  });

  it('doesn’t quote it when a rule ended the request', async () => {
    const ended = {
      ...summary('a', LABEL),
      failure: describeRuleEnded(LABEL),
    } as ExchangeSummary;
    const r = reader([
      ended,
      { ...summary('b'), failure: { kind: 'other', code: 'X', message: 'keep this' } } as ExchangeSummary,
    ]);
    const out = await r.list(undefined, 50, undefined);
    expect(JSON.stringify(out)).not.toContain('internal-billing');
    const byId = new Map(out.exchanges.map((e) => [e.id, e]));
    expect(byId.get('a')!.failure!.message).toBe('A rule ended this request without a response.');
    expect(byId.get('b')!.failure!.message).toBe('keep this');
  });

  it('can’t be searched for what a label says', async () => {
    const out = await reader([summary('a', LABEL)]).list('rule~internal-billing', 50, undefined);
    expect(out.exchanges).toEqual([]);
  });
});
