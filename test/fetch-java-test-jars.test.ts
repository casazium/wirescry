/**
 * Fetching the Java agent's pinned jars (scripts/build-java-agent.mjs `fetchPinned`,
 * scripts/fetch-java-test-jars.mjs) and the CI steps that cache them (.github/workflows/
 * java-agent.yml). Maven Central sometimes answers a runner with a 429 or a stray 404, which
 * failed whole test jobs: a failed ask is retried with waits, the jars are fetched before the
 * tests and cached under a key of their own.
 *
 * No network: fetch is faked.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { FETCH_ATTEMPTS, fetchPinned, retryWait, testJars } from '../scripts/build-java-agent.mjs';
import { allTestJars, fetchAll } from '../scripts/fetch-java-test-jars.mjs';

const BYTES = Buffer.from('a jar, pretend');
const SHA = createHash('sha256').update(BYTES).digest('hex');

type Answer = number | Error | { status: number; retryAfter?: string } | 'cut' | 'wrong';

/** A fetch that gives `answers` in turn (the last one again after), noting each ask. */
function fakeFetch(answers: Answer[]) {
  const asks: string[] = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  /** Failed answers whose bodies were let go of, unread. */
  const released = { count: 0 };
  const fetch = async (url: string, init?: RequestInit) => {
    const answer = answers[Math.min(asks.length, answers.length - 1)]!;
    asks.push(url);
    signals.push(init?.signal);
    if (answer instanceof Error) throw answer;
    if (answer === 'cut') {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: () => Promise.reject(new Error('terminated')),
      } as unknown as Response;
    }
    if (answer === 'wrong') return new Response('other bytes', { status: 200 });
    const { status, retryAfter } = typeof answer === 'number' ? { status: answer } : answer;
    const headers = retryAfter === undefined ? undefined : { 'retry-after': retryAfter };
    const failed = new ReadableStream({
      cancel: () => {
        released.count++;
      },
    });
    return new Response(status === 200 ? BYTES : failed, { status, headers });
  };
  return { fetch, asks, signals, released };
}

describe('fetching a pinned jar', () => {
  let dir: string;
  let jar: { url: string; sha256: string; file: string };
  let waits: number[];
  const wait = async (ms: number) => {
    waits.push(ms);
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'wirescry-fetch-pinned-'));
    jar = { url: 'https://maven.test/a.jar', sha256: SHA, file: path.join(dir, 'deps', 'a.jar') };
    waits = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fetchWith = (answers: Answer[]) => {
    const fake = fakeFetch(answers);
    const result = fetchPinned(jar, 'a', { fetch: fake.fetch, wait, random: () => 0 });
    return { asks: fake.asks, signals: fake.signals, released: fake.released, result };
  };
  const leftovers = () => readdirSync(path.dirname(jar.file)).filter((f) => f !== 'a.jar');

  it('fetches it once when the first ask works, without waiting, with a time limit', async () => {
    const { asks, signals, result } = fetchWith([200]);
    expect(await result).toBe(jar.file);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(readFileSync(jar.file)).toEqual(BYTES);
    expect(asks).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('asks again after a 429, a 404 and a 503, waiting longer each time', async () => {
    const { asks, released, result } = fetchWith([429, 404, 503, 200]);
    expect(await result).toBe(jar.file);
    expect(asks).toHaveLength(4);
    // Each failed answer's body let go of, so its connection isn't held open.
    expect(released.count).toBe(3);
    expect(waits).toEqual([2_000, 5_000, 15_000]);
    expect(readFileSync(jar.file)).toEqual(BYTES);
  });

  it('asks again after a network error or a body cut short', async () => {
    const { asks, result } = fetchWith([new Error('ECONNRESET'), 'cut', 200]);
    expect(await result).toBe(jar.file);
    expect(asks).toHaveLength(3);
    expect(waits).toHaveLength(2);
    expect(leftovers()).toEqual([]);
  });

  it('waits as long as a 429’s or a 503’s Retry-After asks, then as usual after a plain failure', async () => {
    const { result } = fetchWith([
      { status: 429, retryAfter: '20' },
      { status: 503, retryAfter: '10' },
      new Error('ECONNRESET'),
      200,
    ]);
    await result;
    expect(waits).toEqual([20_000, 10_000, 15_000]);
  });

  it('stops at bytes that don’t match the pin, even after failed asks', async () => {
    const { asks, result } = fetchWith([429, 'wrong', 200]);
    await expect(result).rejects.toThrow(/not the pinned/);
    expect(asks).toHaveLength(2);
    expect(waits).toEqual([2_000]);
    expect(existsSync(jar.file)).toBe(false);
  });

  it('gives up after FETCH_ATTEMPTS asks, saying why and how often, with nothing written', async () => {
    const { asks, result } = fetchWith([404]);
    await expect(result).rejects.toThrow(
      `Fetching a from https://maven.test/a.jar: HTTP 404 (asked ${FETCH_ATTEMPTS} times)`,
    );
    expect(asks).toHaveLength(FETCH_ATTEMPTS);
    expect(waits).toEqual([2_000, 5_000, 15_000, 30_000]);
    expect(existsSync(jar.file)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('never keeps bytes that don’t match the pin, and doesn’t ask again for them', async () => {
    const { asks, result } = fetchWith(['wrong', 200]);
    await expect(result).rejects.toThrow(/SHA-256 is [0-9a-f]{64}, not the pinned .*Not used/);
    expect(asks).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(existsSync(jar.file)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('uses a matching jar already there without asking', async () => {
    mkdirSync(path.dirname(jar.file), { recursive: true });
    writeFileSync(jar.file, BYTES);
    const { asks, result } = fetchWith([500]);
    expect(await result).toBe(jar.file);
    expect(asks).toEqual([]);
  });

  it('replaces a jar there that doesn’t match', async () => {
    mkdirSync(path.dirname(jar.file), { recursive: true });
    writeFileSync(jar.file, 'stale');
    const { asks, result } = fetchWith([200]);
    expect(await result).toBe(jar.file);
    expect(asks).toHaveLength(1);
    expect(readFileSync(jar.file)).toEqual(BYTES);
  });
});

describe('the wait before asking again', () => {
  const none = () => 0;

  it('grows with each failed ask, and stays at its longest after', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => retryWait(n, null, none))).toEqual([
      2_000, 5_000, 15_000, 30_000, 30_000, 30_000,
    ]);
  });

  it('follows a longer Retry-After in seconds, waiting a minute at most', () => {
    expect(retryWait(1, '20', none)).toBe(20_000);
    expect(retryWait(1, '60', none)).toBe(60_000);
    expect(retryWait(1, '61', none)).toBe(60_000);
    expect(retryWait(1, '3600', none)).toBe(60_000);
    expect(retryWait(3, '1', none)).toBe(15_000);
    expect(retryWait(1, '0', none)).toBe(2_000);
  });

  it('ignores a Retry-After it can’t use: negative, empty, a date or nonsense', () => {
    for (const value of ['-5', '', ' ', 'Wed, 21 Oct 2026 07:28:00 GMT', 'soon', 'Infinity']) {
      expect(retryWait(2, value, none), JSON.stringify(value)).toBe(5_000);
    }
  });

  it('adds up to half again at random, so jobs turned away together spread out', () => {
    expect(retryWait(2, null, () => 0.5)).toBe(6_250);
    expect(retryWait(2, null, () => 0.999)).toBe(7_498);
    expect(retryWait(1, '60', () => 1)).toBe(90_000);
    const seen = new Set(Array.from({ length: 50 }, () => retryWait(1, null)));
    expect(seen.size).toBeGreaterThan(1);
    for (const ms of seen) {
      expect(ms).toBeGreaterThanOrEqual(2_000);
      expect(ms).toBeLessThanOrEqual(3_000);
    }
  });
});

describe('fetching every test jar', () => {
  it('lists each pinned test jar once, from every set', () => {
    const jars = allTestJars();
    const files = jars.map((j) => j.file);
    expect(new Set(files).size).toBe(files.length);
    const everyFile = new Set(Object.values(testJars).flatMap((set) => set.map((j) => j.file)));
    expect(new Set(files)).toEqual(everyFile);
    expect(files.some((f) => path.basename(f) === 'jetty-client-9.4.0.v20161208.jar')).toBe(true);
    for (const jar of jars) {
      expect(jar.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(jar.url).toMatch(/^https:\/\/repo1\.maven\.org\/maven2\//);
    }
  });

  const jars = Array.from({ length: 10 }, (_, i) => ({ name: `j${i}`, file: `j${i}` }));

  it('fetches them all, a few at a time', async () => {
    let running = 0;
    let most = 0;
    const done: string[] = [];
    await fetchAll(jars, async (jar: { name: string }) => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      done.push(jar.name);
    });
    expect(done.sort()).toEqual(jars.map((j) => j.name).sort());
    expect(most).toBe(4);
  });

  it('still fetches the rest when one fails, then fails saying how many', async () => {
    const done: string[] = [];
    const result = fetchAll(jars, async (jar: { name: string }) => {
      if (jar.name === 'j3' || jar.name === 'j7') throw new Error(`no ${jar.name}`);
      done.push(jar.name);
    });
    await expect(result).rejects.toThrow("2 of 10 jars couldn't be fetched: no j3");
    expect(done).toHaveLength(8);
  });
});

describe('the Java agent workflow’s jar cache', () => {
  const workflow = parse(
    readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', 'java-agent.yml'), 'utf8'),
  );
  /** A workflow step, as far as these checks look. */
  interface Step {
    id?: string;
    if?: string;
    uses?: string;
    run?: string;
    with?: { path?: string; key?: string; 'restore-keys'?: string };
  }
  const steps: Step[] = workflow.jobs.versions.steps;
  const index = (match: (s: Step) => boolean) => steps.findIndex(match);
  const restore = index((s) => s.uses?.startsWith('actions/cache/restore@') === true);
  const fetchStep = index((s) => s.run === 'node scripts/fetch-java-test-jars.mjs');
  const save = index((s) => s.uses?.startsWith('actions/cache/save@') === true);
  const tests = index((s) => typeof s.run === 'string' && s.run.includes('vitest run'));

  it('restores, fetches every jar, saves, and only then runs the tests', () => {
    expect([restore, fetchStep, save, tests].every((i) => i >= 0)).toBe(true);
    expect(restore).toBeLessThan(fetchStep);
    expect(fetchStep).toBeLessThan(save);
    expect(save).toBeLessThan(tests);
  });

  it('saves under the key it restores, its own, keyed on the pins, when it wasn’t an exact hit', () => {
    const r = steps[restore]!;
    const s = steps[save]!;
    expect(s.with?.key).toBe(r.with?.key);
    expect(s.with?.path).toBe(r.with?.path);
    expect(r.with?.path).toBe('native/java-agent/deps');
    expect(r.with?.key).toMatch(
      /^java-agent-deps-\$\{\{ hashFiles\('scripts\/build-java-agent\.mjs'\) \}\}$/,
    );
    // After the pins change, the last full cache, so only new pins are fetched: never a key
    // other workflows save, which may hold Byte Buddy alone.
    expect(r.with?.['restore-keys']).toBe('java-agent-deps-');
    expect(s.if).toBe(`steps.${r.id}.outputs.cache-hit != 'true'`);
  });

  it('has no other cache of the jars, which could save a key without the test jars first', () => {
    const others = steps.filter(
      (s, i) =>
        i !== restore &&
        i !== save &&
        s.uses?.startsWith('actions/cache') &&
        s.with?.path?.includes('java-agent'),
    );
    expect(others).toEqual([]);
  });

  it('is the only workflow that saves its key, so no job saves it without the test jars', () => {
    // Other jobs may restore it (ci.yml's Electron job does), but only with cache/restore, which
    // never saves. Any other cache step that names the key, in any job, would save it.
    const dir = path.join(import.meta.dirname, '..', '.github', 'workflows');
    const users = readdirSync(dir).filter((f) =>
      readFileSync(path.join(dir, f), 'utf8').includes('java-agent-deps-'),
    );
    expect(users).toContain('java-agent.yml');
    const savers: string[] = [];
    for (const file of users) {
      const parsed = parse(readFileSync(path.join(dir, file), 'utf8')) as {
        jobs: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, string> }> }>;
      };
      for (const [job, { steps: jobSteps = [] }] of Object.entries(parsed.jobs)) {
        for (const step of jobSteps) {
          if (!JSON.stringify(step).includes('java-agent-deps-')) continue;
          expect(step.uses, `${file} ${job}`).toMatch(/^actions\/cache(\/restore|\/save)?@/);
          if (!step.uses!.startsWith('actions/cache/restore@')) savers.push(`${file} ${job}`);
        }
      }
    }
    expect(savers).toEqual(['java-agent.yml versions']);
  });

  it('runs when the fetch script changes', () => {
    expect(workflow.on.pull_request.paths).toContain('scripts/fetch-java-test-jars.mjs');
  });
});
