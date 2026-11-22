/**
 * The mask service (src/backend/masker.ts): bodies masked in a worker with the session's known
 * values, one at a time, failing closed.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MASK_FAILED,
  MASK_TOO_SLOW,
  Masker,
  maskTimeLimitMs,
  Superseded,
  type MaskAnswer,
  type MaskBody,
} from '../src/backend/masker';

const FAKE = path.join(__dirname, 'fixtures', 'fake-mask-worker.mjs');
// Fake tokens, built at run time so the file itself holds nothing a secret scanner flags.
const SECRET = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';
const OTHER = 'mK7vQ2xZ' + '9pLw4RtY8nB3';

type Json = Record<string, unknown>;
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

let dir: string;
let log: string;
const maskers: Masker[] = [];

/** A session of exchanges, by name, each an HAR part. */
function session(parts: Record<string, Json> = {}) {
  return {
    parts,
    source: {
      all: () => Object.values(parts),
      part: (id: string) => parts[id],
    },
  };
}

function make(
  source: ReturnType<typeof session>['source'],
  file?: string,
  limits?: ConstructorParameters<typeof Masker>[2],
): Masker {
  const masker = file ? new Masker(source, file, limits) : new Masker(source);
  maskers.push(masker);
  return masker;
}

const part = (name: string, authorization?: string): Json => ({
  name,
  request: {
    url: `https://example.com/${name}`,
    headers: authorization ? [{ name: 'Authorization', value: `Bearer ${authorization}` }] : [],
  },
  response: {},
});

const job = (own: Json, text: string, more: Partial<MaskBody> = {}): MaskBody => ({
  own,
  body: { bytes: utf8(text), mediaType: 'text/plain', cut: false },
  ...more,
});

function textOf(answer: MaskAnswer): string | undefined {
  if ('failed' in answer) throw new Error(answer.failed);
  if ('hidden' in answer.masked) throw new Error(answer.masked.hidden);
  return answer.masked.text;
}

/** What the fake worker says it was taught, and which worker it was. */
const fake = (answer: MaskAnswer): { taught: string[]; worker: number } => JSON.parse(textOf(answer)!);

const started = async (): Promise<number> =>
  (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-masker-'));
});

afterEach(async () => {
  for (const masker of maskers.splice(0)) await masker.close();
  log = path.join(dir, `log-${Math.random().toString(36).slice(2)}`);
  process.env.WIRESCRY_FAKE_WORKER_LOG = log;
});

afterAll(async () => {
  delete process.env.WIRESCRY_FAKE_WORKER_LOG;
  await rm(dir, { recursive: true, force: true });
});

describe('Masker with the real worker, from source', () => {
  it('hides a value seen in another exchange’s headers, and in the body’s own', async () => {
    const { source } = session({ a: part('a', SECRET), b: part('b') });
    const masker = make(source);
    expect(textOf(await masker.mask('b', job(part('b'), `echo ${SECRET} done`)))).toBe(
      'echo [redacted] done',
    );
    // Its own exchange's values, even if the session doesn't have it yet.
    expect(textOf(await masker.mask('c', job(part('c', OTHER), `x ${OTHER} y`)))).toBe('x [redacted] y');
  });

  it('still hides another exchange’s value after teaching it failed once', async () => {
    const { parts, source } = session({ a: part('a', SECRET), b: { ...part('b'), fn: () => 1 } });
    const masker = make(source);
    expect(await masker.mask('c', job(part('c'), `echo ${SECRET}`))).toEqual({ failed: MASK_FAILED });
    parts.b = part('b');
    expect(textOf(await masker.mask('c', job(part('c'), `echo ${SECRET}`)))).toBe('echo [redacted]');
  });

  it('learns a response’s request body first', async () => {
    const masker = make(session().source);
    const answer = await masker.mask(
      'a',
      job(part('a'), `{"echo":"${SECRET}"}`, {
        request: {
          bytes: utf8(`password=${SECRET}`),
          mediaType: 'application/x-www-form-urlencoded',
          cut: false,
        },
      }),
    );
    expect(textOf(answer)).toBe('{"echo":"[redacted]"}');
  });

  it('learns an exchange that changed before the next body, and forgets all on reset', async () => {
    const { parts, source } = session({ a: part('a') });
    const masker = make(source, undefined);
    expect(textOf(await masker.mask('x', job(part('x'), `t ${SECRET} t`)))).toBe(`t ${SECRET} t`);
    parts.a = part('a', SECRET);
    masker.touched('a');
    expect(textOf(await masker.mask('x', job(part('x'), `t ${SECRET} t`)))).toBe('t [redacted] t');
    delete parts.a;
    masker.reset();
    expect(textOf(await masker.mask('x', job(part('x'), `t ${SECRET} t`)))).toBe(`t ${SECRET} t`);
  });

  it('masks the formatted text too, or says it can’t', async () => {
    const masker = make(session({ a: part('a', SECRET) }).source);
    const answer = await masker.mask('b', {
      ...job(part('b'), `var a="${SECRET}";`),
      formatted: `var a = "${SECRET}";`,
    });
    if ('failed' in answer) throw new Error(answer.failed);
    expect(answer.formatted).toBe('var a = "[redacted]";');
    // More values masked than it will look for again: refused, not shown in part.
    const many = Array.from({ length: 5_001 }, (_, i) => `v${i}Zq9Xw8Vu7Ts6`);
    const hidden = await masker.mask('b', {
      ...job(part('b'), many.map((v) => `password=${v}`).join('\n')),
      formatted: 'anything',
    });
    if ('failed' in hidden) throw new Error(hidden.failed);
    expect(hidden.formatted).toBeNull();
  });
});

describe('Masker failing closed', () => {
  it('answers too slow for a job that runs out of time, then starts a new worker taught everything', async () => {
    const { source } = session({ a: part('a'), b: part('b') });
    const masker = make(source, FAKE, { timeLimitMs: () => 200 });
    expect(await masker.mask('x', job({ mode: 'hang' }, 'x'))).toEqual({ failed: MASK_TOO_SLOW });
    const next = fake(await masker.mask('x', job({}, 'x')));
    expect(next).toEqual({ taught: ['a', 'b'], worker: 2 });
  });

  it('answers failed for a crash, an error, a throw or a wrong answer, and recovers each time', async () => {
    const masker = make(session({ a: part('a') }).source, FAKE);
    for (const mode of ['crash', 'fail', 'throw', 'out-of-turn']) {
      expect(await masker.mask('x', job({ mode }, 'x')), mode).toEqual({ failed: MASK_FAILED });
      expect(fake(await masker.mask('x', job({}, 'x'))).taught, mode).toEqual(['a']);
    }
    // Each stopped its worker: one to start, and one more after each.
    expect(await started()).toBe(5);
  });

  it('answers failed when teaching fails, and tries afresh next time', async () => {
    const { parts, source } = session({ a: { ...part('a'), fail: true } });
    const masker = make(source, FAKE);
    expect(await masker.mask('x', job({}, 'x'))).toEqual({ failed: MASK_FAILED });
    parts.a = part('a');
    expect(fake(await masker.mask('x', job({}, 'x'))).taught).toEqual(['a']);
  });

  it('answers failed when what it teaches can’t be posted, and teaches it all to a new worker next time', async () => {
    // A value that can't be copied to the worker: posting the chunk throws.
    const { parts, source } = session({ a: part('a'), b: { ...part('b'), fn: () => 1 } });
    const masker = make(source, FAKE, { teachChunk: 1 });
    expect(await masker.mask('x', job({}, 'x'))).toEqual({ failed: MASK_FAILED });
    parts.b = part('b');
    // Not just what changed since: a teaching that failed partway taught this worker nothing for sure.
    expect(fake(await masker.mask('x', job({}, 'x'))).taught).toEqual(['a', 'b']);
  });

  it('answers failed when reading every exchange throws, and reads them all again next time', async () => {
    const { source } = session({ a: part('a'), b: part('b') });
    let fail = true;
    const masker = make(
      {
        all: () => {
          if (fail) throw new Error('store busy');
          return source.all();
        },
        part: source.part,
      },
      FAKE,
    );
    expect(await masker.mask('x', job({}, 'x'))).toEqual({ failed: MASK_FAILED });
    fail = false;
    expect(fake(await masker.mask('x', job({}, 'x'))).taught).toEqual(['a', 'b']);
  });

  it('teaches in chunks, and only what changed after the first job', async () => {
    const { parts, source } = session({ a: part('a'), b: part('b'), c: part('c') });
    const masker = make(source, FAKE, { teachChunk: 2 });
    // Before the first job, nothing is tracked.
    masker.touched('a');
    expect(fake(await masker.mask('x', job({}, 'x'))).taught).toEqual(['a', 'b', 'c']);
    parts.d = part('d');
    masker.touched('d');
    masker.touched('gone');
    expect(fake(await masker.mask('x', job({}, 'x'))).taught).toEqual(['a', 'b', 'c', 'd']);
    expect(await started()).toBe(1);
  });

  it('starts a new worker after a reset', async () => {
    const masker = make(session({ a: part('a') }).source, FAKE);
    expect(fake(await masker.mask('x', job({}, 'x'))).worker).toBe(1);
    masker.reset();
    expect(fake(await masker.mask('x', job({}, 'x')))).toEqual({ taught: ['a'], worker: 2 });
  });
});

describe('Masker queue', () => {
  it('runs one job at a time and drops waiting jobs for all but the two latest exchanges', async () => {
    const masker = make(session().source, FAKE);
    const running = masker.mask('a', job({ mode: 'slow' }, 'a'));
    const b = masker.mask('b', job({}, 'b'));
    const bAgain = masker.mask('b', job({}, 'b2'));
    const c = masker.mask('c', job({}, 'c'));
    const d = masker.mask('d', job({}, 'd'));
    await expect(b).rejects.toBeInstanceOf(Superseded);
    await expect(bAgain).rejects.toBeInstanceOf(Superseded);
    // The one running isn't stopped; the two latest run after it.
    expect('failed' in (await running)).toBe(false);
    expect('failed' in (await c)).toBe(false);
    expect('failed' in (await d)).toBe(false);
    expect(await started()).toBe(1);
  });

  it('keeps both sides of the exchange shown', async () => {
    const masker = make(session().source, FAKE);
    const first = masker.mask('a', job({ mode: 'slow' }, 'a'));
    const request = masker.mask('b', job({}, 'request'));
    const response = masker.mask('b', job({}, 'response'));
    await Promise.all([first, request, response]);
  });

  it('fails what’s waiting when closed, and takes nothing more', async () => {
    const masker = make(session().source, FAKE);
    const running = masker.mask('a', job({ mode: 'hang' }, 'a'));
    const waiting = masker.mask('a', job({}, 'a'));
    const waited = expect(waiting).rejects.toThrow('stopping');
    await masker.close();
    await waited;
    expect(await running).toEqual({ failed: MASK_FAILED });
    await expect(masker.mask('a', job({}, 'a'))).rejects.toThrow('stopping');
  });

  it('gives a body 20 s and 3 s more for each MB', () => {
    expect(maskTimeLimitMs(job({}, 'x'))).toBe(23_000);
    expect(
      maskTimeLimitMs({
        own: {},
        body: { bytes: new Uint8Array(2_500_000), mediaType: '', cut: false },
        request: { bytes: new Uint8Array(500_000), mediaType: '', cut: false },
        formatted: 'x'.repeat(1_000_000),
      }),
    ).toBe(20_000 + 4 * 3_000);
  });
});

describe('Masker: pages of messages and events', () => {
  it('masks a WebSocket page with its own exchange’s values and the session’s', async () => {
    const masker = make(session({ a: part('a', SECRET) }).source);
    const answer = await masker.maskMessages('w', {
      own: part('w', OTHER),
      stream: { key: 'w', fresh: true },
      messages: [
        { bytes: utf8(`hi ${SECRET}`), binary: false, cut: false },
        { bytes: utf8(`{"echo":"${OTHER}"}`), binary: false, cut: false },
      ],
    });
    if ('failed' in answer) throw new Error(answer.failed);
    expect(answer.messages.map((m) => ('hidden' in m ? m.hidden : m.text))).toEqual([
      'hi [redacted]',
      '{"echo":"[redacted]"}',
    ]);
  });

  it('masks a page of events with the session’s values', async () => {
    const masker = make(session({ a: part('a', SECRET) }).source);
    const answer = await masker.maskEvents('s', {
      own: part('s'),
      stream: { key: 's', fresh: true },
      items: [{ kind: 'event', index: 1, type: 'message', data: `x ${SECRET}` }],
    });
    if ('failed' in answer) throw new Error(answer.failed);
    expect(answer.items).toEqual([{ kind: 'event', index: 1, type: 'message', data: 'x [redacted]' }]);
  });

  it('fails closed on an answer of the wrong kind, and starts a new worker', async () => {
    const masker = make(session().source, FAKE);
    // The fake answers every job as a body.
    expect(
      await masker.maskMessages('w', { own: {}, stream: { key: 'w', fresh: true }, messages: [] }),
    ).toEqual({ failed: MASK_FAILED });
    expect(await masker.maskEvents('s', { own: {}, stream: { key: 's', fresh: true }, items: [] })).toEqual({
      failed: MASK_FAILED,
    });
    expect(await started()).toBe(2);
  });

  it('fails closed when a page runs out of time', async () => {
    const masker = make(session().source, FAKE, { timeLimitMs: () => 200 });
    expect(
      await masker.maskMessages('w', {
        own: { mode: 'hang' },
        stream: { key: 'w', fresh: true },
        messages: [],
      }),
    ).toEqual({
      failed: MASK_TOO_SLOW,
    });
  });

  it('gives a page 20 s and 3 s more for each MB', () => {
    expect(
      maskTimeLimitMs({
        op: 'messages',
        own: {},
        stream: { key: 'w', fresh: true },
        messages: [{ bytes: new Uint8Array(1_500_000), binary: false, cut: false }],
      }),
    ).toBe(26_000);
    expect(
      maskTimeLimitMs({
        op: 'events',
        own: {},
        stream: { key: 's', fresh: true },
        items: [
          { kind: 'event', index: 1, type: 'm', data: 'x'.repeat(999_999) },
          { kind: 'comment', index: 2, text: 'yy' },
        ],
      }),
    ).toBe(26_000);
  });
});

describe('Masker: what a stream learns, page to page', () => {
  const page = (text: string) => [{ bytes: utf8(text), binary: false, cut: false }];
  const texts = (answer: Awaited<ReturnType<Masker['maskMessages']>>) => {
    if ('failed' in answer) throw new Error(answer.failed);
    return answer.messages.map((m) => ('hidden' in m ? m.hidden : m.text));
  };
  const learned = `{"token":"${SECRET}"}`;

  it('hides in a later page a value an earlier page found by a rule', async () => {
    const masker = make(session().source);
    await masker.maskMessages('w', {
      own: part('w'),
      stream: { key: 'a', fresh: true },
      messages: page(learned),
    });
    const next = await masker.maskMessages('w', {
      own: part('w'),
      stream: { key: 'a', fresh: false },
      messages: page(`resumed ${SECRET}`),
    });
    expect(texts(next)).toEqual(['resumed [redacted]']);
    expect('lost' in next && next.lost).toBe(false);
  });

  it('keeps what a stream learned when it’s read from the start again, and doesn’t share it with another', async () => {
    const masker = make(session().source);
    await masker.maskMessages('w', {
      own: part('w'),
      stream: { key: 'a', fresh: true },
      messages: page(learned),
    });
    const again = await masker.maskMessages('w', {
      own: part('w'),
      stream: { key: 'a', fresh: true },
      messages: page(`x ${SECRET}`),
    });
    expect(texts(again)).toEqual(['x [redacted]']);
    const other = await masker.maskMessages('v', {
      own: part('v'),
      stream: { key: 'b', fresh: true },
      messages: page(`x ${SECRET}`),
    });
    expect(texts(other)).toEqual([`x ${SECRET}`]);
  });

  it('says a stream was lost when a page from partway finds nothing learned: after a restart, or 20 other streams', async () => {
    const masker = make(session().source);
    const first = await masker.maskMessages('w', {
      own: part('w'),
      stream: { key: 'a', fresh: false },
      messages: page('x'),
    });
    expect('lost' in first && first.lost).toBe(true);
    // Now it has something: not lost.
    const second = await masker.maskMessages('w', {
      own: part('w'),
      stream: { key: 'a', fresh: false },
      messages: page('y'),
    });
    expect('lost' in second && second.lost).toBe(false);
    masker.reset();
    const restarted = await masker.maskMessages('w', {
      own: part('w'),
      stream: { key: 'a', fresh: false },
      messages: page('z'),
    });
    expect('lost' in restarted && restarted.lost).toBe(true);
    for (let i = 0; i < 20; i++) {
      await masker.maskEvents('s', { own: part('s'), stream: { key: `other${i}`, fresh: true }, items: [] });
    }
    const evicted = await masker.maskMessages('w', {
      own: part('w'),
      stream: { key: 'a', fresh: false },
      messages: page('z'),
    });
    expect('lost' in evicted && evicted.lost).toBe(true);
  });

  it('takes the session’s values taught between pages', async () => {
    const { parts, source } = session();
    const masker = make(source);
    await masker.maskMessages('w', {
      own: part('w'),
      stream: { key: 'a', fresh: true },
      messages: page('hello'),
    });
    parts.b = part('b', OTHER);
    masker.touched('b');
    const next = await masker.maskMessages('w', {
      own: part('w'),
      stream: { key: 'a', fresh: false },
      messages: page(`x ${OTHER}`),
    });
    expect(texts(next)).toEqual(['x [redacted]']);
  });
});

describe('Masker: an agent’s jobs and the window’s', () => {
  it('runs the window’s waiting jobs before an agent’s, and drops neither', async () => {
    const masker = make(session().source, FAKE);
    const order: string[] = [];
    const track = (name: string, p: Promise<unknown>) => p.then(() => order.push(name));
    const running = track('agent 1', masker.mask('mcp:a', job({ mode: 'slow' }, 'a')));
    const agent2 = track('agent 2', masker.mask('mcp:b', job({}, 'b')));
    const agent3 = track('agent 3', masker.mask('mcp:c', job({}, 'c')));
    const window = track('window', masker.mask('w', job({}, 'w')));
    await Promise.all([running, agent2, agent3, window]);
    expect(order).toEqual(['agent 1', 'window', 'agent 2', 'agent 3']);
  });
});
