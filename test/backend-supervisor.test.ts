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

  it('passes on notifications from the backend', () => {
    const s = supervisor();
    s.start();
    forked[0]!.emit('message', { type: 'notify', title: 'Device gone', body: 'Pixel 8 …' });
    expect(notified).toEqual([['Device gone', 'Pixel 8 …']]);
  });
});
