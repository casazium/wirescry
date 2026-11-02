import { randomBytes, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type {
  BodyContent,
  BodySide,
  ClientCommand,
  ExchangeDetail,
  ExchangeSummary,
  FormatLanguage,
  FormattedBody,
  Header,
  PluginStatus,
  ProxyStatus,
  ServerMessage,
  WebSocketMessages,
} from '../shared/api';
import { startApiServer } from './api';
import { harEntry, harFrame, MAX_HAR_BODY_BYTES, MAX_HAR_IMPORT_BYTES, parseHar } from './har';
import type { Encryptor } from './secure-store';
import { headerValue, toBodyContent, writeBodyToFile, type WrittenBody } from './body-content';
import { exchangeType } from '../shared/exchange-type';
import { Formatter, MAX_FORMAT_INPUT } from './formatter';
import { HybridBodyStore } from './body-store';
import { detectBrowsers, launchChromium } from './browsers';
import { writeTerminalConfig, type TerminalConfig } from './ca-bundle';
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
import type { BackendPlugin } from '../plugin-api/backend';
import { PluginHost } from './plugin-host';
import * as mockttp from 'mockttp';
import { WebSocketStore } from './websocket-store';

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
  /** Plugins built into this copy, such as Pro. */
  plugins?: BackendPlugin[];
  /** Whether plugins may run (licensing). */
  pluginsEnabled?: boolean;
  /** How long a plugin may take to start. */
  pluginStartTimeoutMs?: number;
  /** Encrypts plugins' secure stores; leave out where the OS has no keychain to use. */
  encryptor?: Encryptor;
  /** This Wirescry's version and build date, for plugins. Defaults suit tests. */
  app?: { version: string; releaseDate: string };
}

export interface HarImportCounts {
  imported: number;
  skipped: number;
  problems: string[];
  removed: number;
}

/** Exchanges kept in the traffic list; the oldest go past this. */
const STORE_LIMIT = 10_000;

export interface RunningBackend {
  apiPort: number;
  readonly proxyPort: number;
  caCertPath: string;
  /** Each plugin's state. Plugins have finished starting by the time startBackend resolves. */
  pluginStatuses(): PluginStatus[];
  /** Writes these exchanges (in this order) to a HAR file. Ids that are gone are skipped. */
  exportHar(file: string, exchangeIds: string[]): Promise<{ count: number }>;
  /**
   * Adds the exchanges in a HAR file to the traffic list. `name` is the file's name to
   * show (the file may be a copy). `removed` counts older exchanges dropped to make room.
   */
  importHar(file: string, name?: string): Promise<HarImportCounts>;
  /** Writes one whole body of an exchange to a file, decoded where possible. */
  saveBody(file: string, exchangeId: string, side: BodySide): Promise<WrittenBody>;
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
  const platform: ProxyStatus['platform'] =
    process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
      ? process.platform
      : 'other';
  let terminalConfig: TerminalConfig = await writeTerminalConfig(dataDir, ca.cert);
  const formatter = new Formatter();
  let firefoxTrusted = await isProfileTrusted(firefoxProfile, ca.spkiFingerprint);

  // The API needs the proxy port and the proxy needs somewhere to send events,
  // so events go through this indirection until the API is up.
  let broadcast: (message: ServerMessage) => void = () => undefined;
  const updates = new UpdateBatcher((message) => broadcast(message));
  let paused = false;

  const websockets = new WebSocketStore();
  const store = new InMemoryRequestStore(STORE_LIMIT, (id) => {
    updates.remove(id);
    websockets.delete(id);
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
    platform,
    terminals: terminals.map(({ id, name }) => ({ id, name })),
    terminalEnv: currentTerminalEnv(),
    plugins: pluginHost.statuses(),
  });

  const currentTerminalEnv = (): Record<string, string> =>
    terminalEnv(proxy.port, { caPath: ca.certPath, ...terminalConfig }, platform);

  // Plugins such as Pro. They start once the API is up.
  const pluginHost = new PluginHost({
    plugins: options.plugins ?? [],
    enabled: options.pluginsEnabled ?? false,
    disabledReason: 'Plugins are turned off.',
    dataDir,
    encryptor: options.encryptor,
    app: options.app ?? { version: '0.0.0-test', releaseDate: new Date().toISOString() },
    refreshRules: () => proxy.refreshRules(),
    passThroughStep: (transforms) =>
      new mockttp.requestSteps.PassThroughStep({
        // Only the transforms and callbacks; connection settings stay Wirescry's own.
        transformRequest: transforms?.transformRequest,
        transformResponse: transforms?.transformResponse,
        beforeRequest: transforms?.beforeRequest,
        beforeResponse: transforms?.beforeResponse,
        additionalTrustedCAs: options.upstreamCAs?.map((cert) => ({ cert })),
      }),
    emit: (plugin, event, data) => broadcast({ type: 'plugin', plugin, event, data }),
    onStatusChange: () => broadcast({ type: 'status', status: status() }),
    startTimeoutMs: options.pluginStartTimeoutMs,
  });

  const openProxy = (port: number | undefined): Promise<RunningProxy> =>
    startProxy({
      ca,
      store,
      bodies,
      websockets,
      port,
      upstreamCAs: options.upstreamCAs,
      onExchange: (exchange) => updates.change(exchange.summary),
      extraRules: () => pluginHost.rules(),
      describeRule: (ruleId) => pluginHost.describeRule(ruleId),
      ruleEndsWithoutResponse: (ruleId) => pluginHost.endsWithoutResponse(ruleId),
      isPaused: () => paused,
      onCATrusted: (userAgent) => {
        if (!/Firefox\//.test(userAgent) || firefoxTrusted) return;
        firefoxTrusted = true;
        // Save before telling the UI, so the state on disk is never behind what's shown.
        markProfileTrusted(firefoxProfile, ca.spkiFingerprint).then(
          () => broadcast({ type: 'status', status: status() }),
          (error: unknown) => {
            firefoxTrusted = false;
            console.error('[wirescry] could not record Firefox trust:', error);
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
      await proxy.refreshRules();
      throw error;
    }
    // Plugins may have changed their rules while the new proxy was starting; reapply.
    await proxy.refreshRules();
  };

  // Commands that restart the proxy run one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  };

  /** Headers to decode a stored body with: an imported one is stored decoded already. */
  const decodingHeaders = (exchange: ExchangeDetail, side: BodySide): Header[] | undefined => {
    const headers = side === 'request' ? exchange.requestHeaders : exchange.responseHeaders;
    return exchange.importedFrom
      ? headers?.filter(([name]) => name.toLowerCase() !== 'content-encoding')
      : headers;
  };

  /** A stored body, decoded, up to `limit` bytes; null if there's none. */
  const readBody = async (
    exchange: ExchangeDetail,
    side: BodySide,
    limit?: number,
  ): Promise<BodyContent | null> => {
    const id = exchange.summary.id;
    const info = side === 'request' ? exchange.requestBody : exchange.responseBody;
    if (!info || !bodies.read(id, side)) return null;
    return toBodyContent(
      () => bodies.read(id, side) ?? Readable.from([]),
      info.size,
      decodingHeaders(exchange, side),
      limit,
    );
  };

  /** A body for a HAR file; an error reading it is noted rather than failing the export. */
  const harBody = async (
    exchange: ExchangeDetail,
    side: BodySide,
    notes: string[],
  ): Promise<BodyContent | null> => {
    if (bodies.isReceiving(exchange.summary.id, side)) {
      notes.push(`The ${side} body was still arriving, so it was left out.`);
      return null;
    }
    try {
      return await readBody(exchange, side, MAX_HAR_BODY_BYTES);
    } catch {
      notes.push(`The ${side} body couldn't be read, so it was left out.`);
      return null;
    }
  };

  const saveBody = async (file: string, exchangeId: string, side: BodySide): Promise<WrittenBody> => {
    const exchange = store.get(exchangeId);
    if (!exchange) throw new Error('That request is no longer in the list.');
    if (bodies.isReceiving(exchangeId, side)) throw new Error('That body is still arriving.');
    if (!bodies.read(exchangeId, side)) throw new Error('That request has no body to save.');
    if (file === '') return { size: 0, decoded: false }; // Only checking it can be saved.
    return writeBodyToFile(
      () => {
        const stream = bodies.read(exchangeId, side);
        // Cleared meanwhile: an empty file would look like a saved body.
        if (!stream) throw new Error('That request is no longer in the list.');
        return stream;
      },
      decodingHeaders(exchange, side),
      file,
    );
  };

  const exportHar = async (file: string, exchangeIds: string[]): Promise<{ count: number }> => {
    const { head, tail } = harFrame(options.app?.version ?? '0.0.0');
    // Written to a temporary file and renamed into place, so a failure never leaves half a file.
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    const out = await open(temp, 'wx', 0o600);
    // Small entries are gathered and written together.
    let pending: string[] = [];
    let pendingLength = 0;
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const text = pending.join('');
      pending = [];
      pendingLength = 0;
      await out.writeFile(text, 'utf8');
    };
    const write = async (text: string): Promise<void> => {
      pending.push(text);
      pendingLength += text.length;
      if (pendingLength >= 1024 * 1024) await flush();
    };
    let count = 0;
    try {
      await write(head);
      for (const id of new Set(exchangeIds)) {
        const exchange = store.get(id);
        if (!exchange) continue;
        const notes: string[] = [];
        const item = {
          detail: exchange,
          requestBody: await harBody(exchange, 'request', notes),
          responseBody: await harBody(exchange, 'response', notes),
          messages: exchange.summary.websocket ? websockets.get(id, -1, Number.MAX_SAFE_INTEGER) : undefined,
          notes,
        };
        // Two very large bodies can make an entry longer than a string can be:
        // then leave out the response body, and if need be the request body too.
        const attempts = [
          item,
          {
            ...item,
            responseBody: null,
            notes: [...notes, 'The response body was too large to write, so it was left out.'],
          },
          {
            ...item,
            requestBody: null,
            responseBody: null,
            notes: [...notes, 'The bodies were too large to write, so they were left out.'],
          },
        ];
        let text: string | undefined;
        for (const attempt of attempts) {
          try {
            text = JSON.stringify(harEntry(attempt));
            break;
          } catch (error) {
            if (!(error instanceof RangeError) || attempt === attempts.at(-1)) throw error;
          }
        }
        await write((count > 0 ? ',\n' : '') + text!);
        count += 1;
      }
      if (count === 0) throw new Error('None of those requests are in the list any more.');
      await write(tail);
      await flush();
      await out.close();
      await rename(temp, file);
    } catch (error) {
      await out.close().catch(() => undefined);
      await rm(temp, { force: true });
      throw error;
    }
    return { count };
  };

  // Bumped by Clear, so an import that's running stops adding to the list.
  let clears = 0;
  // A body being stored by an import; Clear waits for it before emptying the body folder.
  let importWrite: Promise<unknown> = Promise.resolve();

  const importHar = async (file: string, name?: string): Promise<HarImportCounts> => {
    const startedAt = clears;
    if ((await stat(file)).size > MAX_HAR_IMPORT_BYTES) {
      throw new Error(`That file is larger than ${MAX_HAR_IMPORT_BYTES / 1024 / 1024} MB.`);
    }
    const parsed = await parseHar(await readFile(file, 'utf8'), STORE_LIMIT);
    // A name to show, without folders or control characters.
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    const importedFrom = (path.basename(name ?? file).replace(/[\x00-\x1f\x7f]/g, '') || 'HAR file').slice(
      0,
      200,
    );
    const cleared = (): boolean => clears !== startedAt;
    const removed = Math.max(0, store.size + parsed.exchanges.length - STORE_LIMIT);
    let imported = 0;
    for (const item of parsed.exchanges) {
      if (cleared()) break;
      const id = `har-${randomUUID()}`;
      const put = async (side: BodySide, body: Buffer | undefined) => {
        if (!body || cleared()) return undefined;
        const stored = bodies.put(id, side, body);
        importWrite = stored.catch(() => undefined);
        return stored;
      };
      const requestBody = await put('request', item.requestBody);
      const responseBody = await put('response', item.responseBody);
      if (cleared()) break;
      for (const message of item.messages ?? []) websockets.add(id, message);
      const summary: ExchangeSummary = {
        ...item.summary,
        id,
        imported: true,
        ...(item.summary.websocket ? { messageCount: websockets.count(id) } : {}),
      };
      const detail: ExchangeDetail = {
        summary,
        requestHeaders: item.requestHeaders,
        ...(item.responseHeaders ? { responseHeaders: item.responseHeaders } : {}),
        timing: item.timing,
        ...(requestBody ? { requestBody: { size: requestBody.size, stored: requestBody.stored } } : {}),
        ...(responseBody ? { responseBody: { size: responseBody.size, stored: responseBody.stored } } : {}),
        importedFrom,
      };
      store.upsert(detail);
      updates.change(summary);
      imported += 1;
    }
    if (cleared()) throw new Error('The import stopped because the list was cleared.');
    return { imported, skipped: parsed.skipped, problems: parsed.problems, removed };
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
        clears += 1;
        updates.reset();
        store.clear();
        websockets.clear();
        await importWrite;
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
          terminalConfig = await writeTerminalConfig(dataDir, ca.cert);
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
        const content: BodyContent | null = await readBody(exchange, command.side);
        return content;
      }
      case 'plugin': {
        return pluginHost.call(command.plugin, command.name, command.args);
      }
      case 'getWebSocketMessages': {
        if (!store.get(command.exchangeId)) throw new Error('Exchange not found');
        const result: WebSocketMessages = websockets.get(command.exchangeId, command.after);
        return result;
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
        const content = (await readBody(exchange, side, MAX_FORMAT_INPUT))!;
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

  await pluginHost.startAll();

  return {
    apiPort: api.port,
    get proxyPort() {
      return proxy.port;
    },
    caCertPath: ca.certPath,
    pluginStatuses: () => pluginHost.statuses(),
    exportHar,
    saveBody,
    importHar,
    async stop() {
      await pluginHost.stopAll();
      updates.reset();
      await Promise.all([api.stop(), proxy.stop(), formatter.close()]);
      await bodies.close();
    },
  };
}
