/**
 * A scheme and a credential outside JSON: in plain text and YAML (`auth: ApiKey <key>`), where the
 * scheme was hidden and the key shown, and in scripts (`{"auth":"ApiKey <key>"}`), where the whole
 * value was shown. Found while reviewing the 0.1.42 release notes. Under a token name the
 * credential is hidden and the scheme kept, as in JSON; under a password or secret name the whole
 * value is hidden.
 */
import { describe, expect, it } from 'vitest';
import { collectKnown, redactHarEntry } from '../src/backend/har-redact';
import { maskBytes } from '../src/backend/mask-body';
import { KnownValues, redactBody } from '../src/shared/redact-body';
import { applySpans, REDACTED } from '../src/shared/redact';
import { expectGrowthUnder, timeOnce as once } from './timing';

// A fake secret, built at run time so the file itself holds nothing a secret scanner flags.
const SECRET = 'Zq9x' + 'Tk7Lm2Pw4Rt8Vn6Yb3';
const R = REDACTED;
const rep = (s: string, n: number) => s.repeat(Math.max(0, Math.ceil(n)));

const redact = (text: string, type: string) =>
  applySpans(text, redactBody(text, type, new KnownValues()).spans);
const text = (t: string) => redact(t, 'text/plain');
const js = (t: string) => redact(t, 'application/javascript');

describe('a scheme and a credential in plain text', () => {
  it.each([
    [`auth: ApiKey ${SECRET}\nnext: 1`, `auth: ApiKey ${R}\nnext: 1`],
    [`auth: ApiKey ${SECRET}`, `auth: ApiKey ${R}`],
    [`credentials: svc ${SECRET}\n`, `credentials: svc ${R}\n`],
    [`AUTH=ApiKey ${SECRET}`, `AUTH=ApiKey ${R}`],
    [`token: ApiKey\t${SECRET}  \r\nx: 1`, `token: ApiKey\t${R}  \r\nx: 1`],
    // Quoted, double or single.
    [`token = "ApiKey ${SECRET}"\n`, `token = "ApiKey ${R}"\n`],
    [`token = 'ApiKey ${SECRET}'\n`, `token = 'ApiKey ${R}'\n`],
    // A credential of 16 characters, the fewest; a scheme word of 32, the most.
    ['auth: ApiKey a1b2c3d4e5f6g7h8', `auth: ApiKey ${R}`],
    [`auth: ${rep('a', 32)} ${SECRET}`, `auth: ${rep('a', 32)} ${R}`],
    // Too long to judge.
    [`auth: x ${rep('b', 4_097)}`, `auth: x ${R}`],
  ])('hides the credential and keeps the scheme in %j', (input, expected) => {
    expect(text(input)).toBe(expected);
  });

  it('works in YAML', () => {
    expect(redact(`api:\n  auth: ApiKey ${SECRET}\n`, 'application/yaml')).toBe(
      `api:\n  auth: ApiKey ${R}\n`,
    );
  });

  it.each([
    // Under a password or secret name, both words go.
    [`password: correct ${SECRET}\n`, `password: ${R}\n`],
    [`client_secret: v1 ${SECRET}\n`, `client_secret: ${R}\n`],
    // Quoted, the whole value, as before.
    [`password = "My ${SECRET}"\n`, `password = "${R}"\n`],
  ])('hides both words under a password or secret name: %j', (input, expected) => {
    expect(text(input)).toBe(expected);
  });

  it.each([
    // More words after it: prose, left as before (the scheme word alone is hidden).
    [`auth: ApiKey ${SECRET} extra words\n`, `auth: ${R} ${SECRET} extra words\n`],
    // A credential of 15 characters, or without digits: not one.
    ['auth: ApiKey a1b2c3d4e5f6g7h\n', `auth: ${R} a1b2c3d4e5f6g7h\n`],
    ['auth: ApiKey abcdefghijklmnopqrst\n', `auth: ${R} abcdefghijklmnopqrst\n`],
  ])('leaves other text as before: %j', (input, expected) => {
    expect(text(input)).toBe(expected);
  });

  it.each([
    `note: ApiKey ${SECRET}\n`,
    // A scheme word of 33 characters is too long to be one; one starting with a digit isn't one.
    `auth: ${rep('a', 33)} ${SECRET}\n`,
    `auth: 2fa ${SECRET}\n`,
  ])('keeps the credential in %j', (input) => {
    expect(text(input)).toContain(SECRET);
  });

  it('leaves prose under a token name unchanged', () => {
    expect(text('auth: not required for this route\n')).toBe('auth: not required for this route\n');
  });

  it('keeps quoted prose under a token name whole-hidden, as before', () => {
    expect(text('token = "see the docs"\n')).toBe(`token = "${R}"\n`);
  });
});

describe('a token that only looks like a scheme', () => {
  const TOKEN = 'abc123' + 'DEF456ghi789';
  it.each([
    // A log line's next field is not a credential: the token is hidden, as before.
    [`token=${TOKEN} session=abcd1234efgh5678`, `token=${R} session=abcd1234efgh5678`],
    [
      `auth=${TOKEN} trace=0af7651916cd43dd8448eb211c80319c`,
      `auth=${R} trace=0af7651916cd43dd8448eb211c80319c`,
    ],
    // A first word distinctive enough to be a token: both words go.
    [`token = "${TOKEN} 550e8400-e29b-41d4-a716-446655440000"`, `token = "${R}"`],
    [`token: ${TOKEN} ${SECRET}\n`, `token: ${R}\n`],
  ])('hides the token in %j', (input, expected) => {
    expect(text(input)).toBe(expected);
  });

  it('hides both words in JSON too', () => {
    expect(redact(`{"auth":"${TOKEN} ${SECRET}"}`, 'application/json')).toBe(`{"auth":"${R}"}`);
  });

  it('leaves a short value and the next field alone', () => {
    const line = 'auth=ok request_id=0af7651916cd43dd8448eb211c80319c';
    expect(text(line)).toBe(line);
  });
});

describe('base64 padding and name=value after a scheme', () => {
  const B64 = 'dXNlcjpwYXNz' + 'd29yZDEyMzQ1Njc4OQ==';
  it.each([
    [`auth: ApiKey ${B64}\n`, `auth: ApiKey ${R}\n`, 'text/plain'],
    [`{"auth":"ApiKey ${B64}"}`, `{"auth":"ApiKey ${R}"}`, 'application/json'],
    [`{"auth":"ApiKey ${SECRET}="}`, `{"auth":"ApiKey ${R}"}`, 'application/json'],
    // In JSON a `name=value` credential is still one: there's no next field to mistake it for.
    [`{"auth":"ApiKey key=${SECRET}"}`, `{"auth":"ApiKey ${R}"}`, 'application/json'],
    [`var a = {auth: "ApiKey ${B64}"};`, `var a = {auth: "ApiKey ${R}"};`, 'application/javascript'],
  ])('hides the credential in %j', (input, expected, type) => {
    expect(redact(input, type)).toBe(expected);
  });

  it('keeps a lowercase word as a scheme in text: a known limit', () => {
    expect(text('token: correcthorsebatterystaple 550e8400-e29b-41d4-a716-446655440000\n')).toBe(
      `token: correcthorsebatterystaple ${R}\n`,
    );
  });
});

describe('where the credential may end', () => {
  it.each([
    [`{auth: ApiKey ${SECRET}}`, `{auth: ApiKey ${R}}`],
    [`auth: ApiKey ${SECRET};`, `auth: ApiKey ${R};`],
    [`auth: ApiKey ${SECRET}.\n`, `auth: ApiKey ${R}.\n`],
    [`auth: ApiKey ${SECRET}\rnext`, `auth: ApiKey ${R}\rnext`],
    // Up to 64 spaces between the scheme and the credential.
    [`auth: ApiKey${rep(' ', 64)}${SECRET}`, `auth: ApiKey${rep(' ', 64)}${R}`],
  ])('hides it in %j', (input, expected) => {
    expect(text(input)).toBe(expected);
  });

  it('does not reach across 65 spaces', () => {
    expect(text(`auth: ApiKey${rep(' ', 65)}${SECRET}`)).toContain(SECRET);
  });

  it('hides a quoted value too long to split whole', () => {
    const value = `ApiKey ${rep('A1', 2_100)}`;
    expect(text(`token = "${value}"`)).toBe(`token = "${R}"`);
  });
});

describe('in other kinds of text', () => {
  it.each([
    [
      'HTML outside a script',
      `<pre>auth: ApiKey ${SECRET}\n</pre>`,
      `<pre>auth: ApiKey ${R}\n</pre>`,
      'text/html',
    ],
    ['XML text', `<log>auth: ApiKey ${SECRET}\n</log>`, `<log>auth: ApiKey ${R}\n</log>`, 'application/xml'],
    [
      'an event stream',
      `data: auth: ApiKey ${SECRET}\n\n`,
      `data: auth: ApiKey ${R}\n\n`,
      'text/event-stream',
    ],
    [
      'a string in JSON',
      `{"log":"token = 'ApiKey ${SECRET}'"}`,
      `{"log":"token = 'ApiKey ${R}'"}`,
      'application/json',
    ],
  ])('hides it in %s', (_where, input, expected, type) => {
    expect(redact(input, type)).toBe(expected);
  });
});

describe('a scheme and a credential in a script', () => {
  it.each([
    [`const cfg = {"auth":"ApiKey ${SECRET}"};`, `const cfg = {"auth":"ApiKey ${R}"};`],
    [`var auth = 'Token ${SECRET}';`, `var auth = 'Token ${R}';`],
    [`headers = {token: "Bearer2 ${SECRET}"}`, `headers = {token: "Bearer2 ${R}"}`],
  ])('hides the credential and keeps the scheme in %j', (input, expected) => {
    expect(js(input)).toBe(expected);
  });

  it('works in an HTML page’s inline script', () => {
    expect(redact(`<script>headers = {auth: "ApiKey ${SECRET}"}</script>`, 'text/html')).toBe(
      `<script>headers = {auth: "ApiKey ${R}"}</script>`,
    );
  });

  it.each([
    'const msg = "auth token Hello world";',
    'var auth = "ApiKey short";',
    `var note = "ApiKey ${SECRET}";`,
    // In a URL's query string, as before.
    `fetch("/x?token=" + "ApiKey ${SECRET}")`,
    `fetch('/x?token="ApiKey ${SECRET}"')`,
  ])('keeps %j', (input) => {
    expect(js(input)).toBe(input);
  });
});

describe('where it shows', () => {
  const BODY = `auth: ApiKey ${SECRET}\n`;

  it('in a redacted HAR export', () => {
    const entry = {
      startedDateTime: '2026-11-26T00:00:00.000Z',
      time: 1,
      request: { method: 'GET', url: 'https://a.example/', httpVersion: 'HTTP/1.1', headers: [] },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [],
        content: { size: BODY.length, mimeType: 'text/plain', text: BODY },
      },
      timings: { send: 0, wait: 1, receive: 0 },
    };
    const known = new KnownValues();
    collectKnown(entry, known);
    const out = redactHarEntry(
      entry,
      { cut: { request: false, response: false }, base64Frames: [] } as never,
      known,
    );
    const json = JSON.stringify(out);
    expect(json).not.toContain(SECRET);
    expect(json).toContain(`ApiKey ${R}`);
  });

  it('with Hide Secrets and to agents (the masked body)', () => {
    for (const [body, type] of [
      [BODY, 'text/plain'],
      [`var auth = 'Token ${SECRET}';`, 'application/javascript'],
    ] as const) {
      const masked = maskBytes(new TextEncoder().encode(body), type, false, new KnownValues());
      expect('bytes' in masked).toBe(true);
      expect(new TextDecoder().decode((masked as { bytes: Uint8Array }).bytes)).not.toContain(SECRET);
    }
  });
});

describe('time', () => {
  it.each([
    ['a long credential', (n: number) => `auth: ApiKey ${rep('A1', n / 2)}\n`, 'text/plain'],
    ['many lines', (n: number) => rep(`auth: ApiKey ${SECRET}\n`, n / 30), 'text/plain'],
    ['spaces after the scheme', (n: number) => `auth: ApiKey${rep(' ', n)}x\n`, 'text/plain'],
    ['many scheme words', (n: number) => rep('auth: ApiKey ', n / 13), 'text/plain'],
    [
      'many quoted values in a script',
      (n: number) => rep(`a.auth = "ApiKey ${SECRET}";`, n / 40),
      'application/javascript',
    ],
    [
      'spaces before a script value',
      (n: number) => `var auth = "${rep(' ', n)}ApiKey ${SECRET}";`,
      'application/javascript',
    ],
  ])('stays linear on %s', { timeout: 60_000 }, (_what, make, type) => {
    const run = (input: string) => () => redactBody(input, type, new KnownValues());
    let n = 2_000;
    run(make(n))();
    while (once(run(make(n))) < 10 && make(n).length < 2_000_000) n *= 2;
    expectGrowthUnder(run(make(n)), run(make(n * 8)), 20);
  });
});
