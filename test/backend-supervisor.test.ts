import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A stand-in for Electron's UtilityProcess. */
class FakeChild extends EventEmitter {
  messages: unknown[] = [];
  killed = false;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  /** What the fake does when asked to shut down: exit after this many ms, or never. */
  constructor(private readonly exitAfter: number | null) {
    super();
  }
  postMessage(message: { type: string }): void {
    this.messages.push(message);
    if (message.type === 'shutdown' && this.exitAfter !== null)
      setTimeout(() => this.emit('exit', 0), this.exitAfter);
  }
  kill(): boolean {
    this.killed = true;
    setTimeout(() => this.emit('exit', null), 10);
    return true;
  }
}

const forked: FakeChild[] = [];
let nextExitAfter: number | null = 0;

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const child = new FakeChild(nextExitAfter);
      forked.push(child);
      return child;
    },
  },
}));

const { BackendSupervisor } = await import('../src/main/backend-supervisor');

describe('BackendSupervisor.shutdown', () => {
  let dataDir: string;
  const bodies = (): string => path.join(dataDir, 'bodies');

  beforeEach(async () => {
    forked.length = 0;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-supervisor-'));
    await mkdir(bodies());
    await writeFile(path.join(bodies(), 'x.response'), 'captured');
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  const supervisor = () =>
    new BackendSupervisor({
      dataDir,
      allowedOrigins: [],
      pluginsEnabled: false,
      app: { version: '0.0.0', releaseDate: '' },
    });

  it('asks the backend to stop, waits for it, and deletes the bodies folder', async () => {
    nextExitAfter = 20;
    const s = supervisor();
    s.start();
    await s.shutdown();
    const child = forked[0]!;
    expect(child.messages).toContainEqual({ type: 'shutdown' });
    expect(child.killed).toBe(false);
    expect(existsSync(bodies())).toBe(false);
  });

  it('kills a backend that does not stop in time, then deletes the bodies folder', async () => {
    nextExitAfter = null;
    const s = supervisor();
    s.start();
    const started = Date.now();
    await s.shutdown();
    expect(forked[0]!.killed).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
    expect(existsSync(bodies())).toBe(false);
  }, 10_000);

  it('deletes the bodies folder when no backend is running', async () => {
    await supervisor().shutdown();
    expect(existsSync(bodies())).toBe(false);
  });

  it('does not restart a backend that crashed just before quitting', async () => {
    vi.useFakeTimers();
    nextExitAfter = 0;
    const s = supervisor();
    s.start();
    forked[0]!.emit('exit', 1); // A crash: a restart is scheduled.
    const done = s.shutdown();
    await vi.runAllTimersAsync();
    await done;
    expect(forked).toHaveLength(1);
  });
});

describe('BackendSupervisor restarts', () => {
  const dataDir = path.join(os.tmpdir(), 'wirescry-supervisor-restarts');
  const supervisor = () =>
    new BackendSupervisor({
      dataDir,
      allowedOrigins: [],
      pluginsEnabled: false,
      app: { version: '0.0.0', releaseDate: '' },
    });
  const ready = (child: FakeChild): void => {
    child.emit('message', { type: 'ready', proxyPort: 8001, apiPort: 9000, plugins: [] });
  };

  beforeEach(() => {
    forked.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('says when it restarted a crashed backend', async () => {
    const s = supervisor();
    s.start();
    ready(forked[0]!);
    expect(s.state).not.toHaveProperty('restart');
    forked[0]!.emit('exit', 5);
    await vi.runAllTimersAsync();
    expect(forked).toHaveLength(2);
    expect(s.state).toMatchObject({ state: 'starting', restart: { exitCode: 5 } });
    ready(forked[1]!);
    expect(s.state).toMatchObject({ state: 'ready', restart: { exitCode: 5 } });
  });

  it('doesn’t keep restarting a backend that couldn’t start, and gives a short reason', async () => {
    const s = supervisor();
    s.start();
    forked[0]!.emit('message', {
      type: 'error',
      message: 'Error: listen EADDRINUSE\n    at Server.listen (x.js:1)',
    });
    forked[0]!.emit('exit', 1);
    await vi.runAllTimersAsync();
    expect(forked).toHaveLength(1);
    expect(s.state).toEqual({
      state: 'failed',
      message: "Wirescry's proxy couldn't start: listen EADDRINUSE",
    });
  });

  it('gives up after repeated crashes, then starts again when asked', async () => {
    const s = supervisor();
    s.start();
    for (let i = 0; i < 6; i++) {
      forked.at(-1)!.emit('exit', 9);
      await vi.runAllTimersAsync();
    }
    expect(forked).toHaveLength(6);
    expect(s.state).toMatchObject({ state: 'failed' });
    s.restart();
    expect(forked).toHaveLength(7);
    expect(s.state).toMatchObject({ state: 'starting', restart: { byUser: true } });
    // Not while one is running.
    s.restart();
    expect(forked).toHaveLength(7);
  });
});

describe('Putting Android devices back before a quick quit', () => {
  let dataDir: string;
  const records = (): string => path.join(dataDir, 'android-capture');
  const notified: Array<[string, string]> = [];
  const supervisor = () =>
    new BackendSupervisor({
      dataDir,
      allowedOrigins: [],
      pluginsEnabled: false,
      app: { version: '0.0.0', releaseDate: '' },
      notify: (title, body) => notified.push([title, body]),
    });

  beforeEach(async () => {
    forked.length = 0;
    notified.length = 0;
    nextExitAfter = 0;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-supervisor-android-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("doesn't ask the backend when no device is set up", async () => {
    const s = supervisor();
    s.start();
    await s.undoAndroid(2000);
    s.undoAndroidSync(2000);
    expect(forked[0]!.messages).not.toContainEqual(expect.objectContaining({ type: 'android-undo' }));
  });

  it('asks the backend, and waits for its answer', async () => {
    await mkdir(records());
    await writeFile(path.join(records(), `${'a'.repeat(32)}.json`), '{}');
    const s = supervisor();
    s.start();
    const child = forked[0]!;
    let done = false;
    const undo = s.undoAndroid(2000).then(() => (done = true));
    const asked = child.messages.find((m) => (m as { type: string }).type === 'android-undo') as {
      id: number;
      timeoutMs: number;
    };
    expect(asked).toMatchObject({ timeoutMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    child.emit('message', { type: 'android-undone', id: asked.id });
    await undo;
  });

  it("doesn't wait much past the time it gave a backend that never answers", async () => {
    await mkdir(records());
    await writeFile(path.join(records(), `${'a'.repeat(32)}.json`), '{}');
    const s = supervisor();
    s.start();
    const started = Date.now();
    await s.undoAndroid(100);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('waits, blocked, for the backend to mark itself done while Windows logs off', async () => {
    await mkdir(records());
    await writeFile(path.join(records(), `${'a'.repeat(32)}.json`), '{}');
    const s = supervisor();
    s.start();
    // Already done (the backend is another process; this test can't run it while blocked).
    await writeFile(path.join(records(), 'undone-1'), '');
    let cleaned = false;
    const started = Date.now();
    s.undoAndroidSync(2000, () => (cleaned = true));
    expect(Date.now() - started).toBeLessThan(500);
    expect(cleaned).toBe(true);
    expect(forked[0]!.messages).toContainEqual({
      type: 'android-undo',
      id: 1,
      timeoutMs: 2000,
      markDone: true,
    });
    expect(existsSync(path.join(records(), 'undone-1'))).toBe(false);
  });

  it('gives up waiting at its time limit, and still cleans up', async () => {
    await mkdir(records());
    await writeFile(path.join(records(), `${'a'.repeat(32)}.json`), '{}');
    const s = supervisor();
    s.start();
    let cleaned = false;
    const started = Date.now();
    s.undoAndroidSync(100, () => (cleaned = true));
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(cleaned).toBe(true);
  });

  it('passes on notifications from the backend', () => {
    const s = supervisor();
    s.start();
    forked[0]!.emit('message', { type: 'notify', title: 'Device gone', body: 'Pixel 8 …' });
    expect(notified).toEqual([['Device gone', 'Pixel 8 …']]);
  });
});

describe('BackendSupervisor’s other jobs', () => {
  const ready = (child: FakeChild): void => {
    child.emit('message', { type: 'ready', proxyPort: 8001, apiPort: 9000, plugins: [] });
  };
  let dataDir: string;
  beforeEach(async () => {
    forked.length = 0;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-supervisor-'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A secure store that marks what it encrypted, as safeStorage would scramble it. */
  const fakeStorage = () => ({
    encrypt: vi.fn(async (text: string) => Buffer.from(`sealed:${text}`).toString('base64')),
    decrypt: vi.fn(async (b64: string) => {
      const text = Buffer.from(b64, 'base64').toString();
      if (!text.startsWith('sealed:')) throw new Error('Not ours');
      return text.slice('sealed:'.length);
    }),
  });
  const supervisor = (options: Record<string, unknown> = {}) =>
    new BackendSupervisor({
      dataDir,
      allowedOrigins: [],
      pluginsEnabled: false,
      app: { version: '0.0.0', releaseDate: '' },
      ...options,
    });
  /** Sends a crypto request from the backend and returns the reply the supervisor posts back. */
  const crypto = async (child: FakeChild, request: { id: number; op: string; data?: unknown }) => {
    child.emit('message', { type: 'crypto', ...request });
    await vi.waitFor(
      () =>
        expect(
          child.messages.some(
            (m) =>
              (m as { id?: number; type: string }).type === 'crypto-result' &&
              (m as { id: number }).id === request.id,
          ),
        ).toBe(true),
      { timeout: 5000 },
    );
    return child.messages.find(
      (m) => (m as { type: string }).type === 'crypto-result' && (m as { id: number }).id === request.id,
    );
  };

  describe('secure storage for plugins', () => {
    it('encrypts and decrypts for the backend, and says the OS store is there', async () => {
      const storage = fakeStorage();
      const s = supervisor({ secureStorage: () => storage });
      s.start();
      const child = forked[0]!;
      expect(await crypto(child, { id: 1, op: 'available', data: '' })).toEqual({
        type: 'crypto-result',
        id: 1,
        ok: true,
        data: 'os',
      });
      const sealed = (await crypto(child, { id: 2, op: 'encrypt', data: 'license' })) as { data: string };
      expect(sealed).toMatchObject({ ok: true });
      expect(sealed.data).not.toContain('license');
      expect(await crypto(child, { id: 3, op: 'decrypt', data: sealed.data })).toMatchObject({
        ok: true,
        data: 'license',
      });
    });

    it('says there’s no store where the OS has none, and refuses to encrypt there', async () => {
      const s = supervisor({ secureStorage: () => undefined });
      s.start();
      const child = forked[0]!;
      expect(await crypto(child, { id: 1, op: 'available', data: '' })).toMatchObject({
        ok: true,
        data: 'none',
      });
      expect(await crypto(child, { id: 2, op: 'encrypt', data: 'license' })).toMatchObject({
        ok: false,
        error: 'No secure storage on this computer',
      });
    });

    it('refuses data that isn’t text or is over 4 MB, unknown operations, and passes on failures', async () => {
      const storage = fakeStorage();
      const s = supervisor({ secureStorage: () => storage });
      s.start();
      const child = forked[0]!;
      expect(await crypto(child, { id: 1, op: 'encrypt', data: 42 })).toMatchObject({
        ok: false,
        error: 'Bad data',
      });
      expect(
        await crypto(child, { id: 2, op: 'encrypt', data: 'x'.repeat(4 * 1024 * 1024 + 1) }),
      ).toMatchObject({
        ok: false,
        error: 'Bad data',
      });
      expect(await crypto(child, { id: 3, op: 'shred', data: 'x' })).toMatchObject({
        ok: false,
        error: 'Unknown operation',
      });
      expect(await crypto(child, { id: 4, op: 'decrypt', data: 'bm90IG91cnM=' })).toMatchObject({
        ok: false,
        error: 'Not ours',
      });
      // Exactly 4 MB is fine.
      expect(await crypto(child, { id: 5, op: 'encrypt', data: 'x'.repeat(4 * 1024 * 1024) })).toMatchObject({
        ok: true,
      });
      expect(storage.encrypt).toHaveBeenCalledTimes(1);
    });

    it('asks the OS for its store once a run, and doesn’t answer a backend that has since restarted', async () => {
      let release: () => void = () => undefined;
      const storage = {
        encrypt: vi.fn(() => new Promise<string>((resolve) => (release = () => resolve('c2VhbGVk')))),
        decrypt: vi.fn(async () => 'x'),
      };
      const factory = vi.fn(() => storage);
      const s = supervisor({ secureStorage: factory });
      s.start();
      const first = forked[0]!;
      ready(first);
      await crypto(first, { id: 0, op: 'available', data: '' });
      first.emit('message', { type: 'crypto', id: 1, op: 'encrypt', data: 'license' });
      await vi.waitFor(() => expect(storage.encrypt).toHaveBeenCalled());
      expect(factory).toHaveBeenCalledTimes(1);
      // The backend crashes and restarts before the OS answers.
      first.emit('exit', 5);
      // The supervisor restarts it after 500 ms; Windows CI can be slow.
      await vi.waitFor(() => expect(forked).toHaveLength(2), { timeout: 5000 });
      release();
      await storage.encrypt.mock.results[0]!.value;
      await new Promise((resolve) => setImmediate(resolve));
      // Neither the old backend (gone) nor the new one (which didn't ask) gets the answer.
      const answered = (child: FakeChild) =>
        child.messages.some(
          (m) => (m as { type: string }).type === 'crypto-result' && (m as { id: number }).id === 1,
        );
      expect(answered(first)).toBe(false);
      expect(answered(forked[1]!)).toBe(false);
      // The new backend gets the store looked up afresh (a keychain may have become available).
      await crypto(forked[1]!, { id: 2, op: 'available', data: '' });
      expect(factory).toHaveBeenCalledTimes(2);
    });
  });

  describe('HAR files', () => {
    it('is refused while the backend isn’t running', async () => {
      const s = supervisor();
      await expect(s.har({ op: 'export', file: '/x.har', exchangeIds: [] })).rejects.toThrow(
        "Wirescry's backend isn't running.",
      );
      s.start();
      await expect(s.har({ op: 'export', file: '/x.har', exchangeIds: [] })).rejects.toThrow(
        "Wirescry's backend isn't running.",
      );
    });

    it('sends the job and gives back the backend’s answer, or its error', async () => {
      const s = supervisor();
      s.start();
      const child = forked[0]!;
      ready(child);
      const exported = s.har({ op: 'export', file: '/x.har', exchangeIds: ['a'] });
      const imported = s.har({ op: 'import', file: '/y.har', name: 'y.har' });
      const [first, second] = child.messages.filter((m) => (m as { type: string }).type === 'har') as Array<{
        id: number;
        op: string;
        file: string;
      }>;
      expect(first).toMatchObject({ op: 'export', file: '/x.har', exchangeIds: ['a'] });
      expect(second).toMatchObject({ op: 'import', file: '/y.har' });
      // An answer for a job that isn't waiting is ignored.
      child.emit('message', { type: 'har-result', id: 999, ok: true, value: 'stray' });
      child.emit('message', { type: 'har-result', id: second!.id, ok: false, error: 'Not a HAR file' });
      child.emit('message', { type: 'har-result', id: first!.id, ok: true, value: { count: 1 } });
      await expect(exported).resolves.toEqual({ count: 1 });
      await expect(imported).rejects.toThrow('Not a HAR file');
    });

    it('fails a job when the backend stops, and one that takes over 10 minutes', async () => {
      vi.useFakeTimers();
      const s = supervisor();
      s.start();
      ready(forked[0]!);
      const slow = s.har({ op: 'export', file: '/x.har', exchangeIds: [] });
      const slowFailed = expect(slow).rejects.toThrow('That took too long.');
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
      let settled = false;
      void slow.catch(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await slowFailed;

      const cut = s.har({ op: 'import', file: '/y.har', name: 'y' });
      forked[0]!.emit('exit', 5);
      await expect(cut).rejects.toThrow('The backend stopped while working on the file.');
    });
  });

  it('writes the backend’s output to the log, line by line, errors as errors', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const written: Array<[string, string, string]> = [];
    const s = supervisor({
      logger: { write: (source: string, level: string, line: string) => written.push([source, level, line]) },
    });
    s.start();
    const child = forked[0]!;
    child.stdout.emit('data', Buffer.from('first line\nsecond '));
    child.stdout.emit('data', 'half\n\n');
    child.stderr.emit('data', 'went wrong\n');
    // Node's own warnings on stderr aren't errors: a deprecation notice is info, others warn.
    child.stderr.emit(
      'data',
      '(node:9) [DEP0190] DeprecationWarning: shell option true\n(Use `node --trace-deprecation ...` to show where the warning was created)\n(node:9) MaxListenersExceededWarning: leak\n(Use `node --trace-warnings ...` to show where the warning was created)\n',
    );
    expect(written).toEqual([
      ['backend', 'info', 'first line'],
      ['backend', 'info', 'second half'],
      ['backend', 'error', 'went wrong'],
      ['backend', 'info', '(node:9) [DEP0190] DeprecationWarning: shell option true'],
      ['backend', 'info', '(Use `node --trace-deprecation ...` to show where the warning was created)'],
      ['backend', 'warn', '(node:9) MaxListenersExceededWarning: leak'],
      ['backend', 'warn', '(Use `node --trace-warnings ...` to show where the warning was created)'],
    ]);
  });
});
