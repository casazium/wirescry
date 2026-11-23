/**
 * Marking a value must never make a plugin result less safe than leaving it unmarked: a marked name
 * still makes a name/value pair, a marked secret is still learned, an error is masked before it's
 * cut, and keys that mask alike can't stall the backend.
 */
import { describe, expect, it } from 'vitest';
import { maskFields, type MaskField } from '../src/backend/mask-body';
import { collectResult, keptWithin, MAX_NODES } from '../src/backend/mcp/plugin-result';
import { MAX_ERROR_CHARS, Reader } from '../src/backend/mcp/reader';
import { KnownValues } from '../src/shared/redact-body';

// Fake secrets, built at run time so the file itself holds nothing a secret scanner flags.
const SECRET = 'hunter2' + 'Correct9Horse';
const GITHUB_LIKE = (i: number): string => 'ghp_' + String(i).padStart(36, 'a');

type Kind = 'text' | 'url' | 'body' | 'header';
const KINDS: Kind[] = ['text', 'url', 'body', 'header'];
/** A header mark is a name and a value already: its value never names a pair. */
const NAME_KINDS: Kind[] = ['text', 'url', 'body'];

function mark(kind: Kind, value: string): Record<string, string> {
  switch (kind) {
    case 'body':
      return { wirescryMask: 'body', text: value };
    case 'header':
      return { wirescryMask: 'header', name: 'x-note', value };
    default:
      return { wirescryMask: kind, value };
  }
}

function masked(result: unknown): unknown {
  const { fields, build } = collectResult(result);
  return build(maskFields(fields, new KnownValues()));
}

const shows = (out: unknown, text: string): boolean => JSON.stringify(out).includes(text);

function readerWithRealMasking(onCall?: () => void): Reader {
  return new Reader({
    maskFields: async (fields: MaskField[]) => {
      onCall?.();
      return { ok: true, fields: maskFields(fields, new KnownValues()), full: false };
    },
  } as never);
}

describe('a marked name still makes a name/value pair', () => {
  for (const kind of NAME_KINDS) {
    for (const name of ['authorization', 'password', 'x-api-key']) {
      it(`hides the value beside a ${kind} mark naming ${name}`, () => {
        expect(shows(masked({ name: mark(kind, name), value: SECRET }), SECRET)).toBe(false);
        expect(shows(masked({ value: SECRET, name: mark(kind, name) }), SECRET)).toBe(false);
        expect(shows(masked({ Name: mark(kind, name), VALUE: SECRET }), SECRET)).toBe(false);
        expect(shows(masked([[mark(kind, name), SECRET]]), SECRET)).toBe(false);
      });
    }

    it(`counts a ${kind} mark under a weak name key for passwords`, () => {
      expect(shows(masked({ type: mark(kind, 'password'), value: SECRET }), SECRET)).toBe(false);
    });

    it(`learns the value of a pair named by a ${kind} mark`, () => {
      const out = masked({ pair: { name: mark(kind, 'password'), value: SECRET }, note: `was ${SECRET}` });
      expect(shows(out, SECRET)).toBe(false);
    });
  }

  for (const kind of KINDS) {
    it(`keeps the value beside a harmless ${kind} mark`, () => {
      const out = masked({ name: mark(kind, 'color'), value: 'blue' });
      expect(shows(out, 'color')).toBe(true);
      expect((out as { value: string }).value).toBe('blue');
    });
  }

  it('gives a marked name of any spelling the same answer as a plain one', () => {
    const names = [
      'user[password]',
      'db/password',
      '$password',
      'password?',
      'password*',
      '"password"',
      'api_key\n',
      'authorization\t',
      'Cookie\n',
      'x-session-id;',
      'credentials[secret]',
      'p\u00e4ssword_secret',
      `${'x'.repeat(140)}password`,
      'https://example.com/password',
    ];
    const values: unknown[] = ['tiger', 'correcthorse', 482913, 'https://example.com/', 'pw 12', 'ok words'];
    for (const name of names) {
      for (const value of values) {
        for (const kind of ['url', 'body'] as const) {
          const plain = masked({ name, value }) as { value: unknown };
          const out = masked({ name: mark(kind, name), value }) as { value: unknown };
          expect(out.value).toEqual(plain.value);
          const plainPair = masked([[name, value]]) as unknown[][];
          const markedPair = masked([[mark(kind, name), value]]) as unknown[][];
          expect(markedPair[0]![1]).toEqual(plainPair[0]![1]);
        }
      }
    }
  });

  it('hides a marked value beside a marked secret name', () => {
    for (const kind of ['url', 'body'] as const) {
      const out = masked({ name: mark(kind, 'db/password'), value: mark(kind, 'tiger') });
      expect((out as { value: unknown }).value).toBe('[redacted]');
    }
  });

  it('lets a header that only mentions a secret sit beside other values', () => {
    const vary = { wirescryMask: 'header', name: 'vary', value: 'Cookie' };
    const type = { wirescryMask: 'header', name: 'content-type', value: 'text/html' };
    expect(masked([[vary, type]])).toEqual([
      [
        { name: 'vary', value: 'Cookie' },
        { name: 'content-type', value: 'text/html' },
      ],
    ]);
    expect(masked({ name: vary, value: 'ok words' })).toEqual({
      name: { name: 'vary', value: 'Cookie' },
      value: 'ok words',
    });
  });

  it('keeps a marked secret name readable: only its value is hidden', () => {
    expect(masked({ name: mark('text', 'authorization'), value: SECRET })).toEqual({
      name: 'authorization',
      value: '[redacted]',
    });
    expect(masked({ name: mark('url', 'password'), value: SECRET })).toEqual({
      name: 'password',
      value: '[redacted]',
    });
  });

  it('reads a marked header name in any capitalization', () => {
    for (const kind of NAME_KINDS) {
      const out = masked({ name: mark(kind, 'AuThOrIzAtIoN'), value: 'plainwords' }) as { value: string };
      expect(out.value).toBe('[redacted]');
    }
  });

  it('checks a huge marked body for a name without stalling', () => {
    const started = performance.now();
    collectResult({ note: mark('body', 'password_'.repeat(100_000)) });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('reads a marked name written in camelCase, with a space, or long', () => {
    for (const name of ['clientSecret', 'sessionKey', 'client secret', 'x-my-company-internal-api-key']) {
      for (const kind of NAME_KINDS) {
        const out = masked({ name: mark(kind, name), value: 'plainwords' }) as { value: string };
        expect(out.value).toBe('[redacted]');
      }
    }
  });

  it('hides what the text rules find in a header or URL mark, keeping a header’s name', () => {
    const header = masked({
      h: { wirescryMask: 'header', name: 'x-debug', value: `password=${SECRET}` },
    }) as { h: { name: string; value: string } };
    expect(header.h.name).toBe('x-debug');
    expect(shows(header, SECRET)).toBe(false);
    const url = masked({ note: mark('url', '{"password":"abc"}') });
    expect(shows(url, 'abc')).toBe(false);
    const named = masked({ h: { wirescryMask: 'header', name: 'x-note', value: 'pwd: tiger12' } }) as {
      h: { name: string; value: string };
    };
    expect(named.h.name).toBe('x-note');
    expect(shows(named, 'tiger12')).toBe(false);
  });

  it('keeps the readable parts of a body mark that holds a secret', () => {
    const body = JSON.stringify({ password: SECRET, page: 2 });
    const out = masked({ note: { wirescryMask: 'body', contentType: 'application/json', text: body } }) as {
      note: string;
    };
    expect(out.note).toContain('"page":2');
    expect(out.note).not.toContain(SECRET);
  });

  it('keeps a marked URL that only mentions a secret, outside a pair', () => {
    const url = 'https://example.com/password-reset';
    expect(masked({ link: mark('url', url), note: 'plain' })).toEqual({ link: url, note: 'plain' });
  });
});

describe('a marked secret is learned', () => {
  for (const kind of KINDS) {
    it(`hides other copies of a ${kind} mark under a secret’s key`, () => {
      const out = masked({ password: mark(kind, SECRET), note: `was ${SECRET}`, [`k ${SECRET}`]: 1 });
      expect(shows(out, SECRET)).toBe(false);
      expect((out as { password: unknown }).password).toBe('[redacted]');
      expect((out as { note: unknown }).note).toBe('was [redacted]');
    });

    it(`hides copies inside another marked value, for a ${kind} mark`, () => {
      const out = masked({ password: mark(kind, SECRET), other: mark('body', `was ${SECRET} here`) });
      expect(shows(out, SECRET)).toBe(false);
    });

    it(`learns nothing from a ${kind} mark under a harmless key`, () => {
      const words = 'plain words here';
      const out = masked({ note: mark(kind, words), other: words }) as { other: string };
      expect(out.other).toBe(words);
      expect(shows(out, '[redacted]')).toBe(false);
    });

    it(`learns from a ${kind} mark only what the same plain value would teach`, () => {
      const value = 'plainWordsValue9';
      const plain = masked({ code: value, other: value }) as { other: unknown };
      const marked = masked({ code: mark(kind, value), other: value }) as { other: unknown };
      expect(marked.other).toEqual(plain.other);
    });
  }

  it('learns a marked value under a secret’s key in an object inside a list', () => {
    for (const kind of KINDS) {
      const out = masked({ items: [{ password: mark(kind, SECRET) }], note: `was ${SECRET}` });
      expect(shows(out, SECRET)).toBe(false);
    }
  });

  it('teaches no more from a list under a secret’s key than the plain value would', () => {
    const plain = masked({ password: [SECRET], note: `was ${SECRET}` }) as { note: unknown };
    for (const kind of KINDS) {
      const out = masked({ password: [mark(kind, SECRET)], note: `was ${SECRET}` }) as {
        password: unknown[];
        note: unknown;
      };
      expect(out.password).toEqual(['[redacted]']);
      expect(out.note).toEqual(plain.note);
    }
  });

  it('counts a marked text value once toward the limit', () => {
    const list = Array.from({ length: MAX_NODES - 1 }, () => mark('text', 'x'));
    expect(() => collectResult(list)).not.toThrow();
  });

  it('spends one place in the known-values list on each marked secret', () => {
    const secrets = Array.from({ length: 6000 }, (_, i) => `Qw${i}Er7Ty${i}Ui3Op`);
    for (const kind of ['url', 'body'] as const) {
      const values = new KnownValues();
      const { fields, build } = collectResult([
        secrets.map((secret) => ({ password: mark(kind, secret) })),
        secrets.map((secret) => `was ${secret}`),
      ]);
      const out = build(maskFields(fields, values));
      expect(values.full).toBe(false);
      expect(values.size).toBe(6000);
      expect(JSON.stringify(out)).not.toMatch(/was Qw/);
    }
  });

  it('gives a marked text value the same answer as the plain string, in every shape', () => {
    const shapes: Array<(v: (text: string) => unknown) => unknown> = [
      (v) => ({ password: v(SECRET), note: `was ${SECRET}` }),
      (v) => ({ name: v('authorization'), value: `Bearer ${SECRET}` }),
      (v) => ({ value: v(SECRET), name: 'x-api-key' }),
      (v) => [[v('cookie'), `sid=${SECRET}`]],
      (v) => ({ note: v(`password=${SECRET}`) }),
      (v) => ({ note: v('plain words') }),
      (v) => ({ session: { id: v('abc'), data: v(SECRET) } }),
    ];
    for (const shape of shapes) {
      expect(masked(shape((text) => mark('text', text)))).toEqual(masked(shape((text) => text)));
    }
  });

  it('adds no extra field for a result with no marks but text', () => {
    expect(
      collectResult({ a: mark('text', 'x'), b: 'y' }).fields.filter((f) => f.kind === 'json'),
    ).toHaveLength(1);
    expect(collectResult({ a: mark('url', 'x') }).fields.filter((f) => f.kind === 'json')).toHaveLength(2);
  });

  it('never returns a marked value when its place in the JSON changed', () => {
    const { fields, build } = collectResult({ a: mark('url', 'https://example.com/') });
    const answer = maskFields(fields, new KnownValues());
    answer[0] = '{"a":"something else"}';
    expect(build(answer)).toEqual({ a: '[redacted]' });
  });

  it('hides a value the real-value pass changed, in any shape, and never gives that pass’s text', () => {
    const { fields, build } = collectResult({
      a: mark('url', 'https://x.test/'),
      b: 'plain',
      c: 5,
      d: [1],
      e: {},
    });
    const clean = maskFields(fields, new KnownValues());
    const realAt = fields.length - 1;
    const withReal = (json: unknown): string[] =>
      clean.map((v, i) => (i === realAt ? JSON.stringify(json) : v));
    const base = { a: 'https://x.test/', b: 'plain', c: 5, d: [1], e: {} };
    expect(build(withReal(base))).toEqual(base);
    expect(build(withReal({ ...base, b: '[redacted]' }))).toEqual({ ...base, b: '[redacted]' });
    expect(build(withReal({ ...base, c: '[redacted]' }))).toEqual({ ...base, c: '[redacted]' });
    expect(build(withReal({ ...base, d: '[redacted]' }))).toEqual({ ...base, d: '[redacted]' });
    expect(build(withReal({ ...base, d: [1, 2] }))).toEqual({ ...base, d: '[redacted]' });
    expect(build(withReal({ ...base, e: '[redacted]' }))).toEqual({ ...base, e: '[redacted]' });
    expect(build(withReal({ ...base, a: '[redacted]' }))).toEqual({ ...base, a: '[redacted]' });
    expect(build(withReal({ ...base, a: 'https://x.test/?leak' }))).toEqual({ ...base, a: '[redacted]' });
  });
});

describe('a marked value judged by both passes', () => {
  /** The result built with its own kind's masked text and the real-value pass's answer given. */
  function judged(kind: 'url' | 'body', text: string, shown: string, seen: unknown): unknown {
    const { fields, build } = collectResult({ a: mark(kind, text) });
    const answer = maskFields(fields, new KnownValues());
    // After the JSON and the key `a`.
    answer[2] = shown;
    answer[fields.length - 1] = JSON.stringify({ a: seen });
    return (build(answer) as { a: unknown }).a;
  }
  const TEXT = 'plain text here';
  const OURS = 'plain [redacted] here';
  const THEIRS = '[redacted] text here';

  for (const kind of ['url', 'body'] as const) {
    it(`gives a ${kind} mark its own text when the real pass changed nothing`, () => {
      expect(judged(kind, TEXT, OURS, TEXT)).toBe(OURS);
    });

    it(`hides a ${kind} mark the real pass hid whole or changed in shape`, () => {
      expect(judged(kind, TEXT, OURS, '[redacted]')).toBe('[redacted]');
      expect(judged(kind, TEXT, OURS, 5)).toBe('[redacted]');
      expect(judged(kind, TEXT, OURS, ['x'])).toBe('[redacted]');
    });

    it(`hides a ${kind} mark when only the real pass found something`, () => {
      expect(judged(kind, TEXT, TEXT, THEIRS)).toBe('[redacted]');
    });

    it(`keeps a ${kind} mark when both passes found the same`, () => {
      expect(judged(kind, TEXT, OURS, OURS)).toBe(OURS);
    });
  }

  for (const kind of ['url', 'body'] as const) {
    it(`hides a ${kind} mark when the passes found different things`, () => {
      expect(judged(kind, TEXT, OURS, THEIRS)).toBe('[redacted]');
    });

    it(`keeps a ${kind} mark that hides more than the real pass`, () => {
      const real = 'plain text more now';
      expect(judged(kind, real, 'plain [redacted] now', 'plain text [redacted] now')).toBe(
        'plain [redacted] now',
      );
    });
  }

  it('shows no decoy-protected secret in a body', () => {
    const decoyForm = {
      wirescryMask: 'body',
      contentType: 'application/x-www-form-urlencoded',
      text: 'password=x1&msg=pwd: tiger12',
    };
    expect(shows(masked({ b: decoyForm }), 'tiger12')).toBe(false);
    const decoyScript = {
      wirescryMask: 'body',
      contentType: 'application/javascript',
      text: `var k="ghp_${'a'.repeat(36)}"; var password = "tiger12";`,
    };
    expect(shows(masked({ b: decoyScript }), 'tiger12')).toBe(false);
  });

  it('keeps the shape of an ordinary Cookie header', () => {
    const out = masked({
      item: { wirescryMask: 'header', name: 'Cookie', value: 'sid=abc123def456ghi789; theme=dark' },
    }) as { item: { name: string; value: string } };
    expect(out.item.name).toBe('Cookie');
    expect(out.item.value).toContain('sid=');
    expect(out.item.value).toContain('theme=');
    expect(out.item.value).not.toContain('abc123');
  });

  it('learns a header mark whose value reads as a secret’s name, away from a pair’s name', () => {
    const value = 'Zq9xSecretValue77';
    const header = { wirescryMask: 'header', name: 'x-note', value };
    expect(shows(masked({ password: header, note: `was ${value}` }), value)).toBe(false);
    expect(shows(masked({ items: [{ password: header }], note: `was ${value}` }), value)).toBe(false);
  });

  it('treats every key that can name a pair as a name’s place, in any case', () => {
    for (const key of ['name', 'KEY', 'header', 'field', 'type', 'Id', 'label', 'k', 'param', 'property']) {
      const header = { wirescryMask: 'header', name: 'x-note', value: 'password' };
      const out = masked({ [key]: header, value: 'ok words' }) as { value: string };
      expect(out.value).toBe('ok words');
    }
  });

  it('hides a plain value the real pass turned into another type, or an object it reshaped', () => {
    const { fields, build } = collectResult({ m: mark('url', 'https://x.test/'), b: 'plain', e: {} });
    const answer = maskFields(fields, new KnownValues());
    const realAt = fields.length - 1;
    const base = { m: 'https://x.test/', b: 'plain', e: {} };
    answer[realAt] = JSON.stringify({ ...base, b: 5 });
    expect(build(answer)).toEqual({ ...base, b: '[redacted]' });
    answer[realAt] = JSON.stringify({ ...base, e: { x: 1 } });
    expect(build(answer)).toEqual({ ...base, e: '[redacted]' });
  });

  it('never lets a header whose value reads as a secret name hide its neighbor', () => {
    for (const value of ['AuThOrIzAtIoN', 'sessionKey', 'Cookie']) {
      const header = { wirescryMask: 'header', name: 'x-note', value };
      expect(masked([[header, 'ok words']])).toEqual([[{ name: 'x-note', value }, 'ok words']]);
    }
  });
});

describe('whether one masked text keeps only what another keeps', () => {
  it('accepts the same text, or one that hides more', () => {
    expect(keptWithin('a [redacted] c', 'a [redacted] c')).toBe(true);
    expect(keptWithin('a [redacted]', 'a b [redacted]')).toBe(true);
    expect(keptWithin('[redacted]', 'a b c')).toBe(true);
    expect(keptWithin('', 'a')).toBe(true);
    expect(keptWithin('[redacted]', '[redacted]')).toBe(true);
    expect(keptWithin('[redacted]', '')).toBe(true);
  });

  it('refuses a piece the other hid', () => {
    expect(keptWithin('a tiger', 'a [redacted]')).toBe(false);
    expect(keptWithin('x', '')).toBe(false);
  });

  it('refuses pieces out of order, and counts a repeated piece each time', () => {
    expect(keptWithin('b [redacted] a', 'a [redacted] b')).toBe(false);
    expect(keptWithin('ab[redacted]ab', 'ab')).toBe(false);
    expect(keptWithin('ab[redacted]ab', 'abab')).toBe(true);
    expect(keptWithin('ab[redacted]ab', 'ab[redacted]ab')).toBe(true);
  });

  it('never matches a piece across a hidden part', () => {
    expect(keptWithin('ab', 'a[redacted]b')).toBe(false);
  });

  it('finds a piece after a false start', () => {
    expect(keptWithin('aab', 'aaab')).toBe(true);
    expect(keptWithin('abab', 'ababab')).toBe(true);
    expect(keptWithin('abcabd', 'abcabcabd')).toBe(true);
    expect(keptWithin('aab', 'aaa')).toBe(false);
  });

  it('agrees with a plain search for every short piece and text', () => {
    const words = (longest: number): string[] => {
      const all = [''];
      for (let at = 0; all[at]!.length < longest; at++) all.push(`${all[at]}a`, `${all[at]}b`);
      return all;
    };
    const texts = words(8);
    for (const piece of words(5).filter((word) => word !== '')) {
      for (const text of texts) {
        if (keptWithin(piece, text) !== text.includes(piece)) {
          expect(`${piece} in ${text}: ${keptWithin(piece, text)}`).toBe(String(text.includes(piece)));
        }
      }
    }
  });

  it('moves on to a later part for the next piece', () => {
    expect(keptWithin('b[redacted]c', 'a[redacted]b[redacted]c')).toBe(true);
    expect(keptWithin('c[redacted]b', 'a[redacted]b[redacted]c')).toBe(false);
  });

  it('stays linear on hostile text', () => {
    const size = 400_000;
    const shown = 'a'.repeat(size) + 'b';
    const seen = 'a'.repeat(size) + 'c';
    let fastest = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      expect(keptWithin(shown, seen)).toBe(false);
      fastest = Math.min(fastest, performance.now() - started);
    }
    expect(fastest).toBeLessThan(1000);
  });
});

describe('keys that mask alike', () => {
  it('stay apart, around a key that already looks numbered', () => {
    const out = masked({
      [GITHUB_LIKE(1)]: 1,
      [GITHUB_LIKE(2)]: 2,
      '[redacted] (2)': 'literal',
      [GITHUB_LIKE(3)]: 3,
      [GITHUB_LIKE(4)]: 4,
    }) as Record<string, unknown>;
    expect(Object.keys(out)).toHaveLength(5);
    expect(Object.values(out).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      1,
      2,
      3,
      4,
      'literal',
    ]);
    expect(out['[redacted]']).toBe(1);
    expect(shows(out, 'ghp_')).toBe(false);
  });

  it('never overwrite a key that was already numbered', () => {
    const out = masked({
      '[redacted] (2)': 'literal',
      [GITHUB_LIKE(1)]: 1,
      [GITHUB_LIKE(2)]: 2,
      [GITHUB_LIKE(3)]: 3,
    }) as Record<string, unknown>;
    expect(out).toEqual({
      '[redacted] (2)': 'literal',
      '[redacted]': 1,
      '[redacted] (3)': 2,
      '[redacted] (4)': 3,
    });
  });

  it('count separately in each object', () => {
    const out = masked([
      { [GITHUB_LIKE(1)]: 1, [GITHUB_LIKE(2)]: 2 },
      { [GITHUB_LIKE(3)]: 3, [GITHUB_LIKE(4)]: 4 },
    ]) as Array<Record<string, unknown>>;
    for (const object of out) expect(Object.keys(object)).toEqual(['[redacted]', '[redacted] (2)']);
  });

  it('don’t stall on thousands of them', () => {
    const record: Record<string, null> = {};
    for (let i = 0; i < 19_990; i++) record[GITHUB_LIKE(i)] = null;
    const { fields, build } = collectResult(record);
    // Every key masked alike, as the mask worker would; the time measured is the rebuild.
    const answer = fields.map((field, i) => (i === 0 ? field.value : '[redacted]'));
    let fastest = Infinity;
    let out: unknown;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      out = build(answer);
      fastest = Math.min(fastest, performance.now() - started);
    }
    expect(Object.keys(out as object)).toHaveLength(19_990);
    // Was 12 seconds.
    expect(fastest).toBeLessThan(1000);
  });
});

describe('a plugin’s error', () => {
  it('is masked before it’s cut, so a secret at the cut can’t leak', async () => {
    const message = 'x'.repeat(1960) + ` {"password":"${SECRET}${SECRET}${SECRET}"}`;
    const text = await readerWithRealMasking().pluginError(message);
    expect(text).not.toContain('hunter2');
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.startsWith('xxx')).toBe(true);
  });

  it('is cut to 2,000 characters after masking', async () => {
    const text = await readerWithRealMasking().pluginError('w '.repeat(5000));
    expect(text).toHaveLength(2000);
  });

  it('keeps a short message whole', async () => {
    expect(await readerWithRealMasking().pluginError('it broke')).toBe('it broke');
  });

  it('gives a general message for an error that isn’t text', async () => {
    let calls = 0;
    const reader = readerWithRealMasking(() => calls++);
    for (const message of [undefined, null, 5, {}]) {
      expect(await reader.pluginError(message as never)).toBe('The tool failed.');
    }
    expect(calls).toBe(0);
  });

  it('masks one exactly at the input limit', async () => {
    let calls = 0;
    const reader = readerWithRealMasking(() => calls++);
    const start = `password=${SECRET} `;
    const text = await reader.pluginError(start + 'x'.repeat(MAX_ERROR_CHARS - start.length));
    expect(calls).toBe(1);
    expect(text).not.toContain(SECRET);
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it('gives a general message for one past the limit, without masking or cutting it', async () => {
    let calls = 0;
    const reader = readerWithRealMasking(() => calls++);
    const text = await reader.pluginError(`password=${SECRET} ` + 'x'.repeat(MAX_ERROR_CHARS));
    expect(text).toBe('The tool failed.');
    expect(calls).toBe(0);
  });
});
