import type { ExchangeSource } from '../shared/api';
import type { RunningProxy } from './proxy';

/**
 * Extra proxy listeners, one per device: each on its own port on this computer's loopback,
 * recording into the same traffic list with the device as the exchanges' source. They share
 * the main proxy's certificate, plugin rules and pause, follow rule changes, and keep their
 * port across a certificate reset (a device's tunnel points at it). A device can't reach this
 * computer or its local networks through its listener unless allowed (`setLocalAccess`).
 */
export interface DeviceListeners {
  /** Starts a listener for this source (or returns the running one). `port` reuses a port if free. */
  open(source: ExchangeSource, port?: number): Promise<{ port: number }>;
  /** Stops this source's listener, if running. */
  close(sourceId: string): Promise<void>;
  /** The running listeners, and whether each device may reach this computer and its local networks. */
  list(): Array<{ source: ExchangeSource; port: number; localAccess: boolean }>;
  /**
   * Whether this device may reach this computer and its local networks (default: no). Kept for
   * the device while Wirescry runs, listener open or not; turning it off closes connections
   * the device already has open to them.
   */
  setLocalAccess(sourceId: string, allowed: boolean): void;
  /**
   * Calls `watch` when a listener had to move to another port (`port`) or couldn't restart at
   * all (`undefined`), e.g. after a certificate reset: a device's tunnel must follow. Returns a
   * function that stops watching.
   */
  onPortChange(watch: (source: ExchangeSource, port: number | undefined) => void): () => void;
}

/** What the backend does with them, besides what DeviceListeners offers. */
export interface DeviceListenerSet extends DeviceListeners {
  /** Re-reads every listener's rules (plugins changed theirs). */
  refreshRules(): Promise<void>;
  /** Restarts every listener (e.g. with a new certificate) on the port it had, if it can. */
  restartAll(): Promise<void>;
  /** Stops every listener for good; later opens fail. */
  stopAll(): Promise<void>;
}

export interface DeviceListenerOptions {
  /**
   * Starts a proxy listener for this source, on `port` or on a free port if undefined, that
   * lets the device reach this computer and its local networks only while `allowLocal()`.
   */
  start(source: ExchangeSource, port: number | undefined, allowLocal: () => boolean): Promise<RunningProxy>;
  log?: (message: string, error?: unknown) => void;
}

export function deviceListenerSet(options: DeviceListenerOptions): DeviceListenerSet {
  const log = options.log ?? ((message, error) => console.error(`[wirescry] ${message}`, error ?? ''));
  const running = new Map<string, { source: ExchangeSource; proxy: RunningProxy }>();
  // Opening, closing, restarting and stopping run one at a time, so none of them can see
  // another half done (e.g. a close during a certificate reset, or an open during stop).
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  };
  let stopped = false;
  const localAccess = new Set<string>();
  const start = (source: ExchangeSource, port: number | undefined) =>
    options.start(source, port, () => localAccess.has(source.id));
  const watchers = new Set<(source: ExchangeSource, port: number | undefined) => void>();
  const portChanged = (source: ExchangeSource, port: number | undefined): void => {
    for (const watch of watchers) {
      try {
        watch({ ...source }, port);
      } catch (error) {
        log('a listener port watcher failed:', error);
      }
    }
  };

  return {
    open: (source, port) =>
      oneAtATime(async () => {
        if (stopped) throw new Error('Wirescry is stopping.');
        const existing = running.get(source.id);
        if (existing) return { port: existing.proxy.port };
        let started: RunningProxy;
        try {
          started = await start(source, port);
        } catch (error) {
          if (port === undefined) throw error;
          started = await start(source, undefined);
        }
        running.set(source.id, { source: { ...source }, proxy: started });
        // Plugins may have changed their rules while it was starting.
        await started.refreshRules();
        return { port: started.port };
      }),

    close: (sourceId) =>
      oneAtATime(async () => {
        const listener = running.get(sourceId);
        if (!listener) return;
        running.delete(sourceId);
        await listener.proxy.stop();
      }),

    list: () =>
      [...running.values()].map((l) => ({
        source: { ...l.source },
        port: l.proxy.port,
        localAccess: localAccess.has(l.source.id),
      })),

    setLocalAccess(sourceId, allowed) {
      if (allowed) {
        localAccess.add(sourceId);
        return;
      }
      localAccess.delete(sourceId);
      running.get(sourceId)?.proxy.recheckDestinations?.();
    },

    onPortChange(watch) {
      watchers.add(watch);
      return () => watchers.delete(watch);
    },

    refreshRules: async () => {
      await Promise.all([...running.values()].map((l) => l.proxy.refreshRules()));
    },

    restartAll: () =>
      oneAtATime(async () => {
        if (stopped) return;
        for (const [id, listener] of [...running]) {
          const { port } = listener.proxy;
          await listener.proxy.stop().catch(() => undefined);
          let reopened: RunningProxy | undefined;
          try {
            reopened = await start(listener.source, port);
          } catch (error) {
            log(`listener for ${listener.source.label} couldn't reopen port ${port}:`, error);
            reopened = await start(listener.source, undefined).catch((again: unknown) => {
              log(`listener for ${listener.source.label} couldn't start:`, again);
              return undefined;
            });
          }
          if (!reopened) {
            running.delete(id);
            portChanged(listener.source, undefined);
            continue;
          }
          listener.proxy = reopened;
          // Plugins may have changed their rules while it was starting.
          await reopened.refreshRules();
          if (reopened.port !== port) portChanged(listener.source, reopened.port);
        }
      }),

    stopAll: () =>
      oneAtATime(async () => {
        stopped = true;
        const all = [...running.values()];
        running.clear();
        await Promise.all(all.map((l) => l.proxy.stop().catch(() => undefined)));
      }),
  };
}
