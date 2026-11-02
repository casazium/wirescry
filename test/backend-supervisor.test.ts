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
