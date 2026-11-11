import { randomBytes, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type {
  BodyContent,
  ExchangeAnnotation,
  BodySide,
  ClientCommand,
  ExchangeDetail,
  ExchangeSource,
  ExchangeSummary,
  FormatLanguage,
  FormattedBody,
  Header,
  PluginStatus,
  ProxyStatus,
  RefusedConnections,
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
import { writeShellScripts, writeTerminalConfig, type TerminalConfig } from './ca-bundle';
import { detectTerminals, launchTerminal } from './terminals';
import type { DockerEndpoint } from './docker/endpoint';
import { DockerSetup } from './docker/setup';
import { AndroidSetup, type AndroidSetupOptions } from './android/setup';
import { CaptureRecords } from './android/capture';
import { findAdb } from './android/adb-server';
import { certificateSha256 } from './android/certificates';
import { ANDROID_RECORDS_DIR } from '../shared/ipc';
import { Composer } from './composer';
import { terminalEnv } from '../shared/terminal-env';
import { loadOrCreateCA, resetCA, type CertificateAuthority } from './ca';
import {
  deleteFirefoxProfile,
  FIREFOX_PROFILE_DIR,
  isProfileTrusted,
  launchFirefox,
  markProfileTrusted,
} from './firefox';
import type { EgressGuardOptions } from './egress-guard';
import { deviceListenerSet, type DeviceListeners } from './device-listeners';
import { startProxy, type RunningProxy } from './proxy';
import { cleanHost, Refusals } from './refusals';
import { isValidPort, loadSettings, saveSettings, type Settings } from './settings';
import { InMemoryRequestStore } from './store';
import { UpdateBatcher } from './update-batcher';
import type { BackendPlugin } from '../plugin-api/backend';
import { PluginHost } from './plugin-host';
import * as mockttp from 'mockttp';
import { WebSocketStore } from './websocket-store';

/** How long quitting waits to put capturing Android devices back: the app kills the backend after 3 s. */
const ANDROID_STOP_TIMEOUT_MS = 2000;
/** The source the main proxy's refusals are counted under (see ProxyStatus.refused). */
const COMPUTER = 'computer';
/** Refusals are sent to the UI together, this long after the first of them. */
export const REFUSALS_PUBLISH_MS = 250;
/** Which Android devices trust which certificate, in the data folder. */
const ANDROID_TRUST_FILE = 'android-trust.json';

/** The certificate's SHA-256 for status, worked out once per certificate. */
const sha256Of = (() => {
  let last: { cert: string; sha256: string } | undefined;
  return (cert: string): string => {
    if (last?.cert !== cert) last = { cert, sha256: certificateSha256(cert) };
    return last.sha256;
  };
})();

export interface BackendOptions {
  /** Folder for this install's data, e.g. the CA. */
  dataDir: string;
  /** false: don't set up Docker. Tests turn it off, or give a daemon of their own. */
  docker?: boolean;
  /**
   * Android setup: options turn it on (tests), 'setting' follows the androidSetup setting (on
   * unless it's false; the app passes this). Left out or false, it's off, so tests never reach
   * a real ADB server by accident.
   */
  android?:
    | false
    | 'setting'
    | (Omit<AndroidSetupOptions, 'capture'> & {
        capture?: Partial<NonNullable<AndroidSetupOptions['capture']>>;
      });
  /** Shows an OS notification (the app's main process does it). */
  notify?: (title: string, body: string) => void;
  /**
   * Windows: set up Docker there (tests, which build the pipe helper). Left out, it follows the
   * experimentalWindowsDocker setting, off by default until tested hands-on with Docker Desktop.
   */
  windowsDocker?: boolean;
  /** Where the user's Docker daemon is. Found the way the Docker CLI finds it if omitted. */
  dockerEndpoint?: () => Promise<DockerEndpoint>;
  /** Called as each step of starting up finishes, to log how long they take. */
  onStartupStep?: (step: string) => void;
  /** Per-launch secret the UI must present. */
  token: string;
  allowedOrigins: string[];
  /** Fixed port, overriding the saved setting. Used by tests. */
  proxyPort?: number;
  /** Extra CAs to trust for upstream servers (PEM). Used by tests. */
  upstreamCAs?: string[];
  /** The egress guard's DNS, connections and own addresses for device listeners. For tests. */
  deviceEgress?: Pick<EgressGuardOptions, 'lookup' | 'connect' | 'ownAddresses'>;
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
  /** How long one plugin call from the UI may take (default 2 minutes). */
  pluginCallTimeoutMs?: number;
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
  /** Proxy listeners for single devices (Android setup), besides the main proxy. */
  listeners: DeviceListeners;
  /**
   * Puts capturing Android devices back, within a time limit, without stopping anything else:
   * for quits that may not give the backend time to stop (an update, Windows logging off).
   */
  stopAndroid(timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export type { DeviceListeners } from './device-listeners';

/** How long a finished exchange's body may take to be stored before plugins are told anyway. */
const COMPLETION_GRACE_MS = 10_000;

/** Starts the proxy and the local API. Runs without Electron, so tests can use it directly. */
export async function startBackend(options: BackendOptions): Promise<RunningBackend> {
  const { dataDir } = options;
  const step = options.onStartupStep ?? (() => undefined);
  let ca: CertificateAuthority = await loadOrCreateCA(dataDir);
  step('certificate');
  let settings: Settings = await loadSettings(dataDir);
  const firefoxProfile = path.join(dataDir, FIREFOX_PROFILE_DIR);
  const bodies = await HybridBodyStore.open(path.join(dataDir, 'bodies'), {
    memoryLimit: options.bodyMemoryLimit,
    maxBodySize: options.maxBodySize,
  });
  step('settings and body store');
  let browsers = await detectBrowsers();
  const terminals = await detectTerminals();
  step('browsers and terminals');
  const platform: ProxyStatus['platform'] =
    process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
      ? process.platform
      : 'other';
  let terminalConfig: TerminalConfig = await writeTerminalConfig(dataDir, ca.cert);
  const formatter = new Formatter();
  let firefoxTrusted = await isProfileTrusted(firefoxProfile, ca.spkiFingerprint);
  step('terminal config and Firefox profile');

  // The API needs the proxy port and the proxy needs somewhere to send events,
  // so events go through this indirection until the API is up.
  let broadcast: (message: ServerMessage) => void = () => undefined;
  // Set once the proxy is up; status() can be asked for before that (e.g. by Docker setup).
  // Written once the proxy is up; status() can be asked for before that (Docker's callbacks).
  let terminalScripts: Awaited<ReturnType<typeof writeShellScripts>> = {};
  // eslint-disable-next-line prefer-const -- assigned later, after what status() reads exists
  let android: AndroidSetup | undefined;
  const updates = new UpdateBatcher((message) => broadcast(message));
  let paused = false;
  // HTTPS connections through the main proxy that refused the certificate: see ProxyStatus.refused.
  const refusals = new Refusals();
  let refusalsTimer: NodeJS.Timeout | undefined;
  /** See RefusedConnections.epoch. */
  let refusalsEpoch = 1;
  let stopping = false;
  const clearRefusals = (): void => {
    refusals.clearAll();
    refusalsEpoch += 1;
    clearTimeout(refusalsTimer);
    refusalsTimer = undefined;
  };
  const refused = (): RefusedConnections | undefined => {
    const now = refusals.of(COMPUTER);
    return now && { ...now, epoch: refusalsEpoch };
  };

  const websockets = new WebSocketStore();
  // Exchanges plugins have been told have finished, and ones waiting a moment for their body.
  const completed = new Set<string>();
  const completionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Everything kept about an exchange besides its store entry.
  const forget = (id: string): void => {
    completed.delete(id);
    clearTimeout(completionTimers.get(id));
    completionTimers.delete(id);
    updates.remove(id);
    websockets.delete(id);
    void bodies.delete(id).catch(() => undefined);
  };
  const store = new InMemoryRequestStore(STORE_LIMIT, forget);

  const status = (): ProxyStatus => ({
    proxyPort: proxy.port,
    proxyPortSetting: settings.proxyPort ?? null,
    certificate: {
      commonName: ca.commonName,
      spkiFingerprint: ca.spkiFingerprint,
      sha256: sha256Of(ca.cert),
      validTo: ca.validTo,
      path: ca.certPath,
    },
    browsers: browsers.map(({ id, name, kind }) => ({ id, name, kind })),
    firefoxTrusted,
    platform,
    terminals: terminals.map(({ id, name }) => ({ id, name })),
    terminalEnv: currentTerminalEnv(),
    terminalScripts,
    plugins: pluginHost.statuses(),
    docker: docker.status(),
    ...(android ? { android: android.status() } : {}),
    ...(refused() ? { refused: refused() } : {}),
  });

  const currentTerminalEnv = (): Record<string, string> => ({
    ...terminalEnv(proxy.port, { caPath: ca.certPath, ...terminalConfig }, platform),
    ...docker.terminalEnv(),
  });

  // Containers started from Wirescry terminals: a Docker API relay of Wirescry's own.
  const docker = new DockerSetup({
    dataDir,
    enabled: options.docker !== false,
    active: settings.dockerSetup !== false,
    windows: options.windowsDocker ?? settings.experimentalWindowsDocker === true,
    // Shown on the Setup page, so what happened to the last container is visible.
    onContainer: (event) => {
      console.log(
        `[wirescry] docker: ${event.name ?? event.image ?? 'container'} ${event.setUp ? 'set up' : `left as it is: ${event.reason}`}`,
      );
      broadcast({ type: 'status', status: status() });
    },
    findEndpoint: options.dockerEndpoint,
    onStatusChange: () => broadcast({ type: 'status', status: status() }),
    proxyPort: () => proxy.port,
    containerDir: () => terminalConfig.containerDir,
  });

  // Plugins such as Pro. They start once the API is up.
  const pluginHost = new PluginHost({
    plugins: options.plugins ?? [],
    enabled: options.pluginsEnabled ?? false,
    disabledReason: 'Plugins are turned off.',
    dataDir,
    encryptor: options.encryptor,
    app: options.app ?? { version: '0.0.0-test', releaseDate: new Date().toISOString() },
    refreshRules: () => refreshAllRules(),
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
    getExchange: (id) => store.get(id),
    getBody: async (id, side) => {
      const exchange = store.get(id);
      return exchange ? readBody(exchange, side) : null;
    },
    annotate: (plugin, id, annotation) => annotate(plugin, id, annotation),
    clearAnnotations: (plugin) => {
      for (const summary of store.list()) {
        if (summary.annotations?.some((a) => a.plugin === plugin)) annotate(plugin, summary.id, undefined);
      }
    },
    startTimeoutMs: options.pluginStartTimeoutMs,
    callTimeoutMs: options.pluginCallTimeoutMs,
  });

  /** Tells plugins once that an exchange has finished: its response (body included) recorded, or failed. */
  const noteCompleted = (summary: ExchangeSummary): void => {
    if (summary.websocket || completed.has(summary.id)) return;
    const finished =
      summary.failure !== undefined ||
      summary.durationMs !== undefined ||
      (summary.status !== undefined && summary.responseSize !== undefined && !summary.responding);
    if (!finished) return;
    const tell = (latest: ExchangeSummary): void => {
      clearTimeout(completionTimers.get(latest.id));
      completionTimers.delete(latest.id);
      completed.add(latest.id);
      pluginHost.exchangeCompleted(latest);
    };
    // The body is stored just after the response (or the part that came, if it broke off):
    // wait for it, but not for ever. A failure before any response has no body to wait for.
    const noBodyComing = summary.failure !== undefined && summary.status === undefined;
    if (summary.responseSize !== undefined || summary.imported || noBodyComing) {
      tell(summary);
    } else if (!completionTimers.has(summary.id)) {
      const timer = setTimeout(() => {
        const latest = store.get(summary.id)?.summary;
        if (latest && !completed.has(latest.id)) tell(latest);
      }, COMPLETION_GRACE_MS);
      timer.unref?.();
      completionTimers.set(summary.id, timer);
    }
  };

  /** A plugin's badge on an exchange, replacing its last; kept with the exchange's summary. */
  const annotate = (plugin: string, id: string, annotation: ExchangeAnnotation | undefined): void => {
    const exchange = store.get(id);
    if (!exchange) return;
    const others = (exchange.summary.annotations ?? []).filter((a) => a.plugin !== plugin);
    const annotations = annotation ? [...others, { ...annotation, plugin }] : others;
    const { annotations: _old, ...rest } = exchange.summary;
    void _old;
    const summary: ExchangeSummary = annotations.length > 0 ? { ...rest, annotations } : rest;
    store.upsert({ ...exchange, summary });
    updates.change(summary);
  };

  // Declared before the proxy, which asks it about each request; `proxy` is set below.
  const composer = new Composer({ proxyPort: () => proxy.port, caCert: () => ca.cert });

  const openProxy = (port: number | undefined): Promise<RunningProxy> =>
    startProxy({
      ca,
      store,
      bodies,
      websockets,
      port,
      upstreamCAs: options.upstreamCAs,
      onExchange: (exchange) => {
        updates.change(exchange.summary);
        noteCompleted(exchange.summary);
      },
      extraRules: () => pluginHost.rules(),
      describeRule: (ruleId) => pluginHost.describeRule(ruleId),
      ruleEndsWithoutResponse: (ruleId) => pluginHost.endsWithoutResponse(ruleId),
      isPaused: () => paused,
      isComposed: (remotePort, remoteAddress, id) => composer.claim(remotePort, remoteAddress, id),
      acceptConnection: (address) => docker.acceptsConnection(address),
      onCertificateRefused: (host) => {
        // Not while recording is paused: it's about traffic missing from the list.
        if (paused || stopping) return;
        // Without a hostname (HTTPS to an IP address) the proxy's certificate is for another name,
        // which a client can refuse even when it trusts Wirescry: not a sign of distrust.
        if (!cleanHost(host)) return;
        refusals.add(COMPUTER, host);
        // Together, a moment later: a program retrying would otherwise send a status each time.
        refusalsTimer ??= setTimeout(() => {
          refusalsTimer = undefined;
          broadcast({ type: 'status', status: status() });
        }, REFUSALS_PUBLISH_MS);
        refusalsTimer.unref?.();
      },
      onCATrusted: (userAgent) => {
        if (!/Firefox\//.test(userAgent) || firefoxTrusted) return;
        firefoxTrusted = true;
        // Firefox's own connections refused the certificate until now: they're settled.
        clearRefusals();
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

  // Listeners for single devices: like the main proxy, minus what belongs to this computer
  // only (Docker containers' host.docker.internal, the composer, Firefox trust, and Docker's
  // non-loopback connections).
  const openDeviceProxy = (
    source: ExchangeSource,
    port: number | undefined,
    allowLocal: () => boolean,
  ): Promise<RunningProxy> => {
    // The certificate this listener serves: after a reset, it keeps the old one until restarted.
    const spki = ca.spkiFingerprint;
    const record = (task: Promise<void> | undefined): void => {
      void task?.catch((error: unknown) => console.error('[wirescry] could not record device trust:', error));
    };
    return startProxy({
      ca,
      store,
      bodies,
      websockets,
      // A port nobody types in: let the system pick one. Mockttp's own choice is the lowest free
      // port from 8000, which developers' servers want, and which anything starting at the same
      // moment would also pick (e.g. while a listener restarts on its port in a certificate reset).
      port: port ?? 0,
      upstreamCAs: options.upstreamCAs,
      onExchange: (exchange) => {
        updates.change(exchange.summary);
        noteCompleted(exchange.summary);
      },
      extraRules: () => pluginHost.rules(),
      describeRule: (ruleId) => pluginHost.describeRule(ruleId),
      ruleEndsWithoutResponse: (ruleId) => pluginHost.endsWithoutResponse(ruleId),
      isPaused: () => paused,
      source,
      // Its HTTPS check arrived on this device's own listener: a browser there trusts the CA.
      onCATrusted: () => record(android?.markTrusted(source.id, spki)),
      onCAUntrusted: () => record(android?.markUntrusted(source.id, spki)),
      onCertificateRefused: (host) => android?.certificateRefused(source.id, host),
      dockerHostToLocalhost: false,
      egress: { allowLocal, ...options.deviceEgress },
    });
  };
  const devices = deviceListenerSet({ start: openDeviceProxy });
  const refreshAllRules = async (): Promise<void> => {
    await Promise.all([proxy.refreshRules(), devices.refreshRules()]);
  };
  const listeners: DeviceListeners = {
    open: devices.open,
    close: devices.close,
    list: devices.list,
    setLocalAccess: devices.setLocalAccess,
    onPortChange: devices.onPortChange,
  };
  step('proxy');
  await docker.refresh();
  step('docker');
  // Rewritten whenever the port or certificate changes, so the one-line setup stays current.
  terminalScripts = await writeShellScripts(dataDir, currentTerminalEnv());
  // Android devices over the user's ADB server. Started in the background: finding or starting
  // the server can take a few seconds, and nothing else waits for it.
  // A device an earlier run left set up has no internet until it's put back: Android setup stays
  // on for it even if the setting turns it off, so Setup can offer Restore.
  const androidOn =
    options.android === 'setting'
      ? settings.androidSetup !== false ||
        (await new CaptureRecords(path.join(dataDir, ANDROID_RECORDS_DIR)).list()).length > 0
      : options.android !== undefined && options.android !== false;
  const androidOptions = typeof options.android === 'object' ? options.android : {};
  android = androidOn
    ? new AndroidSetup({
        findAdb: () => findAdb({ setting: settings.adbPath }),
        // In the app, only devices left set up need a server started at launch; otherwise
        // Wirescry uses one that's running and starts one only when asked.
        startServerAtLaunch: options.android !== 'setting',
        log: (message) => console.log(`[wirescry] android: ${message}`),
        notify: options.notify,
        ...androidOptions,
        capture: {
          listeners,
          recordsDir: path.join(dataDir, ANDROID_RECORDS_DIR),
          certificate: () => ({ cert: ca.cert, spki: ca.spkiFingerprint }),
          trustFile: path.join(dataDir, ANDROID_TRUST_FILE),
          ...androidOptions.capture,
        },
        onStatusChange: () => broadcast({ type: 'status', status: status() }),
      })
    : undefined;
  void android?.start();
  step('android');

  /** Restarts the proxy, going back to the old port if the new one can't be used. */
  const restartProxy = async (port: number | undefined): Promise<void> => {
    const previousPort = proxy.port;
    await proxy.stop();
    try {
      proxy = await openProxy(port);
    } catch (error) {
      try {
        proxy = await openProxy(previousPort);
      } catch (again) {
        // Its old port was taken while it was closed (a certificate reset reopens on the same
        // port). A proxy on another port beats none: clients set to the old one need changing,
        // which the error and the status say.
        console.error(`[wirescry] proxy couldn't reopen port ${previousPort}:`, again);
        proxy = await openProxy(undefined);
        await proxy.refreshRules();
        terminalScripts = await writeShellScripts(dataDir, currentTerminalEnv());
        broadcast({ type: 'status', status: status() });
        throw new Error(
          `Port ${previousPort} was taken while the proxy restarted, so it's on port ${proxy.port} now.`,
          { cause: again },
        );
      }
      await proxy.refreshRules();
      throw error;
    }
    // Plugins may have changed their rules while the new proxy was starting; reapply.
    await proxy.refreshRules();
    terminalScripts = await writeShellScripts(dataDir, currentTerminalEnv());
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
        ...(item.requestTrailers ? { requestTrailers: item.requestTrailers } : {}),
        ...(item.responseTrailers ? { responseTrailers: item.responseTrailers } : {}),
        timing: item.timing,
        ...(requestBody ? { requestBody: { size: requestBody.size, stored: requestBody.stored } } : {}),
        ...(responseBody ? { responseBody: { size: responseBody.size, stored: responseBody.stored } } : {}),
        importedFrom,
      };
      // Oldest first, as `removed` above counts: the file's own entries are never the ones dropped.
      store.upsert(detail, { keepLive: false });
      updates.change(summary);
      noteCompleted(summary);
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
        // Docker may have been installed or started since; the new terminal should know.
        if (await docker.refresh()) {
          terminalScripts = await writeShellScripts(dataDir, currentTerminalEnv());
          broadcast({ type: 'status', status: status() });
        }
        await launchTerminal(terminal, currentTerminalEnv(), {
          scriptDir: path.join(dataDir, 'terminal'),
          proxyAddress: `127.0.0.1:${proxy.port}`,
        });
        return undefined;
      }
      case 'composeSend':
        return composer.send(command.request);
      case 'composeCancel':
        return composer.cancel(String(command.exchangeId));
      case 'rescanBrowsers':
        browsers = await detectBrowsers();
        if (await docker.refresh()) terminalScripts = await writeShellScripts(dataDir, currentTerminalEnv());
        broadcast({ type: 'status', status: status() });
        return status().browsers;
      case 'clear':
        if (command.ids) {
          // Just these: the UI clears what it showed, and keeps what arrived since.
          if (!Array.isArray(command.ids)) throw new Error('ids must be a list');
          for (const id of command.ids) {
            if (typeof id === 'string' && store.delete(id)) forget(id);
          }
          return undefined;
        }
        clears += 1;
        updates.reset();
        store.clear();
        completed.clear();
        for (const timer of completionTimers.values()) clearTimeout(timer);
        completionTimers.clear();
        websockets.clear();
        await importWrite;
        await bodies.clear();
        broadcast({ type: 'cleared' });
        // What refused the certificate belongs with the traffic that's gone.
        if (refusals.of(COMPUTER)) {
          clearRefusals();
          broadcast({ type: 'status', status: status() });
        }
        return undefined;
      case 'clearRefused': {
        const seen = command.seen;
        // Started over since the window saw them: those are gone already.
        if (!refusals.of(COMPUTER) || (seen && seen.epoch !== refusalsEpoch)) return undefined;
        if (seen) {
          refusals.subtract(COMPUTER, seen);
          refusalsEpoch += 1;
        } else clearRefusals();
        broadcast({ type: 'status', status: status() });
        return undefined;
      }
      case 'setPaused':
        paused = command.paused;
        broadcast({ type: 'paused', paused });
        return undefined;
      case 'androidRefresh':
        if (!android) throw new Error('Android setup is off.');
        await android.refresh();
        return undefined;
      case 'androidCapture':
        if (!android) throw new Error('Android setup is off.');
        return android.captureDevice(
          String(command.deviceId),
          typeof command.replaceProxy === 'string' ? command.replaceProxy : undefined,
          command.confirmWireless === true,
        );
      case 'androidResume':
        if (!android) throw new Error('Android setup is off.');
        await android.resumeDevice(String(command.deviceId));
        return undefined;
      case 'androidStop':
        if (!android) throw new Error('Android setup is off.');
        await android.stopDevice(String(command.deviceId));
        return undefined;
      case 'androidClearProxy':
        if (!android) throw new Error('Android setup is off.');
        await android.clearProxy(String(command.deviceId));
        return undefined;
      case 'androidSendCertificate':
        if (!android) throw new Error('Android setup is off.');
        return android.sendCertificate(String(command.deviceId));
      case 'androidCheckCertificate':
        if (!android) throw new Error('Android setup is off.');
        return android.checkCertificate(String(command.deviceId));
      case 'androidShowCertificates':
        if (!android) throw new Error('Android setup is off.');
        await android.showInstalledCertificates(String(command.deviceId));
        return undefined;
      case 'androidForget':
        if (!android) throw new Error('Android setup is off.');
        await android.forgetDevice(String(command.deviceId));
        return undefined;
      case 'androidSetLocalAccess':
        if (!android) throw new Error('Android setup is off.');
        android.setLocalAccess(String(command.deviceId), command.allowed === true);
        return undefined;
      case 'setDockerSetup': {
        docker.setActive(command.enabled === true);
        settings = { ...settings, dockerSetup: command.enabled === true ? undefined : false };
        await saveSettings(dataDir, settings);
        // New terminals get DOCKER_HOST only while it's on.
        terminalScripts = await writeShellScripts(dataDir, currentTerminalEnv());
        broadcast({ type: 'status', status: status() });
        return undefined;
      }
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
          try {
            await restartProxy(proxy.port);
          } finally {
            // Even if the main proxy had to move: device listeners must not keep the old CA.
            await devices.restartAll();
            android?.certificateChanged();
            // Refusals were of the old certificate, which the proxy served until just now.
            clearRefusals();
          }
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
  step('API');

  await pluginHost.startAll();
  step('plugins');

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
    listeners,
    async stopAndroid(timeoutMs = ANDROID_STOP_TIMEOUT_MS) {
      await android?.stopAll(timeoutMs);
    },
    async stop() {
      stopping = true;
      // First, and quickly: put capturing devices back before their listeners go (a device left
      // pointing at a closed port has no internet), well inside the time the app gives the
      // backend to stop. Any it can't reach keep their records, and are offered Restore next time.
      await android?.stopAll(ANDROID_STOP_TIMEOUT_MS);
      android?.stop();
      composer.close();
      clearRefusals();
      for (const timer of completionTimers.values()) clearTimeout(timer);
      completionTimers.clear();
      await pluginHost.stopAll();
      updates.reset();
      await Promise.all([api.stop(), proxy.stop(), devices.stopAll(), formatter.close(), docker.stop()]);
      await bodies.close();
    },
  };
}
