import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExchangeSummary, ProxyStatus, ServerMessage } from '../../shared/api';
import type { BackendState } from '../../shared/ipc';
import { ApiClient, type Command } from './api-client';

export interface BackendView {
  backendState: BackendState;
  connected: boolean;
  status?: ProxyStatus;
  exchanges: ExchangeSummary[];
  send(command: Command): Promise<unknown>;
}

/** Connects to the backend and keeps a live list of exchanges. */
export function useBackend(): BackendView {
  const [backendState, setBackendState] = useState<BackendState>({ state: 'starting' });
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<ProxyStatus>();
  const [exchanges, setExchanges] = useState<ExchangeSummary[]>([]);
  const clientRef = useRef<ApiClient | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void window.leverframe.getBackendState().then((state) => {
      if (active) setBackendState(state);
    });
    const unsubscribe = window.leverframe.onBackendStateChanged(setBackendState);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const connection = backendState.state === 'ready' ? backendState.connection : undefined;

  useEffect(() => {
    if (!connection) return;
    // Index of each exchange in the list, so updates replace rows in place.
    let positions = new Map<string, number>();

    const onMessage = (message: ServerMessage): void => {
      switch (message.type) {
        case 'hello':
          setStatus(message.status);
          positions = new Map(message.exchanges.map((e, i) => [e.id, i]));
          setExchanges(message.exchanges);
          setConnected(true);
          break;
        case 'exchange':
          setExchanges((list) => {
            const index = positions.get(message.exchange.id);
            const next = [...list];
            if (index === undefined) {
              positions.set(message.exchange.id, next.length);
              next.push(message.exchange);
            } else {
              next[index] = message.exchange;
            }
            return next;
          });
          break;
        case 'cleared':
          positions = new Map();
          setExchanges([]);
          break;
      }
    };

    const client = new ApiClient(connection, onMessage, () => setConnected(false));
    clientRef.current = client;
    return () => {
      client.close();
      clientRef.current = undefined;
    };
  }, [connection]);

  const send = useCallback((command: Command) => {
    const client = clientRef.current;
    return client ? client.send(command) : Promise.reject(new Error('Not connected'));
  }, []);

  return { backendState, connected, status, exchanges, send };
}
