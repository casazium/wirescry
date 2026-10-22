import path from 'node:path';
import type { BodyContent, ClientCommand, ExchangeDetail, ServerMessage } from '../shared/api';
import { startApiServer } from './api';
import { toBodyContent } from './body-content';
import { HybridBodyStore } from './body-store';
import { detectBrowsers, launchChromium } from './browsers';
import { loadOrCreateCA } from './ca';
import { startProxy } from './proxy';
import { InMemoryRequestStore } from './store';
import { UpdateBatcher } from './update-batcher';

export interface BackendOptions {
  /** Folder for this install's data, e.g. the CA. */
  dataDir: string;
  /** Per-launch secret the UI must present. */
  token: string;
  allowedOrigins: string[];
  proxyPort?: number;
  /** Extra CAs to trust for upstream servers (PEM). Used by tests. */
  upstreamCAs?: string[];
  /** Bodies up to this size stay in memory; larger ones go to disk. */
  bodyMemoryLimit?: number;
}

export interface RunningBackend {
  apiPort: number;
  proxyPort: number;
  caCertPath: string;
  stop(): Promise<void>;
}

/** Starts the proxy and the local API. Runs without Electron, so tests can use it directly. */
export async function startBackend(options: BackendOptions): Promise<RunningBackend> {
  const ca = await loadOrCreateCA(options.dataDir);
  const bodies = await HybridBodyStore.open(path.join(options.dataDir, 'bodies'), {
    memoryLimit: options.bodyMemoryLimit,
  });
  const browsers = await detectBrowsers();

  // The API needs the proxy port and the proxy needs somewhere to send events,
  // so events go through this indirection until the API is up.
  let broadcast: (message: ServerMessage) => void = () => undefined;
  const updates = new UpdateBatcher((message) => broadcast(message));
  let paused = false;

  const store = new InMemoryRequestStore(10_000, (id) => {
    updates.remove(id);
    void bodies.delete(id).catch(() => undefined);
  });

  const proxy = await startProxy({
    ca,
    store,
    bodies,
    port: options.proxyPort,
    upstreamCAs: options.upstreamCAs,
    onExchange: (exchange) => updates.change(exchange.summary),
    isPaused: () => paused,
  });

  const handleCommand = async (command: ClientCommand): Promise<unknown> => {
    switch (command.command) {
      case 'launchBrowser': {
        const browser = browsers.find((b) => b.id === command.browserId);
        if (!browser) throw new Error(`Browser not found: ${command.browserId}`);
        await launchChromium(browser, { proxyPort: proxy.port, spkiFingerprint: ca.spkiFingerprint });
        return undefined;
      }
      case 'clear':
        updates.reset();
        store.clear();
        await bodies.clear();
        broadcast({ type: 'cleared' });
        return undefined;
      case 'setPaused':
        paused = command.paused;
        broadcast({ type: 'paused', paused });
        return undefined;
      case 'getExchange': {
        const exchange: ExchangeDetail | undefined = store.get(command.exchangeId);
        if (!exchange) throw new Error('Exchange not found');
        return exchange;
      }
      case 'getBody': {
        const exchange = store.get(command.exchangeId);
        if (!exchange) throw new Error('Exchange not found');
        const raw = await bodies.get(command.exchangeId, command.side);
        if (!raw) return null;
        const headers = command.side === 'request' ? exchange.requestHeaders : exchange.responseHeaders;
        const content: BodyContent = await toBodyContent(raw, headers);
        return content;
      }
      default:
        throw new Error('Unknown command');
    }
  };

  const api = await startApiServer({
    token: options.token,
    allowedOrigins: options.allowedOrigins,
    handlers: {
      hello: () => ({
        type: 'hello',
        status: {
          proxyPort: proxy.port,
          caFingerprint: ca.spkiFingerprint,
          browsers: browsers.map(({ id, name }) => ({ id, name })),
        },
        exchanges: store.list(),
        paused,
      }),
      command: handleCommand,
    },
  });
  broadcast = api.broadcast;

  return {
    apiPort: api.port,
    proxyPort: proxy.port,
    caCertPath: ca.certPath,
    async stop() {
      updates.reset();
      await Promise.all([api.stop(), proxy.stop()]);
      await bodies.close();
    },
  };
}
