/**
 * Room for an exchange's own values (security review 2, F4): traffic that fills the session's
 * list of known values can't crowd out the values an exchange teaches itself. A set over a shared
 * one (`new KnownValues(session)`), shares of an exchange's room for its URL and request body,
 * headers learned before URLs, the hand-back in HAR export, and the note on every MCP tool.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  collectKnown,
  HAND_BACK_SHARE,
  knownPart,
  redactHarEntry,
  type EntryMeta,
} from '../src/backend/har-redact';
import { Masker, type MaskAnswer, type MaskBody } from '../src/backend/masker';
import { FULL_NOTE, Reader, type ReaderBackend } from '../src/backend/mcp/reader';
import { HarRedactor } from '../src/backend/redactor';
import { WindowKnown, type KnownSource } from '../src/backend/window-known';
import type { ExchangeDetail, Header } from '../src/shared/api';
import { applySpans } from '../src/shared/redact';
import {
  KnownValues,
  OWN_URL_SHARE,
  REQUEST_BODY_SHARE,
  redactBody,
  secretInBytes,
  SHARED_URL_SHARE,
} from '../src/shared/redact-body';
import { expectGrowthUnder } from './timing';

type Json = Record<string, unknown>;
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

// Fake secrets and junk, made at run time so the file holds nothing a secret scanner flags.
const SECRET = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const OTHER = 'mK7vQ2xZ' + '9pLw4RtY8nB3';
/** The nth junk value: distinctive, each with a run of its own. */
const junk = (n: number): string => `Jk${n.toString(36).padStart(6, '0')}Qz8Wm3Lp`;
/** `count` junk values from `from`, as a query string of named values. */
const junkQuery = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => `token=${junk(from + i)}`).join('&');
/** A set filled to its 10,000 with junk. */
function filled(): KnownValues {
  const set = new KnownValues();
  for (let i = 0; set.size < 10_000; i++) set.add(junk(i));
  return set;
}
/** Eight values of 2,000 characters that differ only at their start. */
const alikeLong = (): string[] => Array.from({ length: 8 }, (_, i) => `Q${i}w${'Ab1Cd2Ef3Gh4'.repeat(166)}`);

/** What `known` hides in `text`, as JSON's rules and the known values find it. */
const masked = (text: string, known: KnownValues): string =>
  applySpans(text, redactBody(text, 'application/json', known).spans);

describe('a set over another', () => {
  it('finds values from itself, from the set under it, from both, and none that aren’t there', () => {
    const parent = new KnownValues();
    parent.add(SECRET);
    const child = new KnownValues(parent);
    child.add(OTHER);
    const text = `a ${SECRET} b ${OTHER} c`;
    expect(applySpans(text, child.scan(text))).toBe('a [redacted] b [redacted] c');
    expect(applySpans(text, parent.scan(text))).toBe(`a [redacted] b ${OTHER} c`);
    expect(new KnownValues(new KnownValues()).scan(text)).toEqual([]);
  });

  it('with nothing of its own, every lookup still asks the set under it', () => {
    const parent = new KnownValues();
    parent.add(SECRET);
    const child = new KnownValues(parent);
    expect(child.size).toBe(0);
    expect(child.empty).toBe(false);
    expect(child.scan(`x ${SECRET} y`)).toHaveLength(1);
    expect(child.anywhere(`id-${SECRET}-z`)).toHaveLength(1);
    expect(child.cutTail(`cut at ${SECRET.slice(0, 12)}`)).toHaveLength(1);
    expect(child.inBytes(utf8(`\x00\x01${SECRET}\x02`))).toBe(true);
    // And through a body that isn't text, read as Latin-1.
    expect(secretInBytes(utf8(`\x00\x01k=${SECRET}\x02`), child)).toBe(true);
  });

  it('with nothing in either, finds nothing', () => {
    const child = new KnownValues(new KnownValues());
    expect(child.empty).toBe(true);
    expect(child.scan(`x ${SECRET} y`)).toEqual([]);
    expect(child.anywhere(`id-${SECRET}`)).toEqual([]);
    expect(child.cutTail(SECRET)).toEqual([]);
    expect(child.inBytes(utf8(SECRET))).toBe(false);
  });

  it('a non-ASCII value only the set under it has is found in a Latin-1 binary body', () => {
    const value = 'Pässwört9Xq7Lm2Kz';
    const parent = new KnownValues();
    parent.add(value);
    const child = new KnownValues(parent);
    const bytes = Uint8Array.from([0, 1, ...Buffer.from(` ${value} `, 'latin1'), 2]);
    expect(secretInBytes(bytes, child)).toBe(true);
    expect(secretInBytes(bytes, new KnownValues(new KnownValues()))).toBe(false);
  });

  it('adds nothing to the set under it, and a search there that gives up marks only the set asked', () => {
    const parent = new KnownValues();
    // Eight long values ending alike, and text of their pattern: the in-run search runs out of
    // budget.
    for (const value of alikeLong()) parent.add(value);
    parent.add(SECRET);
    const before = { size: parent.size, full: parent.full, list: parent.list(0, Infinity) };
    expect(before.full).toBe(false);
    const child = new KnownValues(parent);
    child.add(OTHER);
    child.scan(`${'Ab1Cd2Ef3Gh4'.repeat(1_700)}`);
    child.anywhere(`x${SECRET}`);
    child.cutTail(SECRET.slice(0, 10));
    child.inBytes(utf8(`${SECRET}${OTHER}`));
    expect({ size: parent.size, full: parent.full, list: parent.list(0, Infinity) }).toEqual(before);
    expect(child.full).toBe(true);
    expect(parent.has(OTHER)).toBe(false);
  });

  it('a search that gives up on its own values marks only the set asked', () => {
    const set = new KnownValues();
    for (const value of alikeLong()) set.add(value);
    set.scan('Ab1Cd2Ef3Gh4'.repeat(1_700));
    expect(set.full).toBe(true);
  });

  it('values too alike to index in bytes mark the set asked too', () => {
    const parent = new KnownValues();
    // Nine sharing their first eight bytes.
    for (let i = 0; i < 9; i++) parent.add(`eyJhbGci${i}Qx7Lm2Pz9Wv${i}`);
    const child = new KnownValues(parent);
    child.inBytes(utf8('nothing like them here'));
    expect(child.full).toBe(true);
  });

  it('keeps its own size and full; full follows the set under it as it is now', () => {
    const parent = new KnownValues();
    const child = new KnownValues(parent);
    child.add(SECRET);
    expect(child.size).toBe(1);
    expect(parent.size).toBe(0);
    expect(child.full).toBe(false);
    for (let i = 0; parent.size < 10_000; i++) parent.add(junk(i));
    parent.add(OTHER);
    expect(parent.full).toBe(true);
    expect(child.full).toBe(true);
    // Its own room is its own.
    expect(child.add(junk(20_000))).toBe(true);
  });

  it('has room of its own when the set under it is full', () => {
    const child = new KnownValues(filled());
    expect(child.add(SECRET)).toBe(true);
    expect(masked(`{"note":"${SECRET}"}`, child)).toBe('{"note":"[redacted]"}');
  });

  it('the review’s case: a filled session can’t stop a body hiding its password’s repeat', () => {
    const body = `{"password":"${SECRET}","note":"${SECRET}"}`;
    // One set, filled: the password's value can't be added, and its repeat shows.
    expect(masked(body, filled())).toBe(`{"password":"[redacted]","note":"${SECRET}"}`);
    // Over the filled set: both hidden.
    expect(masked(body, new KnownValues(filled()))).toBe('{"password":"[redacted]","note":"[redacted]"}');
  });

  it('a value in both sets, or inside a longer one, is hidden whole', () => {
    const long = `${SECRET}Xy7Zq2Wv`;
    const parent = new KnownValues();
    parent.add(long);
    parent.add(OTHER);
    const child = new KnownValues(parent);
    child.add(SECRET);
    child.add(OTHER);
    const text = `a ${long} b ${OTHER} c`;
    expect(applySpans(text, child.scan(text))).toBe('a [redacted] b [redacted] c');
  });

  it('a cut tail: the earliest start found in either set', () => {
    const parent = new KnownValues();
    const child = new KnownValues(parent);
    // The child's value starts later in the tail than the parent's.
    const outer = 'Rt8Vn6Yb3Kp2Lm9Qx4ZwAb7Cd';
    parent.add(outer);
    child.add(outer.slice(9) + 'Hs5Jd8');
    const text = `start ${outer.slice(0, 22)}`;
    // The child alone finds the later start.
    expect(new KnownValues().cutTail(text)).toEqual([]);
    const alone = new KnownValues();
    alone.add(outer.slice(9) + 'Hs5Jd8');
    expect(alone.cutTail(text)).toEqual([{ start: 15, end: text.length, kind: 'known value' }]);
    expect(child.cutTail(text)).toEqual([{ start: 6, end: text.length, kind: 'known value' }]);
  });

  it('a field too costly to check in the set under it is hidden whole', () => {
    const parent = new KnownValues();
    // Ten thousand values ending alike, and a field full of that ending.
    for (let i = 0; i < 10_000; i++) parent.add(`${junk(i)}-SameEnd8`);
    const child = new KnownValues(parent);
    const text = 'SameEnd8 '.repeat(200);
    expect(child.anywhere(text)).toEqual([{ start: 0, end: text.length, kind: 'known value' }]);
  });

  it('stays linear finding values anywhere in a field, with both sets full', () => {
    const parent = filled();
    const child = new KnownValues(parent);
    for (let i = 0; child.size < 10_000; i++) child.add(junk(50_000 + i));
    const field = (n: number): string => Array.from({ length: n }, (_, i) => `x${junk(i)}`).join('/');
    const small = field(200);
    const large = field(1_600);
    expectGrowthUnder(
      () => child.anywhere(small),
      () => child.anywhere(large),
      20,
    );
  });

  it('nests: a set over a set over a set finds all three', () => {
    const a = new KnownValues();
    a.add(SECRET);
    const b = new KnownValues(a);
    b.add(OTHER);
    const c = new KnownValues(b);
    c.add(junk(1));
    const text = `${SECRET} ${OTHER} ${junk(1)}`;
    expect(applySpans(text, c.scan(text))).toBe('[redacted] [redacted] [redacted]');
  });

  it('stays linear with both sets full', () => {
    const parent = filled();
    const child = new KnownValues(parent);
    for (let i = 0; child.size < 10_000; i++) child.add(junk(50_000 + i));
    const text = (n: number): string => Array.from({ length: n }, (_, i) => `%41${junk(i)}%42 `).join('');
    const small = text(2_000);
    const large = text(16_000);
    expectGrowthUnder(
      () => child.scan(small),
      () => child.scan(large),
      20,
    );
  });
});

describe('shares', () => {
  it('lets a share add at most its count of new values, and marks the set full past it', () => {
    const set = new KnownValues();
    set.share('url', 3, () => {
      for (let i = 0; i < 3; i++) expect(set.add(junk(i))).toBe(true);
      expect(set.full).toBe(false);
      expect(set.add(junk(3))).toBe(false);
    });
    expect(set.full).toBe(true);
    // Outside the share, room as usual.
    expect(set.add(junk(4))).toBe(true);
  });

  it('counts for the set’s life, so a second pass adds no more', () => {
    const set = new KnownValues();
    set.share('url', 2, () => [0, 1].forEach((i) => set.add(junk(i))));
    set.share('url', 2, () => expect(set.add(junk(2))).toBe(false));
    expect(set.size).toBe(2);
  });

  it('a value already there costs nothing and doesn’t mark the set full', () => {
    const set = new KnownValues();
    set.share('url', 1, () => set.add(junk(0)));
    set.share('url', 1, () => expect(set.add(junk(0))).toBe(false));
    expect(set.full).toBe(false);
  });

  it('each share counts apart, and a value that can’t be kept doesn’t count', () => {
    const set = new KnownValues();
    set.share('a', 1, () => {
      set.add('short');
      set.add(junk(0));
    });
    set.share('b', 1, () => expect(set.add(junk(1))).toBe(true));
    expect(set.size).toBe(2);
    expect(set.full).toBe(false);
  });

  it('the shares leave room: a URL and request body of junk still leave 5,000', () => {
    expect(10_000 - OWN_URL_SHARE - REQUEST_BODY_SHARE).toBeGreaterThanOrEqual(5_000);
    expect(SHARED_URL_SHARE).toBeLessThan(10_000);
  });
});

describe('learning an exchange: headers before the URL', () => {
  const entry = (count: number): Json => ({
    request: {
      url: `https://h.test/x?${junkQuery(0, count)}`,
      headers: [{ name: 'Authorization', value: `Bearer ${SECRET}` }],
    },
    response: {},
  });

  it('a URL of junk takes at most its share; the header’s value goes in', () => {
    const set = new KnownValues();
    collectKnown(entry(3_000), set, OWN_URL_SHARE);
    expect(set.has(SECRET)).toBe(true);
    expect(set.size).toBe(OWN_URL_SHARE + 1);
    expect(set.full).toBe(true);
  });

  it('headers go in before the URL, so a URL can’t take the last of the room', () => {
    const set = new KnownValues();
    for (let i = 0; i < 8_000; i++) set.add(junk(100_000 + i));
    collectKnown(entry(3_000), set);
    expect(set.has(SECRET)).toBe(true);
  });

  it('into a shared set, URLs leave room for header values that come after them', () => {
    const set = new KnownValues();
    // Eight URLs of 1,250: past the shared URL share.
    for (let i = 0; i < 8; i++) {
      collectKnown(
        { request: { url: `https://h${i}.test/?${junkQuery(i * 1_250, 1_250)}`, headers: [] }, response: {} },
        set,
      );
    }
    expect(set.size).toBe(SHARED_URL_SHARE);
    collectKnown(
      {
        request: { url: 'https://a.test/', headers: [{ name: 'Authorization', value: `Bearer ${SECRET}` }] },
      },
      set,
    );
    expect(set.has(SECRET)).toBe(true);
  });

  it('the limit, stated: header junk across exchanges can still fill a shared set, which says so', () => {
    const set = new KnownValues();
    for (let i = 0; i < 10_001; i++) {
      collectKnown(
        { request: { url: 'https://e.test/', headers: [{ name: 'X-Api-Key', value: junk(i) }] } },
        set,
      );
    }
    collectKnown({ request: { headers: [{ name: 'Authorization', value: `Bearer ${SECRET}` }] } }, set);
    expect(set.has(SECRET)).toBe(false);
    expect(set.full).toBe(true);
  });
});

describe('the mask worker', () => {
  let dir: string;
  const maskers: Masker[] = [];
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-known-room-'));
  });
  afterEach(async () => {
    for (const m of maskers.splice(0)) await m.close();
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A session whose exchanges' headers fill the shared list with junk, and a masker over it. */
  function crowded(extra: Record<string, Json> = {}) {
    const parts: Record<string, Json> = { ...extra };
    for (let i = 0; i < 10_100; i++) {
      parts[`j${i}`] = {
        request: { url: `https://e${i % 7}.test/`, headers: [{ name: 'X-Api-Key', value: junk(i) }] },
      };
    }
    const masker = new Masker({ all: () => Object.values(parts), part: (id: string) => parts[id] });
    maskers.push(masker);
    return masker;
  }
  const own = (url = 'https://v.test/me', headers: Header[] = []): Json => ({
    request: { url, headers: headers.map(([name, value]) => ({ name, value })) },
    response: {},
  });
  const job = (ownPart: Json, text: string, more: Partial<MaskBody> = {}): MaskBody => ({
    own: ownPart,
    body: { bytes: utf8(text), mediaType: 'application/json', cut: false },
    ...more,
  });
  const textOf = (answer: MaskAnswer): string => {
    if ('failed' in answer) throw new Error(answer.failed);
    if ('hidden' in answer.masked) throw new Error(answer.masked.hidden);
    return answer.masked.text!;
  };

  it('with the session’s list full, hides a body’s password and its repeat, and says the list is full', async () => {
    const masker = crowded();
    const answer = await masker.mask('v', job(own(), `{"password":"${SECRET}","note":"${SECRET}"}`));
    expect(textOf(answer)).toBe('{"password":"[redacted]","note":"[redacted]"}');
    expect(!('failed' in answer) && answer.full).toBe(true);
  });

  it('hides the exchange’s own Authorization value where its body repeats it', async () => {
    const masker = crowded();
    const answer = await masker.mask(
      'v',
      job(own('https://v.test/me', [['authorization', `Bearer ${OTHER}`]]), `{"echo":"${OTHER}"}`),
    );
    expect(textOf(answer)).toBe('{"echo":"[redacted]"}');
  });

  it('a request body of junk can’t crowd out what the response teaches', async () => {
    const masker = crowded();
    const form = Array.from({ length: 10_500 }, (_, i) => `password=${junk(i + 30_000)}`).join('&');
    const answer = await masker.mask(
      'v',
      job(own(), `{"password":"${SECRET}","note":"${SECRET}"}`, {
        request: { bytes: utf8(form), mediaType: 'application/x-www-form-urlencoded', cut: false },
      }),
    );
    expect(textOf(answer)).toBe('{"password":"[redacted]","note":"[redacted]"}');
  });

  it('nor can its own URL of junk', async () => {
    const masker = crowded();
    const answer = await masker.mask(
      'v',
      job(own(`https://v.test/?${junkQuery(40_000, 10_500)}`), `{"password":"${SECRET}","note":"${SECRET}"}`),
    );
    expect(textOf(answer)).toBe('{"password":"[redacted]","note":"[redacted]"}');
  });

  it('masks fields with the exchange’s own values when the session’s list is full', async () => {
    const masker = crowded();
    const answer = await masker.maskFields('v', {
      own: own('https://v.test/me', [['authorization', `Bearer ${OTHER}`]]),
      fields: [{ kind: 'text', value: `echo ${OTHER}` }],
    });
    expect(answer).toEqual({ fields: ['echo [redacted]'], full: true });
  });

  it('what a body taught isn’t kept for another exchange (a known limit), and the session is unchanged', async () => {
    const masker = crowded({ a: own('https://a.test/', [['authorization', `Bearer ${OTHER}`]]) });
    await masker.mask('v', job(own(), `{"password":"${SECRET}"}`));
    expect(textOf(await masker.mask('w', job(own('https://w.test/'), `{"note":"${SECRET}"}`)))).toBe(
      `{"note":"${SECRET}"}`,
    );
    // The session's own values are still found.
    expect(textOf(await masker.mask('w', job(own('https://w.test/'), `{"note":"${OTHER}"}`)))).toBe(
      '{"note":"[redacted]"}',
    );
  });
});

describe('HAR export', () => {
  const META: EntryMeta = { cut: { request: false, response: false }, base64Frames: [] };
  const entry = (url: string, response: string, postData?: string, headers: Json[] = []): Json => ({
    request: {
      method: 'POST',
      url,
      headers,
      ...(postData !== undefined
        ? { postData: { mimeType: 'application/x-www-form-urlencoded', text: postData } }
        : {}),
    },
    response: {
      status: 200,
      headers: [{ name: 'content-type', value: 'application/json' }],
      content: { mimeType: 'application/json', text: response },
    },
  });
  const responseOf = (out: ReturnType<typeof redactHarEntry>): string =>
    ((out.entry.response as Json).content as Json).text as string;
  const postOf = (out: ReturnType<typeof redactHarEntry>): string =>
    ((out.entry.request as Json).postData as Json).text as string;

  it('with the export’s set full, an entry’s body hides its password’s repeat', () => {
    const out = redactHarEntry(
      entry('https://v.test/', `{"password":"${SECRET}","note":"${SECRET}"}`),
      META,
      filled(),
    );
    expect(responseOf(out)).toBe('{"password":"[redacted]","note":"[redacted]"}');
  });

  it('its own URL of junk can’t crowd out what its body teaches', () => {
    const out = redactHarEntry(
      entry(`https://v.test/?${junkQuery(0, 10_500)}`, `{"password":"${SECRET}","note":"${SECRET}"}`),
      META,
      new KnownValues(),
    );
    expect(responseOf(out)).toBe('{"password":"[redacted]","note":"[redacted]"}');
  });

  it('a request body of junk hides its own repeats, and can’t crowd out the response’s', () => {
    // Its own value past the 3,000 it may hand on, but within its own room.
    const form = [
      ...Array.from({ length: 5_000 }, (_, i) => `password=${junk(i)}`),
      `password=${OTHER}`,
      `note=${OTHER}`,
      ...Array.from({ length: 5_500 }, (_, i) => `password=${junk(i + 5_000)}`),
    ].join('&');
    const out = redactHarEntry(
      entry('https://v.test/', `{"password":"${SECRET}","note":"${SECRET}"}`, form),
      META,
      new KnownValues(),
    );
    expect(responseOf(out)).toBe('{"password":"[redacted]","note":"[redacted]"}');
    expect(postOf(out)).not.toContain(OTHER);
  });

  it('keeps what an entry’s body taught for the entries after it', () => {
    const shared = new KnownValues();
    redactHarEntry(entry('https://a.test/', `{"password":"${SECRET}"}`), META, shared);
    expect(shared.has(SECRET)).toBe(true);
    const out = redactHarEntry(entry('https://b.test/', `{"note":"${SECRET}"}`), META, shared);
    expect(responseOf(out)).toBe('{"note":"[redacted]"}');
  });

  it('keeps at most a share of them, and says the set is full past it', () => {
    const shared = new KnownValues();
    const body = JSON.stringify(
      Object.fromEntries(Array.from({ length: HAND_BACK_SHARE + 10 }, (_, i) => [`password${i}`, junk(i)])),
    );
    redactHarEntry(entry('https://a.test/', body), META, shared);
    expect(shared.size).toBe(HAND_BACK_SHARE);
    expect(shared.full).toBe(true);
  });

  it('says the export’s list is full when only the entry’s own set turned a value away', () => {
    const shared = new KnownValues();
    redactHarEntry(entry(`https://v.test/?${junkQuery(0, 3_000)}`, '{}'), META, shared);
    expect(shared.full).toBe(true);
    const quiet = new KnownValues();
    redactHarEntry(entry('https://v.test/', `{"password":"${SECRET}"}`), META, quiet);
    expect(quiet.full).toBe(false);
  });

  it('hands back only what its bodies taught: URL junk can’t take a password’s place', () => {
    const shared = new KnownValues();
    for (let i = 0; i < 8_000; i++) shared.add(junk(100_000 + i));
    redactHarEntry(entry(`https://v.test/?${junkQuery(0, 3_000)}`, `{"password":"${SECRET}"}`), META, shared);
    expect(shared.has(SECRET)).toBe(true);
    expect(shared.has(junk(0))).toBe(false);
    expect(shared.size).toBe(8_001);
    const out = redactHarEntry(entry('https://b.test/', `{"note":"${SECRET}"}`), META, shared);
    expect(responseOf(out)).toBe('{"note":"[redacted]"}');
  });

  it('a value already in the export’s set costs nothing to hand back', () => {
    const shared = new KnownValues();
    shared.add(SECRET);
    redactHarEntry(entry('https://a.test/', `{"password":"${SECRET}"}`), META, shared);
    expect(shared.size).toBe(1);
    expect(shared.full).toBe(false);
  });

  it('the export collects every header before any URL: URLs of junk can’t crowd out a token', async () => {
    const redactor = new HarRedactor();
    try {
      const first = Array.from({ length: 9 }, (_, i) =>
        entry(`https://j${i}.test/?${junkQuery(i * 1_250, 1_250)}`, '{}'),
      );
      const auth = entry('https://a.test/', '{}', undefined, [
        { name: 'Authorization', value: `Bearer ${SECRET}` },
      ]);
      const echo = entry('https://b.test/', `{"echo":"${SECRET}"}`);
      // And 2,500 header values: with URLs first, these would fill what the URL share left.
      const headers = Array.from({ length: 2_500 }, (_, i) =>
        entry(`https://h${i}.test/`, '{}', undefined, [{ name: 'X-Api-Key', value: junk(200_000 + i) }]),
      );
      await redactor.collect([...first, ...headers, auth, echo].map((e) => knownPart(e)));
      const outcome = await redactor.redact(echo, META);
      expect('text' in outcome && outcome.text).toContain('"echo\\":\\"[redacted]');
    } finally {
      await redactor.close();
    }
  });
});

describe('the window’s list', () => {
  const exchange = (id: string, url: string, headers: Header[] = []): ExchangeDetail =>
    ({
      summary: {
        id,
        method: 'GET',
        protocol: 'https',
        httpVersion: '1.1',
        host: 'a.test',
        path: '/',
        url,
        startedAt: 0,
      },
      requestHeaders: headers,
      timing: {},
    }) as ExchangeDetail;

  it('URLs of junk leave room for a header value learned after them', async () => {
    const map = new Map<string, ExchangeDetail>();
    for (let i = 0; i < 9; i++)
      map.set(`j${i}`, exchange(`j${i}`, `https://j${i}.test/?${junkQuery(i * 1_250, 1_250)}`));
    map.set('a', exchange('a', 'https://a.test/', [['authorization', `Bearer ${SECRET}`]]));
    const source: KnownSource = { ids: () => [...map.keys()], get: (id) => map.get(id) };
    const known = new WindowKnown(source, { flush: () => undefined });
    const epoch = known.watch(true)!;
    let page = await known.page(epoch, 0);
    const values = [...page.values];
    while (!page.done) {
      page = await known.page(epoch, page.next);
      values.push(...page.values);
    }
    expect(values).toContain(SECRET);
    expect(values.length).toBe(SHARED_URL_SHARE + 1);
    known.watch(false);
  });
});

describe('the MCP tools say when the list was full', () => {
  const detail = (id: string, summary: Record<string, unknown> = {}): ExchangeDetail =>
    ({
      summary: {
        id,
        method: 'GET',
        protocol: 'https',
        httpVersion: '1.1',
        host: 'h.test',
        path: '/',
        url: 'https://h.test/',
        startedAt: 0,
        ...summary,
      },
      requestHeaders: [],
      responseBody: { size: 10, stored: 10 },
      timing: {},
    }) as unknown as ExchangeDetail;
  function reader(full: boolean): Reader {
    const exchanges: Record<string, ExchangeDetail> = {
      a: detail('a'),
      bin: detail('bin'),
      ws: detail('ws', { websocket: true }),
      sse: detail('sse', { contentType: 'text/event-stream' }),
    };
    const backend: ReaderBackend = {
      summaries: () => Object.values(exchanges).map((e) => e.summary),
      detail: (id) => exchanges[id],
      maskFields: async (fields) => ({ fields: fields.map((f) => f.value), full }),
      part: () => ({}),
      body: async (d) =>
        d.summary.id === 'bin'
          ? ({
              size: 10,
              truncated: false,
              masked: { ranges: [], binary: true, ...(full ? { full: true } : {}) },
            } as never)
          : ({
              size: 10,
              truncated: false,
              masked: { text: 'x'.repeat(10), ranges: [], ...(full ? { full: true } : {}) },
            } as never),
      wsPage: () =>
        ({
          messages: [{ index: 0, fromClient: false, time: 0, size: 1, isBinary: false, base64: 'eA==' }],
          dropped: 0,
          total: 1,
        }) as never,
      maskMessages: async (_d, page) =>
        ({
          ...page,
          messages: page.messages.map((m) => ({
            ...m,
            masked: { text: 'x', ranges: [], ...(full ? { full: true } : {}) },
          })),
        }) as never,
      sseRead: async () => ({ serial: 1, total: 1, receiving: false, items: [] }) as never,
      maskEvents: async (_d, view) => ({ ...view, ...(full ? { full: true } : {}) }) as never,
      generation: () => 1,
    };
    return new Reader(backend);
  }

  it('in each tool’s result when it was, and not when it wasn’t', async () => {
    for (const full of [true, false]) {
      const r = reader(full);
      const expected = full ? FULL_NOTE : undefined;
      expect((await r.list(undefined, 10, undefined)).note, 'list').toBe(expected);
      expect((await r.get('a')).note, 'get').toBe(expected);
      const noteOf = (slice: unknown): unknown => (slice as { note?: string }).note;
      expect(noteOf(await r.body('a', 'response', 0, 5)), 'body').toBe(expected);
      // Every slice, from the cache too.
      expect(noteOf(await r.body('a', 'response', 5, 5)), 'body again').toBe(expected);
      expect(noteOf(await r.body('bin', 'response', 0, 5)), 'binary body').toBe(expected);
      expect((await r.messages('ws', -1, 10)).note, 'messages').toBe(expected);
      expect((await r.events('sse', 0)).note, 'events').toBe(expected);
    }
  });

  it('joins an event stream’s problem and the full note', async () => {
    const r = reader(true);
    (r as unknown as { backend: ReaderBackend }).backend.maskEvents = async (_d, view) =>
      ({ ...view, problem: 'Some events were lost.', full: true }) as never;
    expect((await r.events('sse', 0)).note).toBe(`Some events were lost. ${FULL_NOTE}`);
  });
});
