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

describe('HarRedactor when the worker misbehaves', () => {
  it('teaches a new worker what the old one knew, and tries the entry once more', async () => {
    const redactor = make(FAKE);
    await redactor.collect([{ a: 1 }, { b: 2 }]);
    const outcome = await redactor.redact({ mode: 'crash-first' }, META);
    if (!('text' in outcome)) throw new Error(JSON.stringify(outcome));
    // The second worker was taught both parts again, and redacted one entry.
    expect(JSON.parse(outcome.text)).toEqual({ collected: 2, redacted: 1 });
    expect(await started()).toBe(2);
    // And it goes on with that worker.
    const next = await redactor.redact({ mode: 'ok' }, META);
    expect('text' in next && JSON.parse(next.text)).toEqual({ collected: 2, redacted: 2 });
    expect(await started()).toBe(2);
  });

  it('fails after a second crash, a throw, a failure, or an answer out of turn', async () => {
    for (const mode of ['crash', 'throw', 'fail', 'out-of-turn']) {
      const redactor = make(FAKE);
      await expect(redactor.redact({ mode }, META), mode).rejects.toThrow();
    }
  });

  it('fails an entry that runs out of time, twice, and then works on with a new worker', async () => {
    const redactor = make(FAKE);
    const before = performance.now();
    await expect(redactor.redact({ mode: 'hang' }, META, 100)).rejects.toThrow('took too long');
    expect(performance.now() - before).toBeGreaterThanOrEqual(190);
    const next = await redactor.redact({ mode: 'ok' }, META, 5000);
    expect('text' in next).toBe(true);
    expect(await started()).toBe(3);
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
  it('is a minute, plus 3 s for each MB of text, started or not', () => {
    expect(entryTimeLimitMs({})).toBe(60_000);
    const mb = 'x'.repeat(1_000_000);
    expect(entryTimeLimitMs({ request: { postData: { text: mb } } })).toBe(63_000);
    expect(entryTimeLimitMs({ response: { content: { text: mb + 'x' } } })).toBe(66_000);
    expect(entryTimeLimitMs({ _webSocketMessages: [{ data: mb }, { data: mb }, { data: 5 }] })).toBe(66_000);
  });
});
