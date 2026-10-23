import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExchangeSummary, ProxyStatus, ServerMessage } from '../../shared/api';
import type { BackendState } from '../../shared/ipc';
import type { UiPluginApi } from '../../plugin-api/ui';
import { ApiClient, type Command } from './api-client';
import { ExchangeList } from './exchange-list';

type PluginListener = (data: unknown) => void;

export interface BackendView {
  backendState: BackendState;
  connected: boolean;
  /** Counts connections to the backend; changes when it restarts. */
  session: number;
  status?: ProxyStatus;
  exchanges: ExchangeSummary[];
  paused: boolean;
  send(command: Command): Promise<unknown>;
  /** The call and event channel for one plugin's UI. */
  pluginApi(plugin: string): UiPluginApi;
}

/** Connects to the backend and keeps a live list of exchanges, re-rendering at most once per frame. */
export function useBackend(): BackendView {
  const [backendState, setBackendState] = useState<BackendState>({ state: 'starting' });
  const [connected, setConnected] = useState(false);
  // Goes up when the backend (re)starts, so plugin views remount and load fresh state.
  // A reconnect to the same backend doesn't count, so unsaved edits survive it.
  const [session, setSession] = useState(0);
  const [status, setStatus] = useState<ProxyStatus>();
  const [exchanges, setExchanges] = useState<ExchangeSummary[]>([]);
  const [paused, setPaused] = useState(false);
  const clientRef = useRef<ApiClient | undefined>(undefined);
  // Bumped to reconnect when the API connection drops while the backend keeps running.
  const [attempt, setAttempt] = useState(0);
  // plugin name -> event name -> listeners
  const pluginListeners = useRef(new Map<string, Map<string, Set<PluginListener>>>());

  useEffect(() => {
    let active = true;
    const update = (state: BackendState): void => {
      setBackendState(state);
      if (state.state === 'ready') setSession((n) => n + 1);
    };
    void window.leverframe.getBackendState().then((state) => {
      if (active) update(state);
    });
    const unsubscribe = window.leverframe.onBackendStateChanged(update);
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
          list.reset(message.exchanges);
          render();
          setConnected(true);
          break;
        case 'exchanges':
          list.apply(message.exchanges, message.removed);
          render();
          break;
        case 'cleared':
          list.reset([]);
          render();
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
              console.error(`[leverframe] ${message.plugin} listener for ${message.event} failed:`, error);
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
          saveFile: (options) => window.leverframe.saveTextFile(options),
          openFile: (options) => window.leverframe.openTextFile(options),
        };
        pluginApis.current.set(plugin, api);
      }
      return api;
    },
    [send],
  );

  return { backendState, connected, status, exchanges, paused, send, pluginApi, session };
}
