import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BodyContent,
  ExchangeDetail,
  ExchangeSummary,
  ProxyStatus,
  ServerMessage,
} from '../../shared/api';
import type { BackendState } from '../../shared/ipc';
import type { UiPluginApi } from '../../plugin-api/ui';
import { ApiClient, type Command } from './api-client';
import { ExchangeList } from './exchange-list';

/** A badge on a plugin's tab. */
export interface TabBadge {
  text: string;
  tag: boolean;
  label?: string;
}

type PluginListener = (data: unknown) => void;

export interface BackendView {
  backendState: BackendState;
  connected: boolean;
  /** Counts connections to the backend; changes when it restarts. */
  session: number;
  /** Badges plugins put on their tabs, by `${plugin}:${viewId}`. */
  badges: Record<string, TabBadge>;
  status?: ProxyStatus;
  exchanges: ExchangeSummary[];
  paused: boolean;
  send(command: Command): Promise<unknown>;
  /** The call and event channel for one plugin's UI. */
  pluginApi(plugin: string): UiPluginApi;
  /**
   * Requests captured before the backend restarted. Only their summaries are left: the
   * backend that had their details and bodies is gone. Cleared with the list.
   */
  previous: ExchangeSummary[];
  /** What the last restart cost, until dismissed. */
  restartNotice?: RestartNotice;
  dismissRestartNotice(): void;
}

/** Shown after the backend restarts, so nothing disappears without a word. */
export interface RestartNotice {
  /** When the old backend stopped. */
  at: number;
  /** False when the user restarted it after it failed. */
  crashed: boolean;
  /** Requests from before, now in `previous`. */
  kept: number;
  /** Things plugins had waiting (e.g. paused requests) that were let go. */
  dropped: number;
}

/** Most rows kept from before restarts, oldest dropped first; the backend's own list holds 10,000. */
const MAX_PREVIOUS = 10_000;

/**
 * Connects to the backend and keeps a live list of exchanges, re-rendering at most once per frame.
 * `showView` switches tabs for a plugin, given `${plugin}:${viewId}`.
 */
export function useBackend(showView: (key: string) => void): BackendView {
  // The latest callback, so the plugin channels made once per session always use it.
  const showViewRef = useRef(showView);
  useEffect(() => {
    showViewRef.current = showView;
  }, [showView]);
  const [backendState, setBackendState] = useState<BackendState>({ state: 'starting' });
  const [connected, setConnected] = useState(false);
  // Goes up on the first hello from each backend start, so plugin views remount and load
  // fresh state once they can reach it. A reconnect to the same backend doesn't count, so
  // unsaved edits survive it.
  const [session, setSession] = useState(0);
  // The backend connection that last said hello; a different one means a new backend.
  const greeted = useRef<unknown>(undefined);
  const [status, setStatus] = useState<ProxyStatus>();
  const [exchanges, setExchanges] = useState<ExchangeSummary[]>([]);
  const [paused, setPaused] = useState(false);
  // Badges plugins put on their tabs, by `${plugin}:${viewId}`.
  const [badges, setBadges] = useState<Record<string, TabBadge>>({});
  const [previous, setPrevious] = useState<ExchangeSummary[]>([]);
  const [restartNotice, setRestartNotice] = useState<RestartNotice>();
  // The latest values, for the message handler, which is made once per connection.
  const latest = useRef({
    exchanges,
    paused,
    badges,
    previous,
    backendState: undefined as BackendState | undefined,
  });
  useEffect(() => {
    latest.current = { exchanges, paused, badges, previous, backendState };
  });
  const clientRef = useRef<ApiClient | undefined>(undefined);
  // Bumped to reconnect when the API connection drops while the backend keeps running.
  const [attempt, setAttempt] = useState(0);
  // plugin name -> event name -> listeners
  const pluginListeners = useRef(new Map<string, Map<string, Set<PluginListener>>>());

  useEffect(() => {
    let active = true;
    const update = (state: BackendState): void => setBackendState(state);
    void window.wirescry.getBackendState().then((state) => {
      if (active) update(state);
    });
    const unsubscribe = window.wirescry.onBackendStateChanged(update);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const connection = backendState.state === 'ready' ? backendState.connection : undefined;

  useEffect(() => {
    if (!connection) return;
    let open = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const list = new ExchangeList();
    let frame: number | undefined;
    const render = (): void => {
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        setExchanges(list.snapshot());
      });
    };

    const onMessage = (message: ServerMessage): void => {
      switch (message.type) {
        case 'hello':
          setStatus(message.status);
          setPaused(message.paused);
          if (greeted.current !== undefined && greeted.current !== connection) {
            // A new backend: keep what the old one had captured, and say what happened.
            const before = latest.current;
            const kept = [...before.previous, ...before.exchanges].slice(-MAX_PREVIOUS);
            setPrevious(kept);
            const dropped = Object.values(before.badges)
              .filter((b) => !b.tag)
              .reduce((sum, b) => sum + (Number.parseInt(b.text, 10) || 0), 0);
            const restart = before.backendState?.state === 'ready' ? before.backendState.restart : undefined;
            setRestartNotice({
              at: restart?.at ?? Date.now(),
              crashed: !restart?.byUser,
              // Everything from before, including rows kept through earlier restarts.
              kept: kept.length,
              dropped,
            });
            // Recording stays paused if it was.
            if (before.paused && !message.paused) {
              setPaused(true);
              void client.send({ command: 'setPaused', paused: true }).catch(() => setPaused(false));
            }
          }
          list.reset(message.exchanges);
          // At once, not next frame: after a restart, the old rows move to `previous` in this
          // same render, and mustn't be in both lists.
          setExchanges(list.snapshot());
          setConnected(true);
          if (greeted.current !== connection) {
            greeted.current = connection;
            setSession((n) => n + 1);
            // Plugin views remount and set their badges again.
            setBadges({});
          }
          break;
        case 'exchanges':
          list.apply(message.exchanges, message.removed);
          render();
          break;
        case 'cleared':
          list.reset([]);
          render();
          setPrevious([]);
          break;
        case 'paused':
          setPaused(message.paused);
          break;
        case 'status':
          setStatus(message.status);
          break;
        case 'plugin':
          for (const listener of pluginListeners.current.get(message.plugin)?.get(message.event) ?? []) {
            // One broken listener mustn't stop the others, or the rest of the UI.
            try {
              listener(message.data);
            } catch (error) {
              console.error(`[wirescry] ${message.plugin} listener for ${message.event} failed:`, error);
            }
          }
          break;
      }
    };

    const client = new ApiClient(connection, onMessage, () => {
      setConnected(false);
      // E.g. the backend dropped an oversized message. Try again shortly; a restarted
      // backend instead arrives as a new connection.
      if (open) retry = setTimeout(() => setAttempt((n) => n + 1), 1000);
    });
    clientRef.current = client;
    return () => {
      open = false;
      clearTimeout(retry);
      if (frame !== undefined) cancelAnimationFrame(frame);
      client.close();
      clientRef.current = undefined;
    };
  }, [connection, attempt]);

  const send = useCallback((command: Command) => {
    const client = clientRef.current;
    return client ? client.send(command) : Promise.reject(new Error('Not connected'));
  }, []);

  // One channel object per plugin, kept for the session so plugin views can depend on it.
  const pluginApis = useRef(new Map<string, UiPluginApi>());
  const pluginApi = useCallback(
    (plugin: string): UiPluginApi => {
      let api = pluginApis.current.get(plugin);
      if (!api) {
        api = {
          call: (name, args) => send({ command: 'plugin', plugin, name, args }),
          on: (event, listener) => {
            const byEvent = pluginListeners.current.get(plugin) ?? new Map<string, Set<PluginListener>>();
            pluginListeners.current.set(plugin, byEvent);
            const listeners = byEvent.get(event) ?? new Set<PluginListener>();
            byEvent.set(event, listeners);
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          saveFile: (options) => window.wirescry.saveTextFile(options),
          openFile: (options) => window.wirescry.openTextFile(options),
          showView: (viewId) => showViewRef.current(`${plugin}:${String(viewId)}`),
          getExchange: async (exchangeId) =>
            (await send({ command: 'getExchange', exchangeId: String(exchangeId) })) as ExchangeDetail,
          getBody: async (exchangeId, side) =>
            (await send({
              command: 'getBody',
              exchangeId: String(exchangeId),
              side: side === 'request' ? 'request' : 'response',
            })) as BodyContent | null,
          setBadge: (viewId, text, options) => {
            const key = `${plugin}:${String(viewId)}`;
            // Short text only: it sits on a tab.
            const value: TabBadge | undefined =
              typeof text === 'string' && text !== ''
                ? {
                    text: text.slice(0, 6),
                    tag: options?.tag === true,
                    ...(typeof options?.label === 'string' && options.label !== ''
                      ? { label: options.label.slice(0, 80) }
                      : {}),
                  }
                : undefined;
            setBadges((b) => {
              const old = b[key];
              if (old?.text === value?.text && old?.tag === value?.tag && old?.label === value?.label)
                return b;
              const next = { ...b };
              if (value === undefined) delete next[key];
              else next[key] = value;
              return next;
            });
          },
        };
        pluginApis.current.set(plugin, api);
      }
      return api;
    },
    [send],
  );

  return {
    backendState,
    connected,
    status,
    exchanges,
    paused,
    send,
    pluginApi,
    session,
    badges,
    previous,
    restartNotice,
    dismissRestartNotice: useCallback(() => setRestartNotice(undefined), []),
  };
}
