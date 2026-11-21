/**
 * Masking a body for the window (src/backend/mask-body.ts): its text with secrets replaced, and
 * the bytes that held them, in every encoding the window or HAR export reads.
 */
import { describe, expect, it } from 'vitest';
import {
  byteRanges,
  cutUtf8Tail,
  decodeForMask,
  HIDDEN_BINARY,
  HIDDEN_UNREADABLE,
  maskBytes,
  maskFormatted,
  MAX_LITERALS,
} from '../src/backend/mask-body';
import { KnownValues } from '../src/shared/redact-body';

// Fake tokens, built at run time so the file itself holds nothing a secret scanner flags.
const ACCESS = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const BEARER = 'mK7vQ2xZ' + '9pLw4RtY8nB3';
const PASSWORD = 'hunter2' + 'Correct9Horse';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const known = (...values: string[]): KnownValues => {
  const k = new KnownValues();
  for (const v of values) k.add(v);
  return k;
};

type Shown = Exclude<ReturnType<typeof maskBytes>, { hidden: string }>;
function shown(result: ReturnType<typeof maskBytes>): Shown {
  if ('hidden' in result) throw new Error(`hidden: ${result.hidden}`);
  return result;
}

/** What each range of the original bytes held, as UTF-8. */
const held = (bytes: Uint8Array, ranges: Array<[number, number]>): string[] =>
  ranges.map(([s, e]) => Buffer.from(bytes.subarray(s, e)).toString('utf8'));

describe('maskBytes: UTF-8 text', () => {
  it('replaces a secret in JSON and overwrites its bytes, and only those', () => {
    const body = utf8(JSON.stringify({ access_token: ACCESS, n: 1 }));
    const result = shown(maskBytes(body, 'application/json', false, new KnownValues()));
    expect(result.text).toBe('{"access_token":"[redacted]","n":1}');
    expect(held(body, result.ranges)).toEqual([ACCESS]);
    const [start, end] = result.ranges[0]!;
    expect([...result.bytes.subarray(start, end)].every((b) => b === 0x2a)).toBe(true);
    // Everything else is as it was.
    expect(Buffer.from(result.bytes.subarray(0, start)).equals(Buffer.from(body.subarray(0, start)))).toBe(
      true,
    );
    expect(Buffer.from(result.bytes.subarray(end)).equals(Buffer.from(body.subarray(end)))).toBe(true);
    // The body passed in isn't changed.
    expect(Buffer.from(body).toString()).toContain(ACCESS);
  });

  it('counts bytes right after two-, three- and four-byte characters', () => {
    const text = `é€😀 password=${PASSWORD} ✓ token ${ACCESS}`;
    const body = utf8(text);
    const result = shown(maskBytes(body, 'text/plain', false, known(ACCESS)));
    expect(held(body, result.ranges)).toEqual([PASSWORD, ACCESS]);
    expect(result.text).toBe('é€😀 password=[redacted] ✓ token [redacted]');
  });

  it('covers a secret holding characters of every width', () => {
    const value = 'pä€😀ss' + 'W0rdX9q';
    const body = utf8(`a=1&password=${encodeURIComponent(value)}&b=2`);
    const result = shown(maskBytes(body, 'application/x-www-form-urlencoded', false, new KnownValues()));
    expect(held(body, result.ranges)).toEqual([encodeURIComponent(value)]);
    const raw = utf8(`password=${value} rest`);
    const plain = shown(maskBytes(raw, 'text/plain', false, new KnownValues()));
    expect(held(raw, plain.ranges)).toEqual([value]);
  });

  it('keeps a BOM, so offsets match the bytes', () => {
    const body = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(`{"access_token":"${ACCESS}"}`)]);
    const result = shown(maskBytes(body, 'application/json', false, new KnownValues()));
    expect(result.text).toBe('﻿{"access_token":"[redacted]"}');
    expect(held(body, result.ranges)).toEqual([ACCESS]);
  });

  it('reads a cut body up to its last whole character, and masks a secret to the very end', () => {
    // Cut partway through "é" (0xc3 0xa9), right after a token.
    const body = new Uint8Array([...utf8(`token ${ACCESS}`), 0xc3]);
    const result = shown(maskBytes(body, 'text/plain', true, known(ACCESS + 'é')));
    expect(result.text).toBeDefined();
    const cut = shown(
      maskBytes(utf8(`password=${PASSWORD}é`).subarray(0, -1), 'text/plain', true, new KnownValues()),
    );
    // The value runs on into the cut-off character's byte.
    const bytes = utf8(`password=${PASSWORD}é`).subarray(0, -1);
    expect(cut.ranges).toEqual([[9, bytes.length]]);
    expect(cut.bytes[bytes.length - 1]).toBe(0x2a);
  });

  it('finds a value known from elsewhere', () => {
    const body = utf8(`hello ${BEARER} there`);
    const result = shown(maskBytes(body, 'text/plain', false, known(BEARER)));
    expect(result.text).toBe('hello [redacted] there');
  });

  it('reads gRPC that decodes as text by the text rules, not as unchecked', () => {
    const body = utf8(`\u0000\u0000\u0000\u0000 password=${PASSWORD}`);
    const result = shown(maskBytes(body, 'application/grpc', false, new KnownValues()));
    expect(held(body, result.ranges)).toEqual([PASSWORD]);
  });

  it('leaves a body with nothing secret as it was: the same bytes, no ranges', () => {
    const body = utf8(JSON.stringify({ code: 'E_NOT_FOUND', page: 2, message: 'no such user' }));
    const result = shown(maskBytes(body, 'application/json', false, new KnownValues()));
    expect(result.ranges).toEqual([]);
    expect(result.bytes).toBe(body);
    expect(result.text).toBe(new TextDecoder().decode(body));
    expect(result.binary).toBeUndefined();
  });
});

describe('maskBytes: text that isn’t UTF-8', () => {
  it('masks Latin-1 by bytes, with no text for the window', () => {
    const body = Buffer.concat([
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20]),
      Buffer.from(`password=${PASSWORD}`),
    ]);
    const result = shown(maskBytes(body, 'text/plain; charset=iso-8859-1', false, new KnownValues()));
    expect(result.text).toBeUndefined();
    expect(result.ranges).toEqual([[14, 14 + PASSWORD.length]]);
    expect(Buffer.from(result.bytes).toString('latin1')).toBe(`café password=${'*'.repeat(PASSWORD.length)}`);
  });

  it('masks UTF-16 with a BOM at two bytes a character', () => {
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`password=${PASSWORD}`, 'utf16le')]);
    const result = shown(maskBytes(body, 'text/plain', false, new KnownValues()));
    expect(result.text).toBeUndefined();
    // The BOM is a character: the value starts at character 10, byte 20.
    expect(result.ranges).toEqual([[20, 20 + PASSWORD.length * 2]]);
    expect(Buffer.from(result.bytes).subarray(2).toString('utf16le')).toBe(
      `password=${'⨪'.repeat(PASSWORD.length)}`,
    );
  });

  it('masks UTF-16 cut after half a character', () => {
    const whole = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`password=${PASSWORD}xy`, 'utf16le'),
    ]);
    const body = whole.subarray(0, whole.length - 1);
    const result = shown(maskBytes(body, 'text/plain', true, new KnownValues()));
    // To the end, the half character too.
    expect(result.ranges).toEqual([[20, body.length]]);
  });

  it('doesn’t read Latin-1 into a type that isn’t text', () => {
    const body = Buffer.concat([Buffer.from([0xff, 0x00, 0xe9]), Buffer.from(`password=${PASSWORD}`)]);
    const result = shown(maskBytes(body, 'application/octet-stream', false, new KnownValues()));
    expect(result.binary).toBe(true);
    expect(result.ranges).toEqual([]);
  });
});

describe('maskBytes: UTF-16 without a BOM, and text it can’t read', () => {
  const secretBytes = (bytes: Uint8Array, ranges: Array<[number, number]>, encoding: BufferEncoding) =>
    ranges.map(([s, e]) => Buffer.from(bytes.subarray(s, e)).toString(encoding));

  it('reads ASCII in UTF-16LE as UTF-16, though it’s valid UTF-8 too, whatever its type', () => {
    for (const type of [
      'application/x-www-form-urlencoded',
      'text/plain; charset=utf-16le',
      'application/octet-stream',
    ]) {
      const body = Buffer.from(`user=bob&password=${PASSWORD}`, 'utf16le');
      const result = shown(maskBytes(body, type, false, new KnownValues()));
      expect(secretBytes(body, result.ranges, 'utf16le'), type).toEqual([PASSWORD]);
      expect(Buffer.from(result.bytes).toString('utf16le'), type).not.toContain(PASSWORD);
    }
  });

  it('reads UTF-16BE, and finds a known value in it', () => {
    const body = Buffer.from(`hello ${BEARER} there`, 'utf16le').swap16();
    const result = shown(maskBytes(body, 'text/plain; charset=utf-16be', false, known(BEARER)));
    expect(result.ranges).toEqual([[12, 12 + BEARER.length * 2]]);
    expect(Buffer.from(result.bytes).swap16().toString('utf16le')).not.toContain(BEARER);
  });

  it('hides text said to be UTF-16 that can’t be read so', () => {
    // Odd length, not cut.
    const odd = Buffer.concat([Buffer.from(`password=${PASSWORD}`, 'utf16le'), Buffer.from([0x41])]);
    expect(maskBytes(odd, 'text/plain; charset=utf-16le', false, new KnownValues())).toEqual({
      hidden: HIDDEN_UNREADABLE,
    });
    // UTF-16 with no order to be found.
    expect(
      maskBytes(Buffer.from(`password=${PASSWORD}`), 'text/plain; charset=utf-16', false, new KnownValues()),
    ).toEqual({
      hidden: HIDDEN_UNREADABLE,
    });
  });

  it('hides text full of NULs in no pattern, but shows such bytes of a type that isn’t text', () => {
    const body = Buffer.from(
      `\u0000\u0000\u0000ab\u0000\u0000cd\u0000\u0000\u0000password=${PASSWORD}\u0000\u0000\u0000\u0000\u0000`,
    );
    expect(maskBytes(body, 'text/plain', false, new KnownValues())).toEqual({ hidden: HIDDEN_UNREADABLE });
    expect(shown(maskBytes(body, 'application/octet-stream', false, new KnownValues())).binary).toBe(true);
  });

  it('still reads UTF-8 with a stray NUL as UTF-8 text', () => {
    const body = utf8(`a\u0000 b password=${PASSWORD} and more ordinary text here`);
    const result = shown(maskBytes(body, 'text/plain', false, new KnownValues()));
    expect(result.text).toBe('a\u0000 b password=[redacted] and more ordinary text here');
  });
});

describe('maskBytes: not text', () => {
  it('hides a body that holds a value known from elsewhere', () => {
    const body = Buffer.concat([Buffer.from([0, 1, 0xff]), Buffer.from(BEARER), Buffer.from([0xfe])]);
    expect(maskBytes(body, 'application/octet-stream', false, known(BEARER))).toEqual({
      hidden: HIDDEN_BINARY,
    });
  });

  it('shows one that doesn’t, unchecked', () => {
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xfe, 0xfd, 1, 2]);
    const result = shown(maskBytes(body, 'image/png', false, known(BEARER)));
    expect(result).toMatchObject({ binary: true, ranges: [] });
    expect(result.bytes).toBe(body);
  });
});

describe('cutUtf8Tail', () => {
  it('counts the bytes of a character cut off at the end', () => {
    expect(cutUtf8Tail(utf8('abcé').subarray(0, -1))).toBe(1);
    expect(cutUtf8Tail(utf8('ab€').subarray(0, -1))).toBe(2);
    expect(cutUtf8Tail(utf8('ab€').subarray(0, -2))).toBe(1);
    expect(cutUtf8Tail(utf8('a😀').subarray(0, -1))).toBe(3);
  });

  it('is 0 when the last character is whole, or there are no bytes', () => {
    expect(cutUtf8Tail(utf8('abc'))).toBe(0);
    expect(cutUtf8Tail(utf8('abé'))).toBe(0);
    expect(cutUtf8Tail(utf8('a😀'))).toBe(0);
    expect(cutUtf8Tail(new Uint8Array())).toBe(0);
  });
});

describe('decodeForMask and byteRanges', () => {
  it('doesn’t read a body cut mid-character as UTF-8 unless told it was cut', () => {
    const bytes = utf8('abcé').subarray(0, -1);
    expect(decodeForMask(bytes, 'text/plain', true)).toMatchObject({
      text: 'abc',
      encoding: 'utf8',
      length: 3,
    });
    expect(decodeForMask(bytes, 'text/plain', false)).toMatchObject({ encoding: 'latin1' });
    expect(decodeForMask(bytes, 'application/octet-stream', false)).toBeUndefined();
  });

  it('gives no ranges for no spans, and spans at the very start and end', () => {
    expect(byteRanges('héllo', [], 'utf8')).toEqual([]);
    expect(
      byteRanges(
        'é😀x',
        [
          { start: 0, end: 1, kind: 'k' },
          { start: 3, end: 4, kind: 'k' },
        ],
        'utf8',
      ),
    ).toEqual([
      [0, 2],
      [6, 7],
    ]);
    expect(byteRanges('abc', [{ start: 1, end: 2, kind: 'k' }], 'latin1')).toEqual([[1, 2]]);
    expect(byteRanges('abc', [{ start: 1, end: 2, kind: 'k' }], 'utf16be')).toEqual([[2, 4]]);
  });
});

describe('maskFormatted', () => {
  it('masks again what was masked in the raw body, wherever formatting left it', () => {
    // Found in the raw body as a value known from elsewhere; the formatted text is masked with no
    // known values, so only the raw body's literals can find it.
    const raw = `var c={"other":"${ACCESS}"};`;
    const result = shown(maskBytes(utf8(raw), 'application/javascript', false, known(ACCESS)));
    expect(result.literals).toEqual([ACCESS]);
    const formatted = `var c = {\n  "other": "${ACCESS}"\n};`;
    expect(maskFormatted(formatted, 'application/javascript', result.literals, new KnownValues())).toBe(
      'var c = {\n  "other": "[redacted]"\n};',
    );
  });

  it('also applies the rules and known values to the formatted text', () => {
    const formatted = `<a>\n  <password>${PASSWORD}</password>\n  <b>${BEARER}</b>\n</a>`;
    const out = maskFormatted(formatted, 'application/xml', [], known(BEARER))!;
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain(BEARER);
  });

  it('masks a short value only where it stands alone', () => {
    expect(maskFormatted('x = ab1;\ny = "ab12"', 'application/javascript', ['ab1'], new KnownValues())).toBe(
      'x = [redacted];\ny = "ab12"',
    );
  });

  it('gives up, rather than show some, with too many values to look for', () => {
    const many = Array.from({ length: MAX_LITERALS + 1 }, (_, i) => `value${i}x`);
    expect(maskFormatted('anything', 'text/plain', many, new KnownValues())).toBeUndefined();
    const short = Array.from({ length: 33 }, (_, i) => `${i}`);
    expect(maskFormatted('anything', 'text/plain', short, new KnownValues())).toBeUndefined();
  });

  it('gives up, rather than run long, on a body built to make matching slow', () => {
    const literal = 'a'.repeat(60_000);
    expect(maskFormatted('a'.repeat(1_000_000), 'text/plain', [literal], new KnownValues())).toBeUndefined();
  });

  it('finds many values that start alike, as a page of tokens has', () => {
    const tokens = Array.from({ length: 40 }, (_, i) => `eyJh${i}Zq9Xw8Vu7Ts6`);
    const out = maskFormatted(tokens.join('\n'), 'text/plain', tokens, new KnownValues())!;
    expect(out).toBe(tokens.map(() => '[redacted]').join('\n'));
  });

  it('joins values that overlap', () => {
    expect(
      maskFormatted('x abcdefgh1234zz y', 'text/plain', ['abcdefgh1234', 'cdefgh1234zz'], new KnownValues()),
    ).toBe('x [redacted] y');
  });

  it('leaves formatted text with nothing secret as it was', () => {
    const formatted = 'function f() {\n  return 1;\n}';
    expect(maskFormatted(formatted, 'application/javascript', [], new KnownValues())).toBe(formatted);
  });
});
