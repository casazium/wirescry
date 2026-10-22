import type { ClientCommand, ServerMessage } from '../shared/api';
import { startApiServer } from './api';
import { detectBrowsers, launchChromium } from './browsers';
import { loadOrCreateCA } from './ca';
import { startProxy } from './proxy';
import { InMemoryRequestStore } from './store';

export interface BackendOptions {
  /** Folder for this install's data, e.g. the CA. */
  dataDir: string;
  /** Per-launch secret the UI must present. */
  token: string;
  allowedOrigins: string[];
  proxyPort?: number;
  /** Extra CAs to trust for upstream servers (PEM). Used by tests. */
  upstreamCAs?: string[];
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
  const store = new InMemoryRequestStore();
  const browsers = await detectBrowsers();

  // The API needs the proxy port and the proxy needs somewhere to send events,
  // so events go through this indirection until the API is up.
  let broadcast: (message: ServerMessage) => void = () => undefined;

  const proxy = await startProxy({
    ca,
    store,
    port: options.proxyPort,
    upstreamCAs: options.upstreamCAs,
    onExchange: (exchange) => broadcast({ type: 'exchange', exchange }),
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
        store.clear();
        broadcast({ type: 'cleared' });
        return undefined;
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
      await Promise.all([api.stop(), proxy.stop()]);
    },
  };
}
