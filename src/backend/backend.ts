import path from 'node:path';
import { Readable } from 'node:stream';
import type {
  BodyContent,
  ClientCommand,
  ExchangeDetail,
  FormatLanguage,
  FormattedBody,
  ProxyStatus,
  ServerMessage,
} from '../shared/api';
import { startApiServer } from './api';
import { headerValue, toBodyContent } from './body-content';
import { exchangeType } from '../shared/exchange-type';
import { Formatter, MAX_FORMAT_INPUT } from './formatter';
import { HybridBodyStore } from './body-store';
import { detectBrowsers, launchChromium } from './browsers';
import { writeCABundle } from './ca-bundle';
import { detectTerminals, launchTerminal } from './terminals';
import { terminalEnv } from '../shared/terminal-env';
import { loadOrCreateCA, resetCA, type CertificateAuthority } from './ca';
import {
  deleteFirefoxProfile,
  FIREFOX_PROFILE_DIR,
  isProfileTrusted,
  launchFirefox,
  markProfileTrusted,
} from './firefox';
import { startProxy, type RunningProxy } from './proxy';
import { isValidPort, loadSettings, saveSettings, type Settings } from './settings';
import { InMemoryRequestStore } from './store';
import { UpdateBatcher } from './update-batcher';

export interface BackendOptions {
  /** Folder for this install's data, e.g. the CA. */
  dataDir: string;
  /** Per-launch secret the UI must present. */
  token: string;
  allowedOrigins: string[];
  /** Fixed port, overriding the saved setting. Used by tests. */
  proxyPort?: number;
  /** Extra CAs to trust for upstream servers (PEM). Used by tests. */
  upstreamCAs?: string[];
  /** Bodies up to this size stay in memory; larger ones go to disk. */
  bodyMemoryLimit?: number;
  /** Bytes kept per body. Used by tests. */
  maxBodySize?: number;
}

export interface RunningBackend {
  apiPort: number;
  readonly proxyPort: number;
  caCertPath: string;
  stop(): Promise<void>;
}

/** Starts the proxy and the local API. Runs without Electron, so tests can use it directly. */
export async function startBackend(options: BackendOptions): Promise<RunningBackend> {
  const { dataDir } = options;
  let ca: CertificateAuthority = await loadOrCreateCA(dataDir);
  let settings: Settings = await loadSettings(dataDir);
  const firefoxProfile = path.join(dataDir, FIREFOX_PROFILE_DIR);
  const bodies = await HybridBodyStore.open(path.join(dataDir, 'bodies'), {
    memoryLimit: options.bodyMemoryLimit,
    maxBodySize: options.maxBodySize,
  });
  const browsers = await detectBrowsers();
  const terminals = await detectTerminals();
  let bundlePath = await writeCABundle(dataDir, ca.cert);
  const formatter = new Formatter();
  let firefoxTrusted = await isProfileTrusted(firefoxProfile, ca.spkiFingerprint);

  // The API needs the proxy port and the proxy needs somewhere to send events,
  // so events go through this indirection until the API is up.
  let broadcast: (message: ServerMessage) => void = () => undefined;
  const updates = new UpdateBatcher((message) => broadcast(message));
  let paused = false;

  const store = new InMemoryRequestStore(10_000, (id) => {
    updates.remove(id);
    void bodies.delete(id).catch(() => undefined);
  });

  const status = (): ProxyStatus => ({
    proxyPort: proxy.port,
    proxyPortSetting: settings.proxyPort ?? null,
    certificate: {
      commonName: ca.commonName,
      spkiFingerprint: ca.spkiFingerprint,
      validTo: ca.validTo,
      path: ca.certPath,
    },
    browsers: browsers.map(({ id, name, kind }) => ({ id, name, kind })),
    firefoxTrusted,
    platform:
      process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
        ? process.platform
        : 'other',
    terminals: terminals.map(({ id, name }) => ({ id, name })),
    terminalEnv: currentTerminalEnv(),
  });

  const currentTerminalEnv = (): Record<string, string> =>
    terminalEnv(proxy.port, { caPath: ca.certPath, bundlePath });

  const openProxy = (port: number | undefined): Promise<RunningProxy> =>
    startProxy({
      ca,
      store,
      bodies,
      port,
      upstreamCAs: options.upstreamCAs,
      onExchange: (exchange) => updates.change(exchange.summary),
      isPaused: () => paused,
      onCATrusted: (userAgent) => {
        if (!/Firefox\//.test(userAgent) || firefoxTrusted) return;
        firefoxTrusted = true;
        // Save before telling the UI, so the state on disk is never behind what's shown.
        markProfileTrusted(firefoxProfile, ca.spkiFingerprint).then(
          () => broadcast({ type: 'status', status: status() }),
          (error: unknown) => {
            firefoxTrusted = false;
            console.error('[leverframe] could not record Firefox trust:', error);
          },
        );
      },
    });

  let proxy = await openProxy(options.proxyPort ?? settings.proxyPort);

  /** Restarts the proxy, going back to the old port if the new one can't be used. */
  const restartProxy = async (port: number | undefined): Promise<void> => {
    const previousPort = proxy.port;
    await proxy.stop();
    try {
      proxy = await openProxy(port);
    } catch (error) {
      proxy = await openProxy(previousPort);
      throw error;
    }
  };

  // Commands that restart the proxy run one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  };

  const handleCommand = async (command: ClientCommand): Promise<unknown> => {
    switch (command.command) {
      case 'launchBrowser': {
        const browser = browsers.find((b) => b.id === command.browserId);
        if (!browser) throw new Error(`Browser not found: ${command.browserId}`);
        if (browser.kind === 'firefox') {
          await launchFirefox(browser, {
            profileDir: firefoxProfile,
            proxyPort: proxy.port,
            spkiFingerprint: ca.spkiFingerprint,
          });
        } else {
          await launchChromium(browser, { proxyPort: proxy.port, spkiFingerprint: ca.spkiFingerprint });
        }
        return undefined;
      }
      case 'launchTerminal': {
        const terminal = terminals.find((t) => t.id === command.terminalId);
        if (!terminal) throw new Error(`Terminal not found: ${command.terminalId}`);
        await launchTerminal(terminal, currentTerminalEnv(), {
          scriptDir: path.join(dataDir, 'terminal'),
          proxyAddress: `127.0.0.1:${proxy.port}`,
        });
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
      case 'setProxyPort':
        return exclusive(async () => {
          if (command.port !== null && !isValidPort(command.port)) {
            throw new Error('Choose a port from 1024 to 65535.');
          }
          const port = command.port ?? undefined;
          if (port === undefined || port !== proxy.port) {
            try {
              await restartProxy(port);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              throw new Error(
                code === 'EADDRINUSE' ? `Port ${port} is already in use.` : (error as Error).message,
                { cause: error },
              );
            }
          }
          settings = { ...settings, proxyPort: port };
          await saveSettings(dataDir, settings);
          broadcast({ type: 'status', status: status() });
          return undefined;
        });
      case 'resetCertificate':
        return exclusive(async () => {
          ca = await resetCA(dataDir);
          bundlePath = await writeCABundle(dataDir, ca.cert);
          // The old Firefox profile trusts the old CA; start it over.
          await deleteFirefoxProfile(firefoxProfile);
          firefoxTrusted = false;
          await restartProxy(proxy.port);
          broadcast({ type: 'status', status: status() });
          return undefined;
        });
      case 'getExchange': {
        const exchange: ExchangeDetail | undefined = store.get(command.exchangeId);
        if (!exchange) throw new Error('Exchange not found');
        return exchange;
      }
      case 'getBody': {
        const exchange = store.get(command.exchangeId);
        if (!exchange) throw new Error('Exchange not found');
        const { exchangeId, side } = command;
        const info = side === 'request' ? exchange.requestBody : exchange.responseBody;
        if (!info || !bodies.read(exchangeId, side)) return null;
        const headers = side === 'request' ? exchange.requestHeaders : exchange.responseHeaders;
        const content: BodyContent = await toBodyContent(
          () => bodies.read(exchangeId, side) ?? Readable.from([]),
          info.size,
          headers,
        );
        return content;
      }
      case 'formatBody': {
        const { exchangeId, side } = command;
        const exchange = store.get(exchangeId);
        if (!exchange) throw new Error('Exchange not found');
        const info = side === 'request' ? exchange.requestBody : exchange.responseBody;
        const headers = side === 'request' ? exchange.requestHeaders : exchange.responseHeaders;
        const result = (r: FormattedBody): FormattedBody => r;
        const type = exchangeType({
          contentType: headerValue(headers, 'content-type')?.split(';')[0]?.trim().toLowerCase(),
          path: side === 'response' ? exchange.summary.path : '',
        });
        if (type !== 'html' && type !== 'xml' && type !== 'js' && type !== 'css') {
          return result({ ok: false, reason: 'only HTML, XML, JavaScript and CSS are formatted' });
        }
        if (!info || !bodies.read(exchangeId, side)) return result({ ok: false, reason: 'no body' });
        const content = await toBodyContent(
          () => bodies.read(exchangeId, side) ?? Readable.from([]),
          info.size,
          headers,
          MAX_FORMAT_INPUT,
        );
        if (content.truncated) return result({ ok: false, reason: 'too large to format (over 2 MB)' });
        const text = Buffer.from(content.base64, 'base64').toString('utf8');
        try {
          return result({
            ok: true,
            language: type satisfies FormatLanguage,
            text: await formatter.format(type, text),
          });
        } catch (error) {
          return result({ ok: false, reason: (error as Error).message });
        }
      }
      default:
        throw new Error('Unknown command');
    }
  };

  const api = await startApiServer({
    token: options.token,
    allowedOrigins: options.allowedOrigins,
    handlers: {
      hello: () => ({ type: 'hello', status: status(), exchanges: store.list(), paused }),
      command: handleCommand,
    },
  });
  broadcast = api.broadcast;

  return {
    apiPort: api.port,
    get proxyPort() {
      return proxy.port;
    },
    caCertPath: ca.certPath,
    async stop() {
      updates.reset();
      await Promise.all([api.stop(), proxy.stop(), formatter.close()]);
      await bodies.close();
    },
  };
}
