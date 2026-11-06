/**
 * The bookkeeping for device listeners, with fake listeners: every failure path, deterministically.
 * test/device-listeners.test.ts runs the real thing.
 */
import { describe, expect, it } from 'vitest';
import { deviceListenerSet } from '../src/backend/device-listeners';
import type { RunningProxy } from '../src/backend/proxy';
import type { ExchangeSource } from '../src/shared/api';

const PIXEL: ExchangeSource = { kind: 'android', id: 'pixel', label: 'Pixel 8' };
const TABLET: ExchangeSource = { kind: 'android', id: 'tablet', label: 'Galaxy Tab' };

/** Fake listeners: ports are handed out from 40000; `taken` ports and `failing` sources refuse to start. */
function fakes() {
  let nextPort = 40000;
  const taken = new Set<number>();
  const failing = new Set<string>();
  const live = new Set<number>();
  const started: Array<{ source: string; port: number }> = [];
  let refreshes = 0;
  const rechecks: string[] = [];
  const allowLocal = new Map<string, () => boolean>();
  let gate: Promise<void> | undefined;
  const start = async (
    source: ExchangeSource,
    port: number | undefined,
    allowed: () => boolean = () => false,
  ): Promise<RunningProxy> => {
    if (gate) await gate;
    if (failing.has(source.id)) throw new Error(`can't start ${source.id}`);
    if (port !== undefined && (taken.has(port) || live.has(port))) throw new Error(`EADDRINUSE ${port}`);
    const chosen = port ?? nextPort++;
    live.add(chosen);
    started.push({ source: source.id, port: chosen });
    allowLocal.set(source.id, allowed);
    return {
      recheckDestinations: () => rechecks.push(source.id),
      port: chosen,
      refreshRules: async () => {
        refreshes += 1;
      },
      stop: async () => {
        live.delete(chosen);
      },
    };
  };
  const logs: string[] = [];
  const set = deviceListenerSet({ start, log: (message) => logs.push(message) });
  return {
    set,
    taken,
    failing,
    live,
    started,
    logs,
    rechecks,
    /** What the latest listener for this source was told about reaching this computer. */
    allowsLocal: (id: string) => allowLocal.get(id)?.(),
    refreshes: () => refreshes,
    /** Holds every start until the returned function is called. */
    hold() {
      let release!: () => void;
      gate = new Promise((resolve) => (release = resolve));
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

describe('Device listener bookkeeping', () => {
  it('opens, lists, and closes', async () => {
    const f = fakes();
    expect(await f.set.open(PIXEL)).toEqual({ port: 40000 });
    expect(await f.set.open(TABLET)).toEqual({ port: 40001 });
    expect(f.set.list()).toEqual([
      { source: PIXEL, port: 40000, localAccess: false },
      { source: TABLET, port: 40001, localAccess: false },
    ]);
    await f.set.close(PIXEL.id);
    expect(f.set.list()).toEqual([{ source: TABLET, port: 40001, localAccess: false }]);
    expect([...f.live]).toEqual([40001]);
    // Closing what isn't open is fine.
    await f.set.close('nothing');
  });

  it('applies rules once a listener has started', async () => {
    const f = fakes();
    await f.set.open(PIXEL);
    expect(f.refreshes()).toBe(1);
    await f.set.refreshRules();
    expect(f.refreshes()).toBe(2);
  });

  it('keeps its own copy of the source', async () => {
    const f = fakes();
    const source = { ...PIXEL };
    await f.set.open(source);
    source.label = 'changed';
    expect(f.set.list()[0]!.source.label).toBe('Pixel 8');
    f.set.list()[0]!.source.label = 'also changed';
    expect(f.set.list()[0]!.source.label).toBe('Pixel 8');
  });

  it('reuses a free port, moves off a taken one, and fails when nothing starts', async () => {
    const f = fakes();
    expect(await f.set.open(PIXEL, 41000)).toEqual({ port: 41000 });
    f.taken.add(42000);
    expect(await f.set.open(TABLET, 42000)).toEqual({ port: 40000 });
    f.failing.add('broken');
    await expect(f.set.open({ kind: 'android', id: 'broken', label: 'Broken' })).rejects.toThrow(
      "can't start broken",
    );
    await expect(f.set.open({ kind: 'android', id: 'broken', label: 'Broken' }, 43000)).rejects.toThrow(
      "can't start broken",
    );
    expect(f.set.list().map((l) => l.source.id)).toEqual([PIXEL.id, TABLET.id]);
  });

  it('restarts every listener on its own port, and says nothing when nothing moved', async () => {
    const f = fakes();
    await f.set.open(PIXEL);
    await f.set.open(TABLET);
    const told: unknown[] = [];
    f.set.onPortChange((source, port) => told.push([source.id, port]));
    await f.set.restartAll();
    expect(f.set.list()).toEqual([
      { source: PIXEL, port: 40000, localAccess: false },
      { source: TABLET, port: 40001, localAccess: false },
    ]);
    expect(told).toEqual([]);
    expect(f.started.slice(2)).toEqual([
      { source: PIXEL.id, port: 40000 },
      { source: TABLET.id, port: 40001 },
    ]);
  });

  it('moves a listener whose port was taken during a restart, and tells the watchers', async () => {
    const f = fakes();
    await f.set.open(PIXEL);
    await f.set.open(TABLET);
    const told: unknown[] = [];
    f.set.onPortChange((source, port) => told.push([source.id, port]));
    f.taken.add(40000);
    await f.set.restartAll();
    expect(f.set.list()).toEqual([
      { source: PIXEL, port: 40002, localAccess: false },
      { source: TABLET, port: 40001, localAccess: false },
    ]);
    expect(told).toEqual([[PIXEL.id, 40002]]);
    expect(f.logs.some((l) => l.includes("couldn't reopen port 40000"))).toBe(true);
  });

  it('drops a listener that can no longer start at all, tells the watchers, and restarts the rest', async () => {
    const f = fakes();
    await f.set.open(PIXEL);
    await f.set.open(TABLET);
    const told: unknown[] = [];
    f.set.onPortChange((source, port) => told.push([source.id, port]));
    f.failing.add(PIXEL.id);
    await f.set.restartAll();
    expect(f.set.list()).toEqual([{ source: TABLET, port: 40001, localAccess: false }]);
    expect(told).toEqual([[PIXEL.id, undefined]]);
    expect([...f.live]).toEqual([40001]);
  });

  it('keeps telling the other watchers when one throws, and stops telling one that unsubscribed', async () => {
    const f = fakes();
    await f.set.open(PIXEL);
    const told: unknown[] = [];
    f.set.onPortChange(() => {
      throw new Error('bad watcher');
    });
    const stop = f.set.onPortChange((source, port) => told.push([source.id, port]));
    f.taken.add(40000);
    await f.set.restartAll();
    expect(told).toEqual([[PIXEL.id, 40001]]);
    expect(f.logs).toContain('a listener port watcher failed:');
    stop();
    f.taken.add(40001);
    await f.set.restartAll();
    expect(told).toHaveLength(1);
  });

  it('runs one operation at a time: a close during a restart stays closed', async () => {
    const f = fakes();
    await f.set.open(PIXEL);
    await f.set.open(TABLET);
    const release = f.hold();
    const restart = f.set.restartAll();
    const close = f.set.close(TABLET.id);
    release();
    await Promise.all([restart, close]);
    expect(f.set.list()).toEqual([{ source: PIXEL, port: 40000, localAccess: false }]);
    expect([...f.live]).toEqual([40000]);
  });

  it('makes one listener from two opens at once', async () => {
    const f = fakes();
    const release = f.hold();
    const both = Promise.all([f.set.open(PIXEL), f.set.open(PIXEL)]);
    release();
    const [a, b] = await both;
    expect(a).toEqual(b);
    expect(f.started).toHaveLength(1);
  });

  it('stops everything, refuses later opens, and leaves nothing running that was opening', async () => {
    const f = fakes();
    await f.set.open(PIXEL);
    const release = f.hold();
    const opening = f.set.open(TABLET);
    const stopping = f.set.stopAll();
    release();
    await opening;
    await stopping;
    expect(f.set.list()).toEqual([]);
    expect([...f.live]).toEqual([]);
    await expect(f.set.open(PIXEL)).rejects.toThrow(/stopping/);
    // Restarting after stop does nothing.
    await f.set.restartAll();
    expect(f.set.list()).toEqual([]);
  });

  it("keeps each device's local access, open or not, and closes connections when it's turned off", async () => {
    const f = fakes();
    await f.set.open(PIXEL);
    await f.set.open(TABLET);
    expect(f.allowsLocal(PIXEL.id)).toBe(false);
    f.set.setLocalAccess(PIXEL.id, true);
    expect(f.allowsLocal(PIXEL.id)).toBe(true);
    expect(f.allowsLocal(TABLET.id)).toBe(false);
    expect(f.set.list().map((l) => l.localAccess)).toEqual([true, false]);
    // Turning it on closes nothing; turning it off rechecks that device's open connections.
    expect(f.rechecks).toEqual([]);
    f.set.setLocalAccess(PIXEL.id, false);
    expect(f.rechecks).toEqual([PIXEL.id]);
    expect(f.allowsLocal(PIXEL.id)).toBe(false);
    // Set before a listener opens, and kept across closing and a restart.
    f.set.setLocalAccess('later', true);
    const later: ExchangeSource = { kind: 'android', id: 'later', label: 'Later' };
    await f.set.open(later);
    expect(f.allowsLocal('later')).toBe(true);
    await f.set.close('later');
    await f.set.open(later);
    await f.set.restartAll();
    expect(f.allowsLocal('later')).toBe(true);
    // Turning it off for a device with no listener is fine.
    f.set.setLocalAccess('nothing', false);
  });

  it('carries on after a failed operation', async () => {
    const f = fakes();
    f.failing.add(PIXEL.id);
    await expect(f.set.open(PIXEL)).rejects.toThrow();
    f.failing.delete(PIXEL.id);
    expect(await f.set.open(PIXEL)).toEqual({ port: 40000 });
  });
});
