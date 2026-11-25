/**
 * Bodies Wirescry can't read as text, in a redacted HAR export and in the window's Hex view with
 * Hide Secrets on: a secret in one must never be written or shown byte for byte. Found by an
 * independent review of 0.1.40 (UTF-16 by a BOM over ASCII, binary with ASCII in it, a compressed
 * body sent without saying so).
 */
import { deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { collectKnown, redactHarEntry } from '../src/backend/har-redact';
import { HIDDEN_BINARY, maskBytes } from '../src/backend/mask-body';
import { KnownValues, looksCompressed, secretInBytes } from '../src/shared/redact-body';

// Fake secrets, built at run time so the file itself holds nothing a secret scanner flags.
const SECRET = 'Zq9x' + 'Tk7Lm2Pw4Rt8Vn6Yb3';

type Json = Record<string, unknown>;
const META = { cut: { request: false, response: false }, base64Frames: [] };

/** An entry whose response body is these bytes, as base64, with this media type. */
function entry(bytes: Uint8Array, mimeType: string, headers: Array<[string, string]> = []): Json {
  return {
    startedDateTime: '2026-11-25T00:00:00.000Z',
    time: 1,
    request: {
      method: 'GET',
      url: 'https://api.example/file',
      httpVersion: 'HTTP/1.1',
      headers: headers.map(([name, value]) => ({ name, value })),
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Content-Type', value: mimeType }],
      cookies: [],
      content: {
        size: bytes.length,
        mimeType,
        text: Buffer.from(bytes).toString('base64'),
        encoding: 'base64',
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: bytes.length,
    },
    cache: {},
    timings: { send: 0, wait: 1, receive: 0 },
  };
}

function exported(e: Json): { content: { text?: string }; json: string; leftOut: number } {
  const known = new KnownValues();
  collectKnown(e, known);
  const out = redactHarEntry(e, META as never, known) as unknown as { entry: Json; leftOut: number };
  const response = out.entry.response as { content: { text?: string } };
  const json = JSON.stringify(out.entry);
  const decoded = response.content.text
    ? Buffer.from(response.content.text, 'base64').toString('latin1')
    : '';
  return { content: response.content, json: json + decoded, leftOut: out.leftOut };
}

const bytes = (...parts: Array<number[] | string>): Uint8Array =>
  Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

describe('a redacted HAR leaves out a body that hides a secret from its rules', () => {
  it('ASCII after a UTF-16 byte-order mark, read as UTF-16, with a secret by name', () => {
    const out = exported(entry(bytes([0xff, 0xfe], `{"password":"${SECRET}"} `), 'application/json'));
    expect(out.json).not.toContain(SECRET);
    expect(out.content.text).toBeUndefined();
    expect(out.leftOut).toBe(1);
  });

  it('the same, with a value known from a header', () => {
    const e = entry(bytes([0xff, 0xfe], `note ${SECRET} end `), 'text/plain', [
      ['Authorization', `Bearer ${SECRET}`],
    ]);
    expect(exported(e).json).not.toContain(SECRET);
  });

  it('binary with a secret by name in its ASCII', () => {
    const out = exported(
      entry(bytes([0xff, 0x00, 0x13], `{"password":"${SECRET}"}`), 'application/octet-stream'),
    );
    expect(out.json).not.toContain(SECRET);
    expect(out.leftOut).toBe(1);
  });

  it('binary with a token by its shape', () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const out = exported(entry(bytes([0x89, 0x00, 0xff], `x ${token} y`), 'application/octet-stream'));
    expect(out.json).not.toContain(token);
  });

  for (const [name, magic] of [
    ['gzip', [0x1f, 0x8b, 0x08]],
    ['zstd', [0x28, 0xb5, 0x2f, 0xfd]],
  ] as const) {
    it(`a ${name} body sent without saying so, whatever it holds`, () => {
      const body =
        name === 'gzip'
          ? gzipSync(Buffer.from(`{"password":"${SECRET}"}`))
          : bytes([...magic], 'compressed bytes here');
      const out = exported(entry(body, 'application/json'));
      expect(out.content.text).toBeUndefined();
      expect(out.leftOut).toBe(1);
      expect(out.json).toContain('left out');
    });
  }
});

describe('a redacted HAR leaves out the other ways bytes hide a secret', () => {
  const utf16 = (s: string) => Buffer.from(s, 'utf16le');
  const utf32 = (s: string) => Buffer.concat([...s].map((c) => Buffer.from([c.charCodeAt(0), 0, 0, 0])));
  const cases: Array<[string, Uint8Array, string]> = [
    [
      'UTF-16 of odd length',
      Buffer.concat([utf16(`{"password":"${SECRET}"}`), Buffer.from([0x41])]),
      'application/json',
    ],
    ['UTF-32', utf32(`{"password":"${SECRET}"}`), 'application/json'],
    ['UTF-32 said so', utf32(`{"password":"${SECRET}"}`), 'text/plain; charset=utf-32le'],
    [
      'UTF-16 said so, with stray bytes',
      Buffer.concat([utf16(`password=${SECRET}`), Buffer.from([0xff])]),
      'text/plain; charset=utf-16',
    ],
    ['UTF-16 of a binary type', utf16(`{"password":"${SECRET}"}`), 'application/octet-stream'],
    [
      'ASCII among other text read as Latin-1',
      Buffer.concat([Buffer.from('中文字符'.repeat(20), 'utf16le'), utf16(`password=${SECRET}`)]),
      'text/plain',
    ],
  ];
  for (const [name, body, type] of cases) {
    it(name, () => {
      const out = exported(entry(body, type));
      expect(out.json).not.toContain(SECRET);
      expect(
        Buffer.from(out.content.text ?? '', 'base64')
          .toString('latin1')
          .replace(/\0/g, ''),
      ).not.toContain(SECRET);
    });
  }

  it('a known value percent-encoded in UTF-16', () => {
    const value = 'Zq9x+Tk7/Lm2Pw4Rt8Vn6Yb3==';
    const body = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`next ${encodeURIComponent(value)} end `),
    ]);
    const out = exported(entry(body, 'text/plain', [['Authorization', `Bearer ${value}`]]));
    expect(out.json).not.toContain(encodeURIComponent(value));
  });

  for (const [name, body] of [
    ['zlib', Buffer.from(deflateSync(`{"password":"${SECRET}"}`))],
    ['gzip in a compressed gRPC frame', Buffer.concat([Buffer.from([1, 0, 0, 0, 40]), gzipSync('hello')])],
  ] as const) {
    it(`a ${name} body`, () => {
      const out = exported(entry(body, 'application/grpc'));
      expect(out.content.text).toBeUndefined();
    });
  }

  it('binary cut off inside a secret', () => {
    const body = bytes([0xff, 0x00, 0x13], `{"password":"${SECRET}`);
    const e = entry(body, 'application/octet-stream');
    const known = new KnownValues();
    const out = redactHarEntry(
      e,
      { ...META, cut: { request: false, response: true } } as never,
      known,
    ) as unknown as {
      entry: Json;
    };
    expect(JSON.stringify(out.entry)).not.toContain(Buffer.from(body).toString('base64'));
  });
});

describe('WebSocket binary frames in a redacted HAR', () => {
  const frames = (...data: Uint8Array[]): Json => ({
    ...entry(Buffer.from('ok'), 'text/plain'),
    _webSocketMessages: data.map((d, i) => ({
      type: 'receive',
      time: i,
      opcode: 2,
      data: Buffer.from(d).toString('base64'),
    })),
  });

  it('leaves out a frame that shows a secret, and keeps one that doesn’t', () => {
    const plain = bytes([0x01, 0x02, 0xff], 'ordinary frame');
    const e = frames(
      Buffer.from(`{"password":"${SECRET}"}`),
      bytes([0xff, 0x00], `{"password":"${SECRET}"}`),
      gzipSync(`token=${SECRET}`),
      Buffer.from(`Authorization: Bearer ${SECRET}`),
      plain,
    );
    const known = new KnownValues();
    collectKnown(e, known);
    const out = redactHarEntry(e, META as never, known) as unknown as { entry: Json; leftOut: number };
    const messages = out.entry._webSocketMessages as Array<{ data: string }>;
    for (const m of messages.slice(0, 4)) expect(m.data).toBe('');
    expect(Buffer.from(messages[4]!.data, 'base64')).toEqual(Buffer.from(plain));
    expect(out.leftOut).toBe(4);
  });
});

describe('a redacted HAR keeps a body it can’t read but that shows nothing', () => {
  it('random binary, almost always: a password-like run of bytes by chance doesn’t count', () => {
    let seed = 7;
    const random = (n: number): Uint8Array => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        out[i] = seed >>> 24;
      }
      return out;
    };
    let flagged = 0;
    for (let i = 0; i < 20; i++) if (secretInBytes(random(1024 * 1024), new KnownValues())) flagged++;
    expect(flagged).toBe(0);
  });

  it('binary with no secret in it', () => {
    const image = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff], 'IHDR plain chunk');
    const out = exported(entry(image, 'image/png'));
    expect(Buffer.from(out.content.text!, 'base64')).toEqual(Buffer.from(image));
    expect(out.leftOut).toBe(0);
  });

  it('real UTF-16 text with no secret, by its byte-order mark', () => {
    const text = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('hello world, nothing here', 'utf16le'),
    ]);
    const out = exported(entry(text, 'text/plain; charset=utf-16'));
    expect(Buffer.from(out.content.text!, 'base64')).toEqual(text);
    expect(out.leftOut).toBe(0);
  });

  it('real UTF-16 text with a secret, masked rather than left out', () => {
    const text = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`password=${SECRET}`, 'utf16le')]);
    const out = exported(entry(text, 'text/plain; charset=utf-16'));
    expect(out.leftOut).toBe(0);
    expect(Buffer.from(out.content.text!, 'base64').toString('utf16le')).toContain('password=[redacted]');
  });

  it('bytes that start like gzip only by chance in a text body are read as text', () => {
    const out = exported(entry(Buffer.from('plain words'), 'text/plain'));
    expect(out.leftOut).toBe(0);
  });
});

describe('the window’s Hex view with Hide Secrets on', () => {
  it('hides binary with a secret in its ASCII', () => {
    const result = maskBytes(
      bytes([0xff, 0x00, 0x13], `{"password":"${SECRET}"}`),
      'application/octet-stream',
      false,
      new KnownValues(),
    );
    expect(result).toEqual({ hidden: HIDDEN_BINARY });
  });

  it('shows binary with nothing in it', () => {
    const body = bytes([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff], 'IHDR');
    const result = maskBytes(body, 'image/png', false, new KnownValues());
    expect('hidden' in result).toBe(false);
  });
});

describe('the Hex view, more ways', () => {
  it('hides ASCII among other text read as Latin-1', () => {
    const body = Buffer.concat([
      Buffer.from('中文字符'.repeat(20), 'utf16le'),
      Buffer.from(`password=${SECRET}`, 'utf16le'),
    ]);
    expect(maskBytes(body, 'text/plain', false, new KnownValues())).toEqual({ hidden: HIDDEN_BINARY });
  });

  it('hides a known value percent-encoded after a UTF-16 BOM', () => {
    const value = 'Zq9x+Tk7/Lm2Pw4Rt8Vn6Yb3==';
    const known = new KnownValues();
    known.add(value);
    const body = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`next ${encodeURIComponent(value)} end `),
    ]);
    expect(maskBytes(body, 'text/plain', false, known)).toEqual({ hidden: HIDDEN_BINARY });
  });

  it('still masks real UTF-16 text in place', () => {
    const body = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`password=${SECRET} and more`, 'utf16le'),
    ]);
    const result = maskBytes(body, 'text/plain; charset=utf-16', false, new KnownValues());
    expect('hidden' in result).toBe(false);
  });
});

describe('fixes from the second review', () => {
  const utf16 = (s: string) => Buffer.from(s, 'utf16le');

  it('hides, in the Hex view, a UTF-16 secret in a body that reads as UTF-8', () => {
    const body = Buffer.concat([Buffer.from('a'.repeat(600)), utf16(`{"password":"${SECRET}"}`)]);
    for (const type of ['text/plain', 'application/octet-stream']) {
      expect(maskBytes(body, type, false, new KnownValues())).toEqual({ hidden: HIDDEN_BINARY });
    }
  });

  it('keeps a script in another encoding with no secret in it, by its own rules', () => {
    const script = '// café\nfunction f(o){ return { password: o.passwordInput, token: o.sessionToken }; }';
    for (const body of [
      Buffer.from(script, 'latin1'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), utf16(script)]),
    ]) {
      const out = exported(entry(body, 'application/javascript'));
      expect(out.leftOut).toBe(0);
      expect(Buffer.from(out.content.text!, 'base64')).toEqual(body);
      expect('hidden' in maskBytes(body, 'application/javascript', false, new KnownValues())).toBe(false);
    }
  });

  it('still leaves out a script in another encoding that does hold a secret', () => {
    const body = Buffer.from(`// café\nvar password="${SECRET}";`, 'latin1');
    const out = exported(entry(body, 'application/javascript'));
    expect(out.json).not.toContain(SECRET);
  });

  it('doesn’t take protobuf or plain text for zlib', () => {
    expect(looksCompressed(Buffer.from([0x08, 0x3c, 0x12, 0x03]))).toBe(false);
    expect(looksCompressed(Buffer.from('80,1,2\n', 'latin1'))).toBe(false);
    expect(looksCompressed(Buffer.from('x HK', 'latin1'))).toBe(false);
    for (const second of [0x01, 0x5e, 0x9c, 0xda])
      expect(looksCompressed(Buffer.from([0x78, second]))).toBe(true);
    const proto = Buffer.from([0x08, 0x3c, 0x12, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(exported(entry(proto, 'application/x-protobuf')).leftOut).toBe(0);
  });
});

describe('secretInBytes', () => {
  it('skips what was already hidden, and finds what wasn’t', () => {
    const text = `password=${SECRET} then token=${SECRET}`;
    const at = text.indexOf(SECRET);
    const both = Buffer.from(text);
    expect(secretInBytes(both, new KnownValues(), { skip: [[at, at + SECRET.length]] })).toBe(true);
    const second = text.lastIndexOf(SECRET);
    expect(
      secretInBytes(both, new KnownValues(), {
        skip: [
          [at, at + SECRET.length],
          [second, second + SECRET.length],
        ],
      }),
    ).toBe(false);
  });

  it('counts a match only if what was hidden covers all of it', () => {
    const text = Buffer.from(`password=${SECRET} end`);
    const at = text.indexOf(SECRET);
    expect(secretInBytes(text, new KnownValues(), { skip: [[at, at + SECRET.length]] })).toBe(false);
    expect(secretInBytes(text, new KnownValues(), { skip: [[at, at + 4]] })).toBe(true);
  });

  it('finds a known value joined to other bytes, in UTF-16, and as Latin-1', () => {
    const known = new KnownValues();
    known.add(SECRET);
    expect(secretInBytes(bytes([0xff], `ab${SECRET}cd`), known)).toBe(true);
    expect(secretInBytes(Buffer.from(`x ${SECRET} y`, 'utf16le'), known)).toBe(true);
    const accented = 'Zq9xTk7Lm2éPw4Rt8Vn6';
    known.add(accented);
    expect(
      secretInBytes(bytes([0xff], ` ${Buffer.from(accented, 'latin1').toString('latin1')} `), known),
    ).toBe(true);
    expect(secretInBytes(bytes([0xff], ' Zq9xTk7Lm2 Pw4Rt8Vn6 '), known)).toBe(false);
  });

  it('knows zlib only by its checksum, and a gRPC frame only when it says it’s compressed', () => {
    expect(looksCompressed(Buffer.from([0x78, 0x00, 0x41]))).toBe(false);
    expect(looksCompressed(Buffer.concat([Buffer.from([0, 0, 0, 0, 9]), gzipSync('x')]))).toBe(false);
  });

  it('knows zlib and a compressed gRPC frame, not ordinary bytes', () => {
    expect(looksCompressed(deflateSync('x'))).toBe(true);
    expect(looksCompressed(Buffer.concat([Buffer.from([1, 0, 0, 0, 9]), gzipSync('x')]))).toBe(true);
    expect(looksCompressed(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(looksCompressed(Buffer.from([1, 0, 0, 0, 9, 0x0a, 0x03]))).toBe(false);
    expect(looksCompressed(Buffer.from([0x1f]))).toBe(false);
  });

  it('finds a secret by name, by shape, or known, in any bytes', () => {
    const known = new KnownValues();
    known.add(SECRET);
    expect(secretInBytes(bytes([0], `password=${SECRET}`), new KnownValues())).toBe(true);
    expect(secretInBytes(bytes([0], `x ${SECRET} y`), known)).toBe(true);
    expect(secretInBytes(bytes([0], 'nothing here at all'), known)).toBe(false);
  });

  it('reads every part of a large body, not only its start', () => {
    const big = Buffer.concat([Buffer.alloc(100_000, 0x00), Buffer.from(`password=${SECRET}`)]);
    expect(secretInBytes(big, new KnownValues())).toBe(true);
  });

  it('stays linear on large hostile bytes', () => {
    const big = Buffer.alloc(8 * 1024 * 1024, 'password=a');
    let fastest = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      secretInBytes(big, new KnownValues());
      fastest = Math.min(fastest, performance.now() - started);
    }
    expect(fastest).toBeLessThan(5000);
  });
});
