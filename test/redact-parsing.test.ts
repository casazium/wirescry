/**
 * Bodies the parsers used to read wrong, showing a secret: a `>` inside a quoted HTML attribute,
 * a comment between an XML element's text and its close tag, a multipart part's header folded onto
 * more lines, and a text file uploaded with a type that isn't text (`.env` as octet-stream). Found
 * by an independent review of 0.1.40 (F7, the body-parsing rows).
 */
import { describe, expect, it } from 'vitest';
import { collectKnown, redactHarEntry } from '../src/backend/har-redact';
import { maskBytes } from '../src/backend/mask-body';
import { KnownValues, redactBody } from '../src/shared/redact-body';
import { applySpans, REDACTED } from '../src/shared/redact';
import { expectGrowthUnder, timeOnce as once } from './timing';

// Fake secrets, built at run time so the file itself holds nothing a secret scanner flags.
const SECRET = 'Zq9x' + 'Tk7Lm2Pw4Rt8Vn6Yb3';
const R = REDACTED;
const rep = (s: string, n: number) => s.repeat(Math.max(0, Math.ceil(n)));

const redact = (text: string, type: string, known = new KnownValues()) =>
  applySpans(text, redactBody(text, type, known).spans);
const html = (text: string) => redact(text, 'text/html');
const xml = (text: string, known?: KnownValues) => redact(text, 'application/xml', known);

describe('a > inside a quoted HTML attribute', () => {
  it.each([
    [
      `<input name="csrf_token" data-x="a>b" value="${SECRET}">`,
      `<input name="csrf_token" data-x="a>b" value="${R}">`,
    ],
    [
      `<input data-x='a>b' name=csrf_token value="${SECRET}">`,
      `<input data-x='a>b' name=csrf_token value="${R}">`,
    ],
    [
      `<input data-x = "a>b" name="csrf_token" value="${SECRET}">`,
      `<input data-x = "a>b" name="csrf_token" value="${R}">`,
    ],
    [
      `<input\n  data-x="a>b"\n  name="csrf_token"\n  value="${SECRET}">`,
      `<input\n  data-x="a>b"\n  name="csrf_token"\n  value="${R}">`,
    ],
    [
      `<meta name="csrf-token" data-a="x>y" content="${SECRET}">`,
      `<meta name="csrf-token" data-a="x>y" content="${R}">`,
    ],
    [
      `<input type="password" data-a="1>0" value="${SECRET}">`,
      `<input type="password" data-a="1>0" value="${R}">`,
    ],
    [`<input data-a="1>0" password="${SECRET}">`, `<input data-a="1>0" password="${R}">`],
    // A tag before it with an apostrophe outside any value, and a `>` in a value.
    [
      `<p class=it's title="a>b">hi</p><input name="csrf_token" value="${SECRET}">`,
      `<p class=it's title="a>b">hi</p><input name="csrf_token" value="${R}">`,
    ],
    // A quote that doesn't close before the next `<` doesn't start a value: the next tag is still
    // read, even one with quotes of its own, and so is the rest of the tag it's in.
    [
      `<a title="open><input name="csrf_token" value="${SECRET}">`,
      `<a title="open><input name="csrf_token" value="${R}">`,
    ],
    [`<input name=csrf_token title="x value=${SECRET}><p>`, `<input name=csrf_token title="x value=${R}><p>`],
    [
      `<a title="open><input name=csrf_token value=${SECRET}>`,
      `<a title="open><input name=csrf_token value=${R}>`,
    ],
    // Quotes that pair up wrongly before the next `<`, or before the text's end: the tag ends at its
    // first `>`, as before.
    [
      `<input name=password value=${SECRET} title="> He said "hi"`,
      `<input name=password value=${R} title="> He said "hi"`,
    ],
    [
      `<input name=password value=${SECRET} title="> He said "hi" <br>`,
      `<input name=password value=${R} title="> He said "hi" <br>`,
    ],
    // A long tag, well past the 4 KB an element's attributes used to be read to.
    [
      `<input data-x="${rep('a', 200_000)}" name="csrf_token" value="${SECRET}">`,
      `<input data-x="${rep('a', 200_000)}" name="csrf_token" value="${R}">`,
    ],
  ])('redacts %s', (text, expected) => {
    expect(html(text)).toBe(expected);
  });

  it('reads an XML element’s attributes the same way', () => {
    expect(xml(`<entry key="password" note="x>y">${SECRET}</entry>`)).toBe(
      `<entry key="password" note="x>y">${R}</entry>`,
    );
  });

  it('reads a tag whose attributes are 256 KB, the most read, and not one longer', () => {
    const tag = (length: number) => {
      const head = ` name="csrf_token" value="${SECRET}" data-x="`;
      return `<input${head}${rep('a', length - head.length - 1)}">`;
    };
    expect(html(tag(262_144))).not.toContain(SECRET);
    expect(html(tag(262_145))).toContain(SECRET);
  });

  it.each([
    `<textarea name="password" />${SECRET}</textarea>`,
    `<textarea name=password/>${SECRET}</textarea>`,
    `<textarea name=password data-url=/a/>${SECRET}</textarea>`,
  ])('reads a textarea whose tag ends in `/>`, which HTML ignores: %s', (text) => {
    expect(html(text)).not.toContain(SECRET);
  });

  it('reads attributes past 4 KB in an XML element', () => {
    const text = `<entry note="${rep('n', 5_000)}" key="password">${SECRET}</entry>`;
    expect(xml(text)).toBe(`<entry note="${rep('n', 5_000)}" key="password">${R}</entry>`);
  });

  it.each([
    `<input name="q" data-x="a>b" value="${SECRET}">`,
    `<p data-x="password>x">${SECRET}</p>`,
    `<a href="/x?a>b">password</a>`,
    `<p title='a>b'>${SECRET}</p>`,
  ])('keeps %s', (text) => {
    expect(html(text)).toBe(text);
  });
});

describe('a comment in an XML element', () => {
  it.each([
    [`<Password>${SECRET}<!-- c --></Password>`, `<Password>${R}</Password>`],
    [`<Password><!-- c -->${SECRET}</Password>`, `<Password>${R}</Password>`],
    [
      `<Password> ${SECRET} <!-- a --> <!-- b --> </Password><n>keep</n>`,
      `<Password>${R}</Password><n>keep</n>`,
    ],
    // A comment holding what looks like the close tag.
    [`<Password>${SECRET}<!-- </Password> --></Password><n>keep</n>`, `<Password>${R}</Password><n>keep</n>`],
    [`<entry key="password">${SECRET}<!-- c --></entry>`, `<entry key="password">${R}</entry>`],
    [
      `<string name="api_token">${SECRET}<!-- set by CI --></string>`,
      `<string name="api_token">${R}</string>`,
    ],
    // An empty comment.
    [`<Password>${SECRET}<!----></Password>`, `<Password>${R}</Password>`],
    // A comment never closed: redacted to the text's end.
    [`<Password>${SECRET}<!-- unclosed </Password><n>more</n>`, `<Password>${R}`],
    [`<string name="api_token">${SECRET}<!-- unclosed`, `<string name="api_token">${R}`],
    // …however long the document after it.
    [`<string name="api_token">${SECRET}<!-- unclosed ${rep('x', 6_000)}`, `<string name="api_token">${R}`],
    // A comment first, then a long value; a body ending right after a CDATA section.
    [`<Password><!-- c -->${SECRET}${rep('A', 6_000)}</Password>`, `<Password>${R}</Password>`],
    [`<Password><![CDATA[${SECRET}]]>`, `<Password><![CDATA[${R}]]>`],
    // A comment never closed after a CDATA section.
    [
      `<Password><![CDATA[${SECRET}]]><!-- unclosed </Password>`,
      `<Password><![CDATA[${R}]]><!-- unclosed </Password>`,
    ],
    // A comment after a CDATA section.
    [
      `<Password><![CDATA[${SECRET}]]><!-- c --></Password>`,
      `<Password><![CDATA[${R}]]><!-- c --></Password>`,
    ],
    [
      `<Password><![CDATA[${SECRET}]]> <!-- a --><!-- b --> </Password>`,
      `<Password><![CDATA[${R}]]> <!-- a --><!-- b --> </Password>`,
    ],
    // In CDATA, `<!--` is just text.
    [`<Password><![CDATA[<!--${SECRET}-->]]></Password>`, `<Password><![CDATA[${R}]]></Password>`],
    // A quote pairing up wrongly in the element's own tag.
    [`<Password x=">${SECRET} "quoted" text</Password>`, `<Password x=">${R}</Password>`],
    // One long token with line breaks around it, named by `name=`.
    [
      `<property name="client_secret">\n  ${rep('Ab1', 1_800)}\n</property>`,
      `<property name="client_secret">${R}</property>`,
    ],
  ])('redacts %s', (text, expected) => {
    expect(xml(text)).toBe(expected);
  });

  it.each([
    '<Password><!-- only a comment --></Password>',
    '<string name="error_token">Your token<!-- x --> expired</string>',
    `<note>${SECRET}<!-- c --></note>`,
    // A self-closing element has no text: what follows isn't its.
    `<r><Password/>${SECRET}</Password></r>`,
    `<r><Password />${SECRET}</Password></r>`,
    // Something else before the close: not the element's text.
    `<Password>${SECRET}<b/></Password>`,
  ])('keeps %s', (text) => {
    expect(xml(text)).toBe(text);
  });

  it('learns CDATA text as written, with any `<!--` in it', () => {
    expect(
      xml(`<r><Password><![CDATA[<!--${SECRET}-->]]></Password><log><!--${SECRET}--></log></r>`),
    ).not.toContain(SECRET);
  });

  it('learns the value without the comment', () => {
    expect(xml(`<r><Password>${SECRET}<!-- c --></Password><log>${SECRET}</log></r>`)).toBe(
      `<r><Password>${R}</Password><log>${R}</log></r>`,
    );
  });
});

describe('a multipart part’s header folded onto more lines', () => {
  const MULTIPART = 'multipart/form-data; boundary=X';
  const part = (headers: string, body: string) => `--X\r\n${headers}\r\n\r\n${body}\r\n--X--\r\n`;

  it.each([
    ['a space', 'Content-Disposition: form-data;\r\n name="password"'],
    ['a tab', 'Content-Disposition: form-data;\r\n\tname="password"'],
    ['a bare line feed', 'Content-Disposition: form-data;\n name="password"'],
    ['two lines', 'Content-Disposition:\r\n form-data;\r\n  name="password"'],
  ])('redacts a secret field whose name follows %s', (_how, headers) => {
    expect(redact(part(headers, SECRET), MULTIPART)).toBe(part(headers, R));
  });

  it('reads a folded field named key', () => {
    const headers = 'Content-Disposition: form-data;\r\n name="key"';
    expect(redact(part(headers, SECRET), MULTIPART)).toBe(part(headers, R));
  });

  it('reads a folded Content-Type and filename', () => {
    const headers =
      'Content-Disposition: form-data; name="f";\r\n filename="a.json"\r\nContent-Type:\r\n application/json';
    // Read as JSON: under a secret-named object, a value named `value` is the secret.
    expect(redact(part(headers, `{"auth":{"value":"${SECRET}"}}`), MULTIPART)).toBe(
      part(headers, `{"auth":{"value":"${R}"}}`),
    );
  });

  it('reads a folded Content-Type that says a file isn’t text', () => {
    const headers =
      'Content-Disposition: form-data; name="f"; filename="a.bin"\r\nContent-Type:\r\n application/octet-stream';
    const result = redactBody(part(headers, '\x00\x01\x02binary'), MULTIPART, new KnownValues());
    expect(result.notScanned).toBe('a file part that isn’t text');
  });

  it('keeps a field whose other header, folded, says password', () => {
    const headers = 'Content-Disposition: form-data; name="note"\r\nX-Other: a;\r\n name="password"';
    expect(redact(part(headers, SECRET), MULTIPART)).toBe(part(headers, SECRET));
  });

  it('keeps a field whose next header, not folded, says password', () => {
    const headers = 'Content-Disposition: form-data; name="note"\r\nX-Name: name="password"';
    expect(redact(part(headers, SECRET), MULTIPART)).toBe(part(headers, SECRET));
  });
});

describe('a text file uploaded with a type that isn’t text', () => {
  const MULTIPART = 'multipart/form-data; boundary=X';
  const file = (name: string, type: string, body: string) =>
    `--X\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n${body}\r\n--X--\r\n`;

  it.each([
    ['.env', 'application/octet-stream', `PASSWORD=${SECRET}\nDEBUG=1`, `PASSWORD=${R}\nDEBUG=1`],
    ['.env', 'application/octet-stream', `export API_KEY="${SECRET}"`, `export API_KEY="${R}"`],
    ['.yaml', 'application/x-yaml', `db:\n  password: ${SECRET}\n`, `db:\n  password: ${R}\n`],
    ['.properties', 'application/octet-stream', `db.password=${SECRET}`, `db.password=${R}`],
  ])('reads %s sent as %s as text', (name, type, body, expected) => {
    const result = redactBody(file(name, type, body), MULTIPART, new KnownValues());
    expect(applySpans(file(name, type, body), result.spans)).toBe(file(name, type, expected));
    expect(result.notScanned).toBeUndefined();
  });

  it('still reads only token shapes in a file that isn’t text, and says so', () => {
    const body = `\x00\x01\x02PASSWORD=${SECRET}`;
    const result = redactBody(file('a.bin', 'application/octet-stream', body), MULTIPART, new KnownValues());
    expect(applySpans(file('a.bin', 'application/octet-stream', body), result.spans)).toContain(SECRET);
    expect(result.notScanned).toBe('a file part that isn’t text');
  });

  it('judges by the file’s first 4 KB', () => {
    const late = `PASSWORD=${SECRET}\n${rep('x', 5_000)}\x00`;
    const out = redact(file('a.env', 'application/octet-stream', late), MULTIPART);
    expect(out).not.toContain(SECRET);
    // A control character just inside the first 4 KB, and just past it.
    const head = `PASSWORD=${SECRET}\n`;
    const inside = head + rep('x', 4_095 - head.length) + '\x00';
    const past = head + rep('x', 4_096 - head.length) + '\x00';
    expect(redact(file('a.env', 'application/octet-stream', inside), MULTIPART)).toContain(SECRET);
    expect(redact(file('a.env', 'application/octet-stream', past), MULTIPART)).not.toContain(SECRET);
  });

  it.each([
    ['\\x0e', '\x0e'],
    ['\\x1a', '\x1a'],
    ['\\x1f', '\x1f'],
    ['\\x7f', '\x7f'],
    ['a replacement character', '\ufffd'],
  ])('takes a file with %s as binary', (_what, control) => {
    const body = `${control}PASSWORD=${SECRET}`;
    const result = redactBody(file('a.bin', 'application/octet-stream', body), MULTIPART, new KnownValues());
    expect(result.notScanned).toBe('a file part that isn’t text');
  });

  it('reads a colored log (ESC is allowed) as text', () => {
    const body = `\x1b[31mERROR\x1b[0m login failed PASSWORD=${SECRET}\n`;
    const out = redact(file('a.log', 'application/octet-stream', body), MULTIPART);
    expect(out).not.toContain(SECRET);
  });

  it('reads JSON in a file that reads as text', () => {
    const body = `{"auth":{"value":"${SECRET}"}}`;
    expect(redact(file('a.json', 'application/octet-stream', body), MULTIPART)).toBe(
      file('a.json', 'application/octet-stream', `{"auth":{"value":"${R}"}}`),
    );
  });
});

describe('where it shows', () => {
  const BODY = `<form><input name="csrf_token" data-x="a>b" value="${SECRET}"></form>`;

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
        content: { size: BODY.length, mimeType: 'text/html', text: BODY },
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
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).toContain(R);
  });

  const UPLOAD =
    '--X\r\nContent-Disposition: form-data;\r\n name="password"\r\n\r\n' +
    `${SECRET}\r\n--X\r\nContent-Disposition: form-data; name="f"; filename="a.env"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\nTOKEN=${SECRET}x\r\n--X--\r\n`;

  it('in a redacted HAR export of an upload', () => {
    const entry = {
      startedDateTime: '2026-11-26T00:00:00.000Z',
      time: 1,
      request: {
        method: 'POST',
        url: 'https://a.example/upload',
        httpVersion: 'HTTP/1.1',
        headers: [],
        postData: { mimeType: 'multipart/form-data; boundary=X', text: UPLOAD },
      },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [],
        content: { size: 0, mimeType: 'text/plain', text: '' },
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
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('with Hide Secrets and to agents (the masked body)', () => {
    for (const [text, type] of [
      [BODY, 'text/html'],
      [`<Password>${SECRET}<!-- c --></Password>`, 'application/xml'],
      [UPLOAD, 'multipart/form-data; boundary=X'],
    ] as const) {
      const masked = maskBytes(new TextEncoder().encode(text), type, false, new KnownValues());
      expect('bytes' in masked).toBe(true);
      expect(new TextDecoder().decode((masked as { bytes: Uint8Array }).bytes)).not.toContain(SECRET);
    }
  });
});

describe('time', () => {
  it.each([
    ['tags with quotes left open', (n: number) => rep('<a b="x>', n / 8), 'text/html'],
    ['tags with single quotes left open', (n: number) => rep("<a b='x>", n / 8), 'text/html'],
    ['one tag with many equals signs', (n: number) => '<a ' + rep('b= ', n / 3) + '>', 'text/html'],
    ['one tag with many quoted values', (n: number) => '<a ' + rep('b=">" ', n / 6) + '>', 'text/html'],
    ['a quote left open, then no tags', (n: number) => '<a b="' + rep('x', n), 'text/html'],
    // From 64 KB: below that, each element's own cost hides a search per element.
    [
      'elements with comments left open',
      (n: number) => rep('<Password>x<!--', n / 15),
      'application/xml',
      64_000,
    ],
    [
      'elements inside one comment',
      (n: number) => rep('<Password>x<!--', n / 15) + '--><!--',
      'application/xml',
      64_000,
    ],
    [
      'elements inside one comment, comments after',
      (n: number) => rep('<Password>x<!--', n / 30) + '-->' + rep('<!-- c -->', n / 20),
      'application/xml',
      64_000,
    ],
    [
      'textareas inside one comment',
      (n: number) => rep('<textarea name=password>x<!--', n / 30) + '--><!--',
      'text/html',
      64_000,
    ],
    [
      'elements inside one comment, a long tail after',
      (n: number) => rep('<Password>x<!--', n / 30) + '-->' + rep('y', n / 2),
      'application/xml',
      64_000,
    ],
    [
      'elements with comments',
      (n: number) => rep('<Password>x<!-- c --></Password>', n / 32),
      'application/xml',
    ],
    [
      'an element with many comments',
      (n: number) => '<Password>x' + rep('<!-- c -->', n / 10) + '</Password>',
      'application/xml',
    ],
    // Parts of folded headers, each well under the 16 KB a part's headers are looked for in.
    [
      'folded multipart headers',
      (n: number) =>
        rep(`--X\r\nContent-Disposition: form-data;${rep('\r\n ', 300)}name="a"\r\n\r\nv\r\n`, n / 1_000) +
        '--X--',
      'multipart/form-data; boundary=X',
    ],
  ])('stays linear on %s', { timeout: 60_000 }, (_what, make, type, from = 2_000) => {
    const run = (text: string) => () => redactBody(text, type, new KnownValues());
    let n = from;
    run(make(n))();
    while (once(run(make(n))) < 10 && make(n).length < 2_000_000) n *= 2;
    expectGrowthUnder(run(make(n)), run(make(n * 8)), 20);
  });
});
