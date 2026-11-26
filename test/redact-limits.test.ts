/**
 * Values past the rules' 4 KB limits, and private keys written on one line or escaped twice. A rule
 * that reads a named value only so far used to give up, or redact only the first 4 KB, when the
 * value ran longer: a SAML response, a long token. Now it fails closed: the whole value is
 * redacted, to where it ends or to the end of the text. Found by an independent review of 0.1.40
 * (F5 and F6).
 */
import { describe, expect, it } from 'vitest';
import { collectKnown, redactHarEntry } from '../src/backend/har-redact';
import { maskBytes } from '../src/backend/mask-body';
import { KnownValues, redactBody } from '../src/shared/redact-body';
import { applySpans, REDACTED, shapeSpans } from '../src/shared/redact';
import { expectGrowthUnder, timeOnce as once } from './timing';

// Fake secrets, built at run time so the file itself holds nothing a secret scanner flags.
const SECRET = 'Zq9x' + 'Tk7Lm2Pw4Rt8Vn6Yb3';
const rep = (s: string, n: number) => s.repeat(n);
const FILL = (n: number) => rep('B', n);
/** Token-like text: mixed case with digits, as a bearer token is. */
const TOKEN = (n: number) => rep('Ab1', Math.ceil(n / 3)).slice(0, n);

const redact = (text: string, type: string, options: { cut?: boolean } = {}) =>
  applySpans(text, redactBody(text, type, new KnownValues(), options).spans);

describe('values past the 4 KB limits', () => {
  it.each([
    ['SAMLResponse', 'application/xml'],
    ['Password', 'application/xml'],
    ['wsse:Password', 'text/xml'],
  ])('redacts a long <%s> element whole', (name, type) => {
    const text = `<r><${name}>${SECRET}${FILL(5_000)}${SECRET}</${name}><after>kept</after></r>`;
    const out = redact(text, type);
    expect(out).not.toContain(SECRET);
    expect(out).toBe(`<r><${name}>${REDACTED}</${name}><after>kept</after></r>`);
  });

  it('redacts a long CDATA section whole', () => {
    const text = `<Password><![CDATA[${FILL(5_000)}${SECRET}]]></Password><n>kept</n>`;
    expect(redact(text, 'application/xml')).toBe(`<Password><![CDATA[${REDACTED}]]></Password><n>kept</n>`);
  });

  it('redacts a CDATA section whose end falls across the 4 KB mark', () => {
    // The window read first ends inside `]]>`: the end is found by the search past it.
    for (let fill = 4_158; fill <= 4_164; fill++) {
      const text = `<Password><![CDATA[${FILL(fill)}]]></Password><n>kept</n>`;
      expect(redact(text, 'application/xml')).toBe(`<Password><![CDATA[${REDACTED}]]></Password><n>kept</n>`);
    }
  });

  it('redacts two long CDATA sections, each to its own end', () => {
    const text = `<Password><![CDATA[${FILL(5_000)}]]></Password><b>kept</b><Token><![CDATA[${FILL(5_000)}${SECRET}]]></Token><c>kept</c>`;
    expect(redact(text, 'application/xml')).toBe(
      `<Password><![CDATA[${REDACTED}]]></Password><b>kept</b><Token><![CDATA[${REDACTED}]]></Token><c>kept</c>`,
    );
  });

  it('redacts a long CDATA section to its end even when another element’s close follows', () => {
    const text = `<Password><![CDATA[${FILL(5_000)}${SECRET}]]>x</Password><n>kept</n>`;
    expect(redact(text, 'application/xml')).toBe(`<Password><![CDATA[${REDACTED}]]>x</Password><n>kept</n>`);
  });

  it('redacts a long unquoted attribute value whole, and reads the attributes after it', () => {
    const text = `<input name=csrf_token value=${FILL(5_000)}${SECRET} type=hidden><add key=token value=${SECRET}>`;
    expect(redact(text, 'text/html')).toBe(
      `<input name=csrf_token value=${REDACTED} type=hidden><add key=token value=${REDACTED}>`,
    );
  });

  it('doesn’t look for attributes inside a long unquoted value', () => {
    const text = `<input value=${FILL(5_000)}&password=x type=hidden>`;
    expect(redact(text, 'text/html')).toBe(text);
  });

  it('redacts a long element or CDATA that never closes, to the end', () => {
    for (const text of [
      `<r><Password>${FILL(5_000)}${SECRET}`,
      `<r><Password><![CDATA[${FILL(5_000)}${SECRET}`,
    ]) {
      const out = redact(text, 'application/xml');
      expect(out).not.toContain(SECRET);
      expect(out.endsWith(REDACTED)).toBe(true);
    }
  });

  it('redacts a long quoted value whole, to its closing quote', () => {
    for (const quote of ['"', "'"]) {
      const text = `token: ${quote}${FILL(4_200)}${SECRET}${quote}, next: kept`;
      expect(redact(text, 'text/plain')).toBe(`token: ${quote}${REDACTED}${quote}, next: kept`);
    }
  });

  it('redacts a long quoted value with escaped quotes in it whole', () => {
    const text = `password = "${FILL(4_200)}\\"${SECRET}" kept`;
    expect(redact(text, 'text/plain')).toBe(`password = "${REDACTED}" kept`);
  });

  it('redacts a long quoted value whose escaped quote falls on the 4 KB mark', () => {
    for (let fill = 4_093; fill <= 4_097; fill++) {
      const text = `token: "${FILL(fill)}\\"${FILL(200)}${SECRET}" kept`;
      expect(redact(text, 'text/plain')).toBe(`token: "${REDACTED}" kept`);
    }
  });

  it('redacts a long quoted value that never closes, to the line break or the end', () => {
    expect(redact(`token: "${FILL(4_200)}${SECRET}\nnext line`, 'text/plain')).toBe(
      `token: "${REDACTED}\nnext line`,
    );
    expect(redact(`token: "${FILL(4_200)}${SECRET}`, 'text/plain')).toBe(`token: "${REDACTED}`);
  });

  it('redacts a long unquoted value whole', () => {
    const text = `password=${FILL(4_200)}${SECRET} kept&other=1`;
    expect(redact(text, 'text/plain')).toBe(`password=${REDACTED} kept&other=1`);
  });

  it('redacts a long bearer token whole', () => {
    for (const text of [
      `bearer ${TOKEN(4_100)}${SECRET} kept`,
      `Authorization: Bearer ${TOKEN(4_100)}${SECRET}== kept`,
      `?q=bearer+${TOKEN(4_100)}${SECRET}&kept=1`,
    ]) {
      const out = applySpans(text, shapeSpans(text));
      expect(out).not.toContain(SECRET);
      expect(out).toContain('kept');
      expect(out).not.toContain('Ab1');
      expect(out).not.toContain('==');
    }
  });

  it('redacts a long bearer token whose first 4 KB look like a word', () => {
    // The check (a digit, or mixed case) is skipped for a value at its bound: it fails closed.
    const text = `bearer ${rep('a', 4_096)}${SECRET} kept`;
    expect(applySpans(text, shapeSpans(text))).toBe(`bearer ${REDACTED} kept`);
  });

  it('redacts long Basic credentials whose colon comes after the first 4 KB', () => {
    const value = btoa(`${rep('u', 3_075)}:${SECRET}`);
    const text = `Authorization: Basic ${value} kept`;
    expect(applySpans(text, shapeSpans(text))).toBe(`Authorization: Basic ${REDACTED} kept`);
  });

  it('redacts a bearer token at its bound with padding, and keeps what follows', () => {
    const text = `bearer ${TOKEN(4_094)}== kept`;
    expect(applySpans(text, shapeSpans(text))).toBe(`bearer ${REDACTED} kept`);
  });

  it('redacts long Basic credentials whole', () => {
    const value = btoa(`user:${FILL(3_300)}${SECRET}`);
    expect(value.length).toBeGreaterThan(4_096);
    const text = `Authorization: Basic ${value} kept`;
    expect(applySpans(text, shapeSpans(text))).toBe(`Authorization: Basic ${REDACTED} kept`);
  });

  it('redacts values just under and just over 4,096 characters alike', () => {
    for (const length of [4_095, 4_096, 4_097]) {
      const value = FILL(length - SECRET.length) + SECRET;
      expect(redact(`token: "${value}" kept`, 'text/plain')).toBe(`token: "${REDACTED}" kept`);
      expect(redact(`password=${value} kept`, 'text/plain')).toBe(`password=${REDACTED} kept`);
      expect(redact(`<Password>${value}</Password>`, 'application/xml')).toBe(
        `<Password>${REDACTED}</Password>`,
      );
      const bearer = `bearer ${TOKEN(length - SECRET.length)}${SECRET} kept`;
      expect(applySpans(bearer, shapeSpans(bearer))).toBe(`bearer ${REDACTED} kept`);
    }
  });

  it('still leaves a short unclosed quote at the end alone, unless the body was cut there', () => {
    const text = `var token = "${SECRET}`;
    expect(redact(text, 'application/javascript')).toBe(text);
    expect(redact(text, 'application/javascript', { cut: true })).toBe(`var token = "${REDACTED}`);
  });

  it('still leaves a short unclosed quote alone, and reads the assignments after it', () => {
    const text = `password: "it\napiKey = '${SECRET}'`;
    expect(redact(text, 'text/plain')).toBe(`password: "it\napiKey = '${REDACTED}'`);
  });

  it('still leaves a long element alone when another element follows it, as a short one is', () => {
    const text = `<Password>${FILL(5_000)}<b>bold</b></Password>`;
    expect(redact(text, 'application/xml')).toBe(text);
    const short = `<Password>abc<b>bold</b></Password>`;
    expect(redact(short, 'application/xml')).toBe(short);
  });

  it('keeps what follows a long bearer token and a long quoted value', () => {
    const text = `x bearer ${TOKEN(5_000)} then token: "${FILL(5_000)}" and password=${FILL(5_000)} end`;
    expect(redact(text, 'text/plain')).toBe(
      `x bearer ${REDACTED} then token: "${REDACTED}" and password=${REDACTED} end`,
    );
  });
});

describe('private keys on one line or escaped twice', () => {
  const BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' + SECRET + 'QUJD';

  it.each([
    ['on one line', `-----BEGIN PRIVATE KEY----- ${BODY} -----END PRIVATE KEY-----`],
    ['on one line, in parts', `-----BEGIN PRIVATE KEY----- ${BODY} ${BODY} -----END PRIVATE KEY-----`],
    ['escaped twice', `-----BEGIN PRIVATE KEY-----\\\\n${BODY}\\\\n-----END PRIVATE KEY-----`],
    ['escaped three times', `-----BEGIN PRIVATE KEY-----\\\\\\n${BODY}\\\\\\n-----END PRIVATE KEY-----`],
    [
      'escaped twice, CRLF',
      `-----BEGIN PRIVATE KEY-----\\\\r\\\\n${BODY}\\\\r\\\\n-----END PRIVATE KEY-----`,
    ],
    [
      'escaped twice, in lines',
      `-----BEGIN PRIVATE KEY-----\\\\n${BODY}\\\\n${BODY}\\\\n-----END PRIVATE KEY-----`,
    ],
    ['with a tab', `-----BEGIN RSA PRIVATE KEY-----\t${BODY}\t-----END RSA PRIVATE KEY-----`],
    ['with its line breaks taken out', `-----BEGIN PRIVATE KEY-----${BODY}${BODY}-----END PRIVATE KEY-----`],
    ['in a continued shell line', `-----BEGIN PRIVATE KEY-----\\\n${BODY}\\\n-----END PRIVATE KEY-----`],
    [
      'with Unicode-escaped breaks',
      `-----BEGIN PRIVATE KEY-----\\u000a${BODY}\\u000d\\u000a-----END PRIVATE KEY-----`,
    ],
    ['with escaped slashes', `-----BEGIN PRIVATE KEY-----\\n${BODY}\\/${BODY}\\n-----END PRIVATE KEY-----`],
    [
      'encrypted, on one line',
      `-----BEGIN RSA PRIVATE KEY----- Proc-Type: 4,ENCRYPTED DEK-Info: AES-128-CBC,ABCDEF ${BODY} -----END RSA PRIVATE KEY-----`,
    ],
  ])('redacts a key %s, keeping its BEGIN and END lines', (_what, text) => {
    const out = applySpans(text, shapeSpans(text));
    expect(out).not.toContain(SECRET);
    expect(out).toMatch(/^-----BEGIN [A-Z ]*PRIVATE KEY-----\[redacted\]-----END [A-Z ]*PRIVATE KEY-----$/);
  });

  it('redacts a key on one line inside JSON', () => {
    const text = `{"key":"-----BEGIN PRIVATE KEY----- ${BODY} -----END PRIVATE KEY-----","n":"kept"}`;
    const out = redact(text, 'application/json');
    expect(out).not.toContain(SECRET);
    expect(out).toContain('"n":"kept"');
  });

  it('redacts a key past 16 KB whole', () => {
    const long = rep('A', 20_000) + SECRET;
    const text = `-----BEGIN PRIVATE KEY-----\n${long}\n-----END PRIVATE KEY-----`;
    expect(applySpans(text, shapeSpans(text))).toBe(
      `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`,
    );
  });

  it.each([
    ['prose naming a key', '-----BEGIN PRIVATE KEY----- is the first line of a key file.'],
    ['a short run after the BEGIN line', `-----BEGIN PRIVATE KEY----- ${rep('A', 31)} and more`],
    ['a one-line public key', `-----BEGIN PUBLIC KEY----- ${BODY} -----END PUBLIC KEY-----`],
    ['a BEGIN line then a word', `-----BEGIN PRIVATE KEY----- ${rep('A', 31)}.`],
    ['a backslash that is not a line break', `-----BEGIN PRIVATE KEY-----\\\\t${BODY}`],
    ['a word after the BEGIN line', '-----BEGIN PRIVATE KEY-----Note: keep this file safe.'],
    ['a short run with no space', `-----BEGIN PRIVATE KEY-----${rep('A', 31)}.`],
  ])('leaves %s alone', (_what, text) => {
    expect(shapeSpans(text)).toEqual([]);
  });

  it('keeps a one-line key’s span to its END line, not past it', () => {
    const text = `-----BEGIN PRIVATE KEY----- ${BODY} -----END PRIVATE KEY----- then words`;
    expect(applySpans(text, shapeSpans(text))).toBe(
      `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY----- then words`,
    );
  });
});

describe('where it shows', () => {
  const LONG_XML = `<r><Password>${FILL(5_000)}${SECRET}</Password></r>`;
  const ONE_LINE_KEY = `{"key":"-----BEGIN PRIVATE KEY----- MIIEvQIBADANBgkqhkiG9w0BAQEF${SECRET} -----END PRIVATE KEY-----"}`;

  it('in a redacted HAR export', () => {
    for (const [text, mimeType] of [
      [LONG_XML, 'application/xml'],
      [ONE_LINE_KEY, 'application/json'],
    ] as const) {
      const entry = {
        startedDateTime: '2026-11-25T00:00:00.000Z',
        time: 1,
        request: { method: 'GET', url: 'https://api.example/x', httpVersion: 'HTTP/1.1', headers: [] },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          headers: [],
          content: { size: text.length, mimeType, text },
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
      expect(json).toContain(REDACTED);
    }
  });

  it('with Hide Secrets and to agents (the masked body)', () => {
    for (const [text, mimeType] of [
      [LONG_XML, 'application/xml'],
      [ONE_LINE_KEY, 'application/json'],
    ] as const) {
      const masked = maskBytes(new TextEncoder().encode(text), mimeType, false, new KnownValues());
      expect('bytes' in masked).toBe(true);
      const shown = new TextDecoder().decode((masked as { bytes: Uint8Array }).bytes);
      expect(shown).not.toContain(SECRET);
    }
  });
});

describe('time', () => {
  it.each([
    ['long elements', (n: number) => rep(`<Password>${FILL(4_200)}`, n / 1_000), 'application/xml'],
    [
      'long unclosed CDATA',
      (n: number) => rep(`<Password><![CDATA[${FILL(4_200)}`, n / 1_000),
      'application/xml',
    ],
    ['long unclosed quotes', (n: number) => rep(`token: '${FILL(4_200)}`, n / 1_000), 'text/plain'],
    ['long quotes, one kind', (n: number) => rep(`token: "${FILL(4_200)}`, n / 1_000), 'text/plain'],
    ['long unquoted values', (n: number) => rep(`password=${FILL(4_200)}`, n / 1_000), 'text/plain'],
    ['bearers in one long run', (n: number) => rep(`+bearer+${TOKEN(20)}`, n / 10), 'text/plain'],
    ['basics in one long run', (n: number) => rep(`+basic+dXNlcjpwYXNz`, n / 10), 'text/plain'],
    [
      'one-line BEGIN lines',
      (n: number) => rep(`-----BEGIN PRIVATE KEY----- ${rep('A', 40)} `, n / 50),
      'text/plain',
    ],
    [
      'escaped BEGIN lines',
      (n: number) => rep(`-----BEGIN PRIVATE KEY-----\\\\n${rep('A', 40)}`, n / 50),
      'text/plain',
    ],
    [
      'backslashes after BEGIN',
      (n: number) => '-----BEGIN PRIVATE KEY-----' + rep('\\', n * 10),
      'text/plain',
    ],
    ['a long key', (n: number) => '-----BEGIN PRIVATE KEY-----\n' + rep('A', n * 10), 'text/plain'],
  ])('stays linear on %s', { timeout: 60_000 }, (_what, make, type) => {
    const run = (text: string) => () => redactBody(text, type, new KnownValues());
    let n = 2_000;
    run(make(n))();
    while (once(run(make(n))) < 10 && make(n).length < 2_000_000) n *= 2;
    expectGrowthUnder(run(make(n)), run(make(n * 8)), 20);
  });
});
