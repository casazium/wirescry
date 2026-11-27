/**
 * Known values written differently where they repeat in a body: with JSON's escapes (`\/`,
 * `/`, as PHP and many scripts write a slash), inside a longer run (`/dl/<token>_thumb.png`,
 * `x<token>`), or cut off at the end of a body that was cut short. Found by an independent review
 * of 0.1.40 (F8).
 */
import { describe, expect, it } from 'vitest';
import { collectKnown, redactHarEntry } from '../src/backend/har-redact';
import { maskBytes } from '../src/backend/mask-body';
import { KnownValues, redactBody, variedWindowEnd } from '../src/shared/redact-body';
import { applySpans, REDACTED } from '../src/shared/redact';
import { expectGrowthUnder, timeOnce as once } from './timing';

// Fake secrets, built at run time so the file itself holds nothing a secret scanner flags.
const SLASHED = 'Ab1/' + 'Cd2+Ef3=Gh4Ij5Kl6';
const TOKEN = 'Zq9x' + 'Tk7Lm2Pw4Rt8Vn6Yb3';
const SHORT = 'Sh0rt' + 'Val9';
const R = REDACTED;
const rep = (s: string, n: number) => s.repeat(Math.max(0, Math.ceil(n)));

const knownWith = (...values: string[]): KnownValues => {
  const known = new KnownValues();
  for (const value of values) known.add(value);
  return known;
};
const redact = (
  text: string,
  type: string,
  options: { cut?: boolean } = {},
  known = knownWith(SLASHED, TOKEN, SHORT),
) => applySpans(text, redactBody(text, type, known, options).spans);

describe('a known value written with JSON’s escapes', () => {
  it.each([
    [`<script>var k = "Ab1\\/Cd2+Ef3=Gh4Ij5Kl6";</script>`, `<script>var k = "${R}";</script>`, 'text/html'],
    [`var k = "Ab1\\u002fCd2+Ef3=Gh4Ij5Kl6";`, `var k = "${R}";`, 'application/javascript'],
    [`var k = "Ab1\\u002FCd2+Ef3=Gh4Ij5Kl6";`, `var k = "${R}";`, 'application/javascript'],
    [`{"note":"Ab1\\/Cd2+Ef3=Gh4Ij5Kl6"}`, `{"note":"${R}"}`, 'application/json'],
    [`log: Ab1\\/Cd2+Ef3=Gh4Ij5Kl6 done`, `log: ${R} done`, 'text/plain'],
    // A short value too, standing alone.
    [`var k = "${SHORT}\\n";`, `var k = "${R}\\n";`, 'application/javascript'],
  ])('finds it in %j', (input, expected, type) => {
    expect(redact(input, type)).toBe(expected);
  });

  it.each([
    [`<script>var s = "{\\"k\\":\\"Ab1\\/Cd2+Ef3=Gh4Ij5Kl6\\"}";</script>`, 'text/html'],
    [`var s = '{\\'k\\':\\'Ab1\\/Cd2+Ef3=Gh4Ij5Kl6\\'}';`, 'application/javascript'],
    [`h = "<a href=\\"/dl/Ab1\\/Cd2+Ef3=Gh4Ij5Kl6\\">x</a>";`, 'application/javascript'],
    [`log: a\\x20bAb1\\/Cd2+Ef3=Gh4Ij5Kl6 done`, 'text/plain'],
    [`path C:\\dir\\Ab1\\/Cd2+Ef3=Gh4Ij5Kl6`, 'text/plain'],
  ])('finds it next to other escapes in %j', (input, type) => {
    expect(redact(input, type)).not.toContain('Gh4Ij5Kl6');
  });

  it('finds a value holding a real backslash, written escaped in a script', () => {
    const value = 'Ab1\\Cd2Ef3Gh4Ij5';
    expect(redact('var k = "Ab1\\\\Cd2Ef3Gh4Ij5";', 'application/javascript', {}, knownWith(value))).toBe(
      `var k = "${R}";`,
    );
  });

  it('ignores a run whose escapes aren’t JSON’s, and still finds the value written plainly', () => {
    expect(redact(`re = /\\d+/; k = "${TOKEN}"`, 'application/javascript')).toBe(`re = /\\d+/; k = "${R}"`);
  });
});

describe('a known value of 16+ characters inside a longer run', () => {
  it.each([
    [`see /dl/${TOKEN}_thumb.png`, `see /dl/${R}_thumb.png`, 'text/plain'],
    [`id x${TOKEN}y`, `id x${R}y`, 'text/plain'],
    [`{"log":"prefix-${TOKEN}-suffix"}`, `{"log":"prefix-${R}-suffix"}`, 'application/json'],
    [`<a href="/f/${TOKEN}.zip">x</a>`, `<a href="/f/${R}.zip">x</a>`, 'text/html'],
    [`x${TOKEN}x${TOKEN}x`, `x${R}x${R}x`, 'text/plain'],
  ])('finds it in %j', (input, expected, type) => {
    expect(redact(input, type)).toBe(expected);
  });

  it('finds a value of exactly 16 characters at the start of a run', () => {
    const value = 'Ab1Cd2Ef3Gh4Ij5K';
    expect(redact(`${value}xyz`, 'text/plain', {}, knownWith(value))).toBe(`${R}xyz`);
  });

  it('finds it percent-encoded inside a longer run', () => {
    const encoded = encodeURIComponent(SLASHED);
    expect(redact(`/dl/${encoded}_thumb`, 'text/plain')).toBe(`/dl/${R}_thumb`);
  });

  it.each([`id x${SHORT}y`, `id ${SHORT}_suffix`])(
    'leaves a short value joined to other text: %j',
    (input) => {
      expect(redact(input, 'text/plain')).toBe(input);
    },
  );

  it('leaves a near miss nine characters from the end', () => {
    const miss = `${TOKEN.slice(0, TOKEN.length - 9)}Q${TOKEN.slice(TOKEN.length - 8)}`;
    expect(redact(`id x${miss}y`, 'text/plain')).toBe(`id x${miss}y`);
  });

  it('leaves text that only shares the value’s ending', () => {
    const input = `x${TOKEN.slice(0, 5)}Q${TOKEN.slice(6)}y`;
    expect(redact(input, 'text/plain')).toBe(input);
  });
});

describe('many values alike', () => {
  it('spreads values sharing their ending over earlier windows, without saying the set is full', () => {
    const known = new KnownValues();
    // Tomcat-style session IDs: one host's suffix, distinct before it.
    const sessions = Array.from(
      { length: 12 },
      (_, i) => `${String(i).padStart(2, '0')}A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7.worker1`,
    );
    for (const value of sessions) known.add(value);
    expect(known.full).toBe(false);
    for (const value of sessions) {
      expect(redact(`x${value}y`, 'text/plain', {}, known)).toBe(`x${R}y`);
    }
  });

  it('does not look inside runs for a value whose windows hold only three different characters', () => {
    const value = 'AAB1'.repeat(5);
    const known = knownWith(value);
    expect(redact(`x${value}y`, 'text/plain', {}, known)).toBe(`x${value}y`);
    // Standing alone, it's found.
    expect(redact(`k ${value} j`, 'text/plain', {}, known)).toBe(`k ${R} j`);
  });

  it('keys a value with a long three-character tail on its varied start, not on the tail', () => {
    const value = `Qk7xR7pLmN3Z${'AAB1'.repeat(50)}`;
    const known = knownWith(value);
    const text = `${'AAB1'.repeat(2_000)} /dl/${value}_t.png`;
    expect(known.scan(text)).toHaveLength(1);
    expect(known.full).toBe(false);
  });

  it('does not say the set is full for a value with no varied window', () => {
    const known = knownWith('AAAABBBBAAAABBBBCCCCDDDD');
    expect(known.full).toBe(false);
  });

  it('finds one value of a family sharing 40 characters in a short string, without saying full', () => {
    const known = new KnownValues();
    const shared = 'Wq7Lm2Pw4Rt8Vn6Yb3Kc5Hj9Gf1Ds0Az4Xe7Ub2Mn';
    const values = Array.from({ length: 32 }, (_, i) => `A${String(i).padStart(3, '0')}zz${shared}`);
    for (const value of values) known.add(value);
    for (const value of [values[0]!, values[31]!]) {
      expect(known.scan(`"x${value}y"`)).toHaveLength(1);
    }
    expect(known.full).toBe(false);
  });

  it('adds a long value with few varied windows quickly', () => {
    const known = new KnownValues();
    const start = performance.now();
    for (let i = 0; i < 200; i++) known.add(`Q${i}x${'ab'.repeat(2_040)}`);
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it('says the set is full when text built to near-match a long value runs out the budget', () => {
    // A value of a repeating pattern, in a long run of that pattern: every fourth position is a
    // candidate compared back 200 characters, past 40 comparisons per character.
    const known = knownWith('abC1'.repeat(50));
    expect(known.full).toBe(false);
    redact('abC1'.repeat(2_000), 'text/plain', {}, known);
    expect(known.full).toBe(true);
  });

  it('compares a value keyed on an earlier window to its last character', () => {
    const known = new KnownValues();
    const sessions = Array.from(
      { length: 12 },
      (_, i) => `${String(i).padStart(2, '0')}A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7.worker1`,
    );
    for (const value of sessions) known.add(value);
    const miss = `${sessions[11]!.slice(0, -1)}Z`;
    expect(redact(`x${miss}y`, 'text/plain', {}, known)).toBe(`x${miss}y`);
  });

  it('says the set is full when values share their last 40 characters, past 32 of them', () => {
    const known = new KnownValues();
    const shared = 'Wq7Lm2Pw4Rt8Vn6Yb3Kc5Hj9Gf1Ds0Az4Xe7Ub2Mn';
    // Four windows from the end, eight values each.
    for (let i = 0; i < 32; i++) known.add(`A${String(i).padStart(3, '0')}zz${shared}`);
    expect(known.full).toBe(false);
    known.add(`A999zz${shared}`);
    expect(known.full).toBe(true);
    // The first ones kept are still found inside longer runs. Comparing 33 values that share 40
    // characters is costly, and the budget grows with the text: in a page of ordinary length,
    // as here, there's room; in a few dozen characters there may not be, and then the set is full.
    const page = `${'word '.repeat(200)}a xA000zz${shared}y`;
    expect(redact(page, 'text/plain', {}, known)).toBe(`${'word '.repeat(200)}a x${R}y`);
  });

  it('finds a value with a long repeated ending inside a run of that character', () => {
    const value = `Ab1Cd2Ef3Gh4${'T'.repeat(200)}`;
    const known = knownWith(value, TOKEN);
    const body = `${'T'.repeat(2_000)} /dl/${TOKEN}_thumb.png x${value}y`;
    const out = redact(body, 'text/plain', {}, known);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain(`x${R}y`);
    expect(known.full).toBe(false);
  });

  it('hides a cut tail when the comparison budget runs out, rather than show it', () => {
    const middle = 'Mq'.repeat(150);
    const values = Array.from(
      { length: 400 },
      (_, i) => `eyJhbGci${String(i).padStart(4, '0')}${middle}end${i}`,
    );
    const known = knownWith(...values);
    // Starts like them, matches none, and would take the budget to rule out.
    const tail = `eyJhbGciZ999${middle.slice(0, 280)}`;
    expect(redact(`t ${tail}`, 'text/plain', { cut: true }, known)).toBe(`t ${R}`);
  });

  it('finds a value learned after the searches have run, inside a longer run and cut off', () => {
    const known = knownWith(TOKEN);
    redact(`x${TOKEN}y`, 'text/plain', {}, known);
    redact(`note ${TOKEN.slice(0, 10)}`, 'text/plain', { cut: true }, known);
    const later = 'Lt8r' + 'Vb2Nm4Qw6Er8Ty0Ui';
    known.add(later);
    expect(redact(`x${later}y`, 'text/plain', {}, known)).toBe(`x${R}y`);
    expect(redact(`note ${later.slice(0, 10)}`, 'text/plain', { cut: true }, known)).toBe(`note ${R}`);
  });

  it('leaves out values of a few repeated characters from the inner search', () => {
    const known = knownWith('AAAAAAAAAAAAAAAAAAAAAA==');
    const image = `data:image/png;base64,iVBOR${'A'.repeat(40)}==xyz`;
    expect(redact(image, 'text/plain', {}, known)).toBe(image);
  });

  it('finds a value inside a longer run in many runs, each once', () => {
    const text = Array.from({ length: 50 }, () => `x${TOKEN}y`).join(' ');
    const out = redact(text, 'text/plain');
    expect(out).not.toContain(TOKEN);
    expect(out.split(R).length - 1).toBe(50);
  });
});

describe('choosing the window a long value is keyed by', () => {
  // Brute force: the largest k ≤ from whose eight characters before it hold four or more kinds.
  const reference = (value: string, from: number): number => {
    for (let k = Math.min(from, value.length); k >= 8; k--) {
      if (new Set(value.slice(k - 8, k)).size >= 4) return k;
    }
    return -1;
  };
  // A small seeded generator, so a failure repeats.
  let seed = 12345;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };

  it('agrees with a plain search on random strings, from every end', () => {
    for (let round = 0; round < 400; round++) {
      const alphabet = 'ABCDEFGH'.slice(0, 2 + next(6));
      const length = 8 + next(40);
      let value = '';
      for (let i = 0; i < length; i++) value += alphabet[next(alphabet.length)];
      for (let from = 0; from <= length + 1; from++) {
        expect(variedWindowEnd(value, from)).toBe(from > length ? -1 : reference(value, from));
      }
    }
  });

  it.each([
    ['a varied ending', 'abcdefghijkl', 12, 12],
    // `7pLAAAAA`: four kinds, the last window before the tail of A.
    ['a repeated tail', `Qk7xR7pL${'A'.repeat(20)}`, 28, 13],
    ['three kinds only', 'AAB1'.repeat(5), 20, -1],
    // `BCDAAAAA`: still four kinds, one past the start.
    ['exactly four near the start', 'ABCDAAAAAAAAAAAA', 16, 9],
    ['too short', 'ABCDEFG', 7, -1],
  ])('finds the window for %s', (_what, value, from, expected) => {
    expect(variedWindowEnd(value, from)).toBe(expected);
  });
});

describe('a known value cut off at the end of a body', () => {
  it.each([
    [`note ${TOKEN.slice(0, 12)}`, `note ${R}`, 'text/plain'],
    [`{"a":"${TOKEN.slice(0, 12)}`, `{"a":"${R}`, 'application/json'],
    // Joined to other text in the last run.
    [`id-${TOKEN.slice(0, 9)}`, `id-${R}`, 'text/plain'],
    // A short value complete at the cut end, joined to other text.
    [`id-${SHORT}`, `id-${R}`, 'text/plain'],
    // Exactly 8 characters of it, the fewest.
    [`note ${TOKEN.slice(0, 8)}`, `note ${R}`, 'text/plain'],
  ])('hides what is left in %j', (input, expected, type) => {
    expect(redact(input, type, { cut: true })).toBe(expected);
  });

  it.each([
    // Not cut: a prefix is just text.
    [`note ${TOKEN.slice(0, 12)}`, {}],
    // Seven characters: too few.
    [`note ${TOKEN.slice(0, 7)}`, { cut: true }],
    // Not the start of a known value, or one that starts like it and then differs.
    [`note ${TOKEN.slice(0, 8)}XYZ`, { cut: true }],
    [`note ${TOKEN.slice(1, 13)}`, { cut: true }],
    // The whole value and more is not a cut-off value (found as itself, or not at all).
    [`note abcdefgh12345`, { cut: true }],
    // Not at the end.
    [`note ${TOKEN.slice(0, 12)} more`, { cut: true }],
  ])('leaves %j', (input, options) => {
    expect(redact(input, 'text/plain', options)).toBe(input);
  });
});

describe('in every kind of body', () => {
  const part = (body: string) =>
    `--X\r\nContent-Disposition: form-data; name="u"\r\n\r\n${body}\r\n--X--\r\n`;
  it.each([
    ['XML text', `<path>/dl/${TOKEN}_t.png</path>`, `<path>/dl/${R}_t.png</path>`, 'application/xml'],
    ['an HTML attribute', `<img src="/dl/${TOKEN}.png">`, `<img src="/dl/${R}.png">`, 'text/html'],
    ['HTML text', `<p>id x${TOKEN}y</p>`, `<p>id x${R}y</p>`, 'text/html'],
    ['an event stream', `data: x${TOKEN}y\n\n`, `data: x${R}y\n\n`, 'text/event-stream'],
    [
      'NDJSON',
      `{"u":"/dl/${TOKEN}_t"}\n{"u":"x"}\n`,
      `{"u":"/dl/${R}_t"}\n{"u":"x"}\n`,
      'application/x-ndjson',
    ],
    ['a form', `u=%2Fdl%2F${TOKEN}_t&a=1`, `u=%2Fdl%2F${R}_t&a=1`, 'application/x-www-form-urlencoded'],
    ['a multipart part', part(`/dl/${TOKEN}_t`), part(`/dl/${R}_t`), 'multipart/form-data; boundary=X'],
    ['a JSON key', `{"x${TOKEN}y":1}`, `{"x${R}y":1}`, 'application/json'],
    ['YAML', `url: /dl/${TOKEN}_t\n`, `url: /dl/${R}_t\n`, 'application/yaml'],
  ])('finds a long value inside a longer run in %s', (_where, input, expected, type) => {
    expect(redact(input, type)).toBe(expected);
  });

  it.each([
    [
      'an event stream',
      `data: {"k":"Ab1\\/Cd2+Ef3=Gh4Ij5Kl6"}\n\n`,
      `data: {"k":"${R}"}\n\n`,
      'text/event-stream',
    ],
    ['XML text', `<k>Ab1\\/Cd2+Ef3=Gh4Ij5Kl6</k>`, `<k>${R}</k>`, 'application/xml'],
    [
      'an HTML attribute',
      `<div data-k='Ab1\\/Cd2+Ef3=Gh4Ij5Kl6'></div>`,
      `<div data-k='${R}'></div>`,
      'text/html',
    ],
    ['NDJSON', `{"k":"Ab1\\/Cd2+Ef3=Gh4Ij5Kl6"}\n`, `{"k":"${R}"}\n`, 'application/x-ndjson'],
  ])('finds an escaped value in %s', (_where, input, expected, type) => {
    expect(redact(input, type)).toBe(expected);
  });

  it.each([
    ['NDJSON', `{"a":1}\n{"t":"${TOKEN.slice(0, 12)}`, `{"a":1}\n{"t":"${R}`, 'application/x-ndjson'],
    [
      'an event stream',
      `data: ok\n\ndata: ${TOKEN.slice(0, 12)}`,
      `data: ok\n\ndata: ${R}`,
      'text/event-stream',
    ],
    ['XML text', `<t>${TOKEN.slice(0, 12)}`, `<t>${R}`, 'application/xml'],
    ['an HTML attribute', `<a href="/x?t=${TOKEN.slice(0, 12)}`, `<a href="/x?t=${R}`, 'text/html'],
    [
      'a multipart part',
      `--X\r\nContent-Disposition: form-data; name="u"\r\n\r\n${TOKEN.slice(0, 12)}`,
      `--X\r\nContent-Disposition: form-data; name="u"\r\n\r\n${R}`,
      'multipart/form-data; boundary=X',
    ],
  ])('hides a value cut off at the end of %s', (_where, input, expected, type) => {
    expect(redact(input, type, { cut: true })).toBe(expected);
  });
});

describe('exact boundaries', () => {
  it('hides exactly the escaped text, keeping what is around it', () => {
    expect(redact(`x Ab1\\/Cd2+Ef3=Gh4Ij5Kl6 y`, 'text/plain')).toBe(`x ${R} y`);
    expect(redact(`x zzAb1\\/Cd2+Ef3=Gh4Ij5Kl6zz y`, 'text/plain')).toBe(`x zz${R}zz y`);
  });

  it('finds a value starting with an escape, and one mixing two kinds of escape', () => {
    const known = knownWith('/Ab1Cd2Ef3Gh4Ij5', 'Ab1/Cd2/Ef3Gh4Ij5');
    expect(redact(`"\\/Ab1Cd2Ef3Gh4Ij5"`, 'text/plain', {}, known)).toBe(`"${R}"`);
    expect(redact(`k Ab1\\/Cd2\\u002fEf3Gh4Ij5 j`, 'text/plain', {}, known)).toBe(`k ${R} j`);
  });

  it('reads a cut tail back as far as a run goes, up to 4,096 characters', () => {
    const tail = TOKEN.slice(0, 12);
    expect(redact(`${'x'.repeat(5_000)}${tail}`, 'text/plain', { cut: true })).toBe(
      `${'x'.repeat(5_000)}${R}`,
    );
  });
});

describe('what stays shown', () => {
  it.each([
    // 15 characters: one too few for the inner search.
    ['a value of 15 characters inside a longer run', 'Ab1Cd2Ef3Gh4Ij5', 'id xAb1Cd2Ef3Gh4Ij5y'],
    ['a near miss differing in its first character', TOKEN, `id x${'Y' + TOKEN.slice(1)}y`],
    ['a near miss differing in its middle', TOKEN, `id x${TOKEN.slice(0, 10)}Q${TOKEN.slice(11)}y`],
    ['a near miss one character short at the start', TOKEN, `id x${TOKEN.slice(1)}y`],
  ])('%s', (_what, value, input) => {
    expect(redact(input, 'text/plain', {}, knownWith(value))).toBe(input);
  });

  it('leaves a body with no known values as it is', () => {
    const input = `id x${TOKEN}y Ab1\\/Cd2+Ef3=Gh4Ij5Kl6`;
    expect(redact(input, 'text/plain', { cut: true }, new KnownValues())).toBe(input);
  });

  it('keeps other backslash escapes as written and still finds a value after them', () => {
    expect(redact(`a\\nb\\u00GZ x ${SHORT} y`, 'text/plain')).toBe(`a\\nb\\u00GZ x ${R} y`);
  });

  it('still finds a low-variety value standing alone', () => {
    const value = 'AAAAAAAAAAAAAAAAAAAAAA==';
    expect(redact(`key: ${value}\n`, 'text/plain', {}, knownWith(value))).toBe(`key: ${R}\n`);
  });

  it('does not hide a tail that only shares the first eight characters', () => {
    expect(redact(`note ${TOKEN.slice(0, 8)}0000`, 'text/plain', { cut: true })).toBe(
      `note ${TOKEN.slice(0, 8)}0000`,
    );
  });
});

describe('where it shows', () => {
  it('in a redacted HAR export, with the secret learned from a header', () => {
    const body = `<script>var k = "Ab1\\/Cd2+Ef3=Gh4Ij5Kl6"; var u = "/dl/${TOKEN}_t.png";</script>`;
    const entry = {
      startedDateTime: '2026-11-27T00:00:00.000Z',
      time: 1,
      request: {
        method: 'GET',
        url: 'https://a.example/',
        httpVersion: 'HTTP/1.1',
        headers: [
          { name: 'Authorization', value: `Bearer ${TOKEN}` },
          { name: 'X-Api-Key', value: SLASHED },
        ],
      },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [],
        content: { size: body.length, mimeType: 'text/html', text: body },
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
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain('Gh4Ij5Kl6');
  });

  it('in a cut body with Hide Secrets and to agents (the masked body)', () => {
    const text = `{"log":"${TOKEN.slice(0, 14)}`;
    const masked = maskBytes(new TextEncoder().encode(text), 'application/json', true, knownWith(TOKEN));
    expect('bytes' in masked).toBe(true);
    expect(new TextDecoder().decode((masked as { bytes: Uint8Array }).bytes)).not.toContain(
      TOKEN.slice(0, 10),
    );
  });
});

describe('time', () => {
  // Values sharing an ending, and text built to nearly match them everywhere.
  const near = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(3, '0')}${rep('Q', 20)}Ab1Cd2Ef3`);
  it.each([
    [
      'text with a known value’s ending everywhere',
      (n: number) => rep(`x${rep('Q', 20)}Ab1Cd2Ef3`, n / 30),
      knownWith(...near),
      {},
    ],
    ['many escapes', (n: number) => rep('\\/', n / 2), knownWith(TOKEN), {}],
    ['many escaped runs', (n: number) => rep('a\\/b ', n / 5), knownWith(TOKEN), {}],
    ['a long run with no value', (n: number) => rep('Ab1', n / 3), knownWith(TOKEN), {}],
    [
      'a cut body ending in a long run',
      (n: number) => rep('x', n) + TOKEN.slice(0, 12),
      knownWith(TOKEN),
      { cut: true },
    ],
    [
      'a cut body ending in many values’ shared start',
      (n: number) => rep('y', n) + rep(TOKEN.slice(0, 8), 200),
      knownWith(
        ...Array.from({ length: 100 }, (_, i) => `${TOKEN.slice(0, 8)}${String(i).padStart(12, '0')}`),
      ),
      { cut: true },
    ],
  ])('stays linear on %s', { timeout: 60_000 }, (_what, make, known, options) => {
    const run = (text: string) => () =>
      redactBody(text, 'text/plain', known as KnownValues, options as { cut?: boolean });
    let n = 2_000;
    run(make(n))();
    while (once(run(make(n))) < 10 && make(n).length < 2_000_000) n *= 2;
    expectGrowthUnder(run(make(n)), run(make(n * 8)), 20);
  });
});
