import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { knownPart } from '../src/backend/har-redact';
import { entryTimeLimitMs, HarRedactor } from '../src/backend/redactor';

const FAKE = path.join(__dirname, 'fixtures', 'fake-redact-worker.mjs');
const META = { cut: { request: false, response: false }, base64Frames: [] };
const SECRET = 'Q2xA9fK3' + 'mZ7pL1sW8eR4tY6u';

let dir: string;
let log: string;
const redactors: HarRedactor[] = [];
const make = (file?: string): HarRedactor => {
  const redactor = file ? new HarRedactor(file) : new HarRedactor();
  redactors.push(redactor);
  return redactor;
};
/** Workers the fake has started so far. */
const started = async (): Promise<number> =>
  (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-redactor-'));
});

afterEach(async () => {
  for (const redactor of redactors.splice(0)) await redactor.close();
  log = path.join(dir, `log-${Math.random().toString(36).slice(2)}`);
  process.env.WIRESCRY_FAKE_WORKER_LOG = log;
});

afterAll(async () => {
  delete process.env.WIRESCRY_FAKE_WORKER_LOG;
  await rm(dir, { recursive: true, force: true });
});

describe('HarRedactor with the real worker, from source', () => {
  it('redacts, and finds a value from one entry’s headers in another’s body', async () => {
    const redactor = make();
    const first = {
      request: {
        url: 'https://example.com/',
        headers: [{ name: 'Authorization', value: `Bearer ${SECRET}` }],
      },
      response: {},
    };
    const second = {
      request: { url: 'https://example.com/b', headers: [] },
      response: { content: { mimeType: 'text/plain', text: `echo ${SECRET}` } },
    };
    await redactor.collect([knownPart(first), knownPart(second)]);
    const outcome = await redactor.redact(second, META);
    if (!('text' in outcome)) throw new Error(JSON.stringify(outcome));
    expect(outcome.text).not.toContain(SECRET);
    expect(JSON.parse(outcome.text).response.content.text).toBe('echo [redacted]');
    expect(outcome).toMatchObject({ values: 1, notScanned: 0, leftOut: 0, full: false });
    expect(outcome.ms).toBeGreaterThanOrEqual(0);
  });
});

describe('HarRedactor learning entries first', () => {
  const namer = {
    request: {
      url: 'https://example.com/login',
      headers: [],
      postData: { mimeType: 'application/json', text: JSON.stringify({ password: SECRET }) },
    },
    response: {},
  };
  const bare = {
    request: { url: 'https://example.com/b', headers: [] },
    response: { content: { mimeType: 'text/plain', text: `note ${SECRET}` } },
  };
  /** An entry big enough that a 1 ms limit stops the worker. */
  const big = {
    request: {
      url: 'https://example.com/big',
      headers: [],
      postData: { mimeType: 'text/plain', text: 'word '.repeat(2_000_000) },
    },
    response: {},
  };
  const textOf = (outcome: Awaited<ReturnType<HarRedactor['redact']>>): string => {
    if (!('text' in outcome)) throw new Error(JSON.stringify(outcome));
    return JSON.parse(outcome.text).response.content.text as string;
  };

  it('hides what an entry’s body named in an entry redacted after, and keeps it past a new worker', async () => {
    const redactor = make();
    expect(await redactor.learn(namer, META)).toEqual({ full: false });
    expect(textOf(await redactor.redact(bare, META))).toBe('note [redacted]');
    // The worker runs out of time and is stopped: the next one is taught what was learned.
    await expect(redactor.redact(big, META, 1)).rejects.toThrow();
    expect(textOf(await redactor.redact(bare, META))).toBe('note [redacted]');
  });

  it('without learning, or redacting without giving back, a later entry isn’t helped', async () => {
    const plain = make();
    expect(textOf(await plain.redact(bare, META))).toBe(`note ${SECRET}`);
    const kept = make();
    await kept.redact(namer, META, undefined, false);
    expect(textOf(await kept.redact(bare, META))).toBe(`note ${SECRET}`);
    // Giving back (the default, as before learning) does help.
    const given = make();
    await given.redact(namer, META);
    expect(textOf(await given.redact(bare, META))).toBe('note [redacted]');
  });

  it('tells a new worker that learning turned values away', async () => {
    const redactor = make();
    await redactor.learn(namer, META);
    (redactor as unknown as { learnedFull: boolean }).learnedFull = true;
    await expect(redactor.redact(big, META, 1)).rejects.toThrow();
    const outcome = await redactor.redact(bare, META);
    expect(outcome).toMatchObject({ full: true });
    // A redactor that never learned anything is not full.
    expect(await make().redact(bare, META)).toMatchObject({ full: false });
  });
});

describe('HarRedactor when the worker misbehaves', () => {
  it('fails the entry, and teaches the next worker what the old one knew before it redacts', async () => {
    const redactor = make(FAKE);
    await redactor.collect([{ a: 1 }, { b: 2 }]);
    await expect(redactor.redact({ mode: 'crash-first' }, META)).rejects.toThrow(
      'the redaction worker stopped',
    );
    const outcome = await redactor.redact({ mode: 'ok' }, META);
    // The second worker was taught both parts again, and redacted one entry.
    expect('text' in outcome && JSON.parse(outcome.text)).toEqual({ collected: 2, redacted: 1 });
    expect(await started()).toBe(2);
    // And it goes on with that worker, learning more.
    await redactor.collect([{ c: 3 }]);
    const next = await redactor.redact({ mode: 'ok' }, META);
    expect('text' in next && JSON.parse(next.text)).toEqual({ collected: 3, redacted: 2 });
    expect(await started()).toBe(2);
  });

  it('teaches a new worker what learning found, and that it was full, after what was collected', async () => {
    const redactor = make(FAKE);
    await redactor.collect([{ a: 1 }]);
    expect(await redactor.learn({ learned: ['v1', 'v2'] }, META)).toEqual({ full: false });
    expect(await redactor.learn({ learned: ['v3'], full: true }, META)).toEqual({ full: true });
    await expect(redactor.redact({ mode: 'crash-first' }, META)).rejects.toThrow();
    const outcome = await redactor.redact({ mode: 'ok' }, META);
    expect('text' in outcome && JSON.parse(outcome.text)).toEqual({
      collected: 1,
      redacted: 1,
      toldValues: 3,
      toldFull: true,
    });
  });

  it('fails a learn the worker can’t do, and goes on with a new worker that keeps what was learned', async () => {
    const redactor = make(FAKE);
    await redactor.learn({ learned: ['v1'] }, META);
    for (const mode of ['crash', 'fail', 'out-of-turn']) {
      await expect(redactor.learn({ mode }, META), mode).rejects.toThrow();
    }
    expect(await redactor.learn({ mode: 'dropped' }, META)).toEqual({ dropped: true });
    const outcome = await redactor.redact({ mode: 'ok' }, META);
    expect('text' in outcome && JSON.parse(outcome.text)).toMatchObject({ toldValues: 1, toldFull: false });
    // A learning answer to a redact is out of turn.
    await expect(redactor.redact({ mode: 'learned-out-of-turn' }, META)).rejects.toThrow('out of turn');
  });

  it('teaches every new worker, however many fail in a row', async () => {
    const redactor = make(FAKE);
    await redactor.collect([{ a: 1 }]);
    for (const mode of ['crash', 'hang', 'fail', 'throw', 'out-of-turn']) {
      await expect(redactor.redact({ mode }, META, 200), mode).rejects.toThrow();
    }
    const outcome = await redactor.redact({ mode: 'ok' }, META);
    expect('text' in outcome && JSON.parse(outcome.text)).toEqual({ collected: 1, redacted: 1 });
    expect(await started()).toBe(6);
  });

  it('fails each of a crash, a throw, a failure and an answer out of turn, once', async () => {
    for (const mode of ['crash', 'throw', 'fail', 'out-of-turn']) {
      const redactor = make(FAKE);
      await expect(redactor.redact({ mode }, META), mode).rejects.toThrow();
    }
    // One worker each: no second try here (the export tries with fewer bodies instead).
    expect(await started()).toBe(4);
  });

  it('fails an entry that runs out of time, once, and then works on with a new worker', async () => {
    const redactor = make(FAKE);
    const before = performance.now();
    await expect(redactor.redact({ mode: 'hang' }, META, 100)).rejects.toThrow('took too long');
    const took = performance.now() - before;
    expect(took).toBeGreaterThanOrEqual(90);
    expect(took).toBeLessThan(1000);
    const next = await redactor.redact({ mode: 'ok' }, META, 5000);
    expect('text' in next).toBe(true);
    expect(await started()).toBe(2);
  });

  it('fails a collect the worker can’t take, and a redact after it, then starts afresh', async () => {
    const redactor = make(FAKE);
    await redactor.collect([{ a: 1 }]);
    await expect(redactor.collect([{ fail: true }])).rejects.toThrow('collect failed');
    // Every new worker is taught everything collected, the bad part too: so it fails again.
    await expect(redactor.redact({ mode: 'ok' }, META)).rejects.toThrow('collect failed');
  });

  it('passes on too large and dropped as they are', async () => {
    const redactor = make(FAKE);
    expect(await redactor.redact({ mode: 'too-large' }, META)).toMatchObject({ tooLarge: true });
    expect(await redactor.redact({ mode: 'dropped' }, META)).toMatchObject({ dropped: true });
  });

  it('once closed, fails what’s waiting and anything asked later, without a new worker', async () => {
    const redactor = make(FAKE);
    const waiting = redactor.redact({ mode: 'hang' }, META, 60_000);
    const failed = expect(waiting).rejects.toThrow('redaction was stopped');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await redactor.close();
    await failed;
    await expect(redactor.redact({ mode: 'ok' }, META)).rejects.toThrow('redaction was stopped');
    await expect(redactor.collect([{}])).rejects.toThrow('redaction was stopped');
    expect(await started()).toBe(1);
  });

  it('fails when the worker can’t start at all', async () => {
    const redactor = make(path.join(dir, 'no-such-worker.mjs'));
    await expect(redactor.redact({}, META)).rejects.toThrow();
  });
});

describe('entryTimeLimitMs', () => {
  it('is 20 s, plus 3 s for each MB of text, started or not', () => {
    expect(entryTimeLimitMs({})).toBe(20_000);
    const mb = 'x'.repeat(1_000_000);
    expect(entryTimeLimitMs({ request: { postData: { text: mb } } })).toBe(23_000);
    expect(entryTimeLimitMs({ response: { content: { text: mb + 'x' } } })).toBe(26_000);
    expect(entryTimeLimitMs({ _webSocketMessages: [{ data: mb }, { data: mb }, { data: 5 }] })).toBe(26_000);
  });
});
