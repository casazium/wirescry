import { getEventListeners } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type {
  BodyContent,
  BodyRangeContent,
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
  SseEventsView,
  WebSocketMessages,
} from '../shared/api';
import { startApiServer, type CommandContext } from './api';
import {
  harEntry,
  harFrame,
  MAX_HAR_BODY_BYTES,
  MAX_HAR_IMPORT_BYTES,
  parseHar,
  type HarEntryMeta,
  type HarExportItem,
} from './har';
import { knownPart } from './har-redact';
import { HarRedactor, type RedactOutcome } from './redactor';
import type { Encryptor } from './secure-store';
import { BodyMemo, Nudger } from './body-memo';
import { headerValue, toBodyContent, writeBodyToFile, type WrittenBody } from './body-content';
import { exchangeType } from '../shared/exchange-type';
import { Formatter, MAX_FORMAT_INPUT } from './formatter';
import { Masker, Superseded, type EventsAnswer, type MaskAnswer, type MessagesAnswer } from './masker';
import { applySpans, redactHeaders } from '../shared/redact';
import { assembleEvents, assembleMessages } from './mask-streams';
import type { SseItem } from '../shared/sse';

/** Earlier messages or events taught again, at most, when the mask worker lost a stream's. */
const MAX_REPLAYED = 2_000;
import { redactBody } from '../shared/redact-body';
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
import { ANDROID_RECORDS_DIR, type HarRedactionCounts } from '../shared/ipc';
import { Composer } from './composer';
import { javaAgentPathProblem, terminalEnv } from '../shared/terminal-env';
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
import { findAgentJars, JAVA_AGENT_DIR, JavaAgentHost, type AgentJars } from './java/agent-host';
import { JavaAttach, type JavaAttachOptions } from './java/attach-manager';
import type { FileOps } from './java/agent-files';
import { InMemoryRequestStore } from './store';
import { UpdateBatcher } from './update-batcher';
import type { BackendPlugin } from '../plugin-api/backend';
import { PluginHost } from './plugin-host';
import * as mockttp from 'mockttp';
import { WebSocketStore } from './websocket-store';
import { SseReader } from './sse-reader';
import { upstreamTargetOf } from './upstream-target';
import {
  checkSearchId,
  matchExchanges,
  MAX_NAMED_SEARCHES,
  SearchStopped,
  type BodyAccess,
  type StopReason,
} from './search';
import { compileQuery } from '../shared/query';

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
  /**
   * Java programs' agent (native/java-agent). true: find its jars, and run it while the
   * javaAgentStartup setting is on (the app passes this). Jars given here run it whatever the
   * setting (tests), unless `followSetting`. Left out or false, it's off, so tests never write a
   * control file that real JVMs read.
   */
  javaAgent?:
    | boolean
    | {
        jars: AgentJars;
        heartbeatMs?: number;
        ops?: FileOps;
        followSetting?: boolean;
        /** Replaces how attaching finds a JDK and runs the attacher, and how often it reads status. */
        attach?: Partial<Pick<JavaAttachOptions, 'findJdk' | 'attacher' | 'pollMs' | 'statusReader'>>;
      };
}

export interface HarImportCounts {
  imported: number;
  skipped: number;
  problems: string[];
  removed: number;
  /** The file says its secrets were redacted by Wirescry. */
  redacted: boolean;
}

export interface HarExportOptions {
  /** Redact secrets (the default); `false` writes everything as captured. */
  redact?: boolean;
  /** Stops the export: nothing is written. */
  signal?: AbortSignal;
}

export interface HarExportCounts {
  count: number;
  /** When redacting: what redaction did. */
  redaction?: HarRedactionCounts;
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
  exportHar(file: string, exchangeIds: string[], options?: HarExportOptions): Promise<HarExportCounts>;
  /**
   * Adds the exchanges in a HAR file to the traffic list. `name` is the file's name to
   * show (the file may be a copy). `removed` counts older exchanges dropped to make room.
   */
  importHar(file: string, name?: string): Promise<HarImportCounts>;
  /** How many searches (matchExchanges) are running. For tests. */
  searchesRunning(): number;
  /** How many searches are listening for their window to close. For tests: it should match. */
  searchListeners(): number;
  /** How many exchanges body search remembers something about. For tests. */
  bodyMemoSize(): number;
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

/** How long quitting waits to tell Java agents (see stopJavaAgent). */
const JAVA_AGENT_STOP_MS = 500;

/** Logged once per start: a packaged app without its agent is a broken build. */
function noAgentJars(): undefined {
  console.error(
    "[wirescry] java agent: its jars aren't in the app; Java programs get the terminal's options alone",
  );
  return undefined;
}

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
  /** Wirescry's own ports on this computer: set once they're all open, before plugins start. */
  let ownPorts = (): number[] => [];
  // Event streams' events, read as they arrive.
  const sse = new SseReader({
    getExchange: (id) => store.get(id),
    readRange: async (id, side, start, maxBytes) => {
      const exchange = store.get(id);
      const range = exchange ? await bodies.readRange(id, side, start, maxBytes) : undefined;
      return range && { ...range, decoded: exchange!.importedFrom !== undefined };
    },
  });
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
  let javaAgent: JavaAgentHost | undefined;
  let javaAttach: JavaAttach | undefined;
  let agentStarting: Promise<void> | undefined;
  /** Why the agent couldn't be set up, for Setup. */
  let agentProblem: string | undefined;
  /** Whether the agent follows the javaAgentStartup setting: the app's, or a test's that asks. */
  const agentFollowsSetting =
    options.javaAgent === true ||
    (typeof options.javaAgent === 'object' && options.javaAgent.followSetting === true);
  /** The javaAgentStartup setting (always on for tests that give the jars, unless they follow it). */
  let agentStartup = agentFollowsSetting
    ? settings.javaAgentStartup === true
    : options.javaAgent !== undefined && options.javaAgent !== false;
  /** Says off to Java agents, within JAVA_AGENT_STOP_MS (on Windows a rename can wait on readers). */
  const stopJavaAgent = async (): Promise<void> => {
    const stopped = (async () => {
      await agentStarting;
      await javaAgent?.stop();
    })().catch(() => undefined);
    await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, JAVA_AGENT_STOP_MS).unref())]);
  };
  /** After the port, the certificate or a setup setting changes: terminal scripts and Java agents. */
  const refreshSetup = async (): Promise<void> => {
    // Each whatever the other does.
    const agent = javaAgent?.update(agentSettings()).catch((error: unknown) => {
      console.error('[wirescry] java agent: control file not updated:', error);
    });
    try {
      terminalScripts = await writeShellScripts(dataDir, currentTerminalEnv());
    } finally {
      await agent;
    }
  };
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

  // What body search found in each body, and searches it owes arriving bodies (see search.ts).
  const bodyMemo = new BodyMemo(STORE_LIMIT);
  // Tells the window about the exchange again, which searches it again.
  const nudges = new Nudger((id) => {
    const exchange = store.get(id);
    if (exchange) updates.change(exchange.summary);
  });

  // Everything kept about an exchange besides its store entry.
  const forget = (id: string): void => {
    bodyMemo.forget(id);
    nudges.forget(id);
    completed.delete(id);
    clearTimeout(completionTimers.get(id));
    completionTimers.delete(id);
    updates.remove(id);
    websockets.delete(id);
    sse.delete(id);
    void bodies.delete(id).catch(() => undefined);
  };
  /** An exchange's URL, headers and trailers, as HAR parts, for the mask worker to learn. */
  const maskPart = (exchange: ExchangeDetail): Record<string, unknown> => {
    const har = (headers: Header[] | undefined) => headers?.map(([name, value]) => ({ name, value }));
    return {
      request: {
        url: exchange.summary.url,
        headers: har(exchange.requestHeaders),
        _trailers: har(exchange.requestTrailers),
      },
      response: { headers: har(exchange.responseHeaders), _trailers: har(exchange.responseTrailers) },
    };
  };
  // Declared before the store, which tells it of each change; `store` is set below.
  const masker = new Masker({
    all: () =>
      store.list().flatMap((summary) => {
        const exchange = store.get(summary.id);
        return exchange ? [maskPart(exchange)] : [];
      }),
    part: (id) => {
      const exchange = store.get(id);
      return exchange && maskPart(exchange);
    },
  });
  const store = new InMemoryRequestStore(STORE_LIMIT, forget, (id) => masker.touched(id));

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
    ...(options.javaAgent
      ? {
          javaAgent: {
            startup: agentStartup,
            ...(javaAgent ? { stubPath: javaAgent.stubPath } : {}),
            ...(agentProblem ? { problem: agentProblem } : {}),
            ...(javaAttach?.status() ? { attach: javaAttach.status() } : {}),
          },
        }
      : {}),
    ...(android ? { android: android.status() } : {}),
    ...(refused() ? { refused: refused() } : {}),
  });

  const currentTerminalEnv = (): Record<string, string> => ({
    ...terminalEnv(
      proxy.port,
      { caPath: ca.certPath, ...terminalConfig },
      platform,
      javaAgent && agentStartup ? javaAgent.stubPath : undefined,
    ),
    ...docker.terminalEnv(),
  });

  // Containers started from Wirescry terminals: a Docker API relay of Wirescry's own.
  const docker = new DockerSetup({
    dataDir,
    enabled: options.docker !== false,
    active: settings.dockerSetup !== false,
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
    upstreamTarget: (id) => {
      const exchange = store.get(id);
      return exchange ? upstreamTargetOf(exchange, options.upstreamCAs ?? [], ownPorts()) : null;
    },
    readBody: async (id, side, offset, maxBytes) => {
      const exchange = store.get(id);
      if (!exchange) return null;
      const range = await bodies.readRange(id, side, offset, maxBytes);
      // Bodies imported from HAR files are stored decoded.
      return range ? { ...range, decoded: exchange.importedFrom !== undefined } : null;
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
  // Java programs' agent: its jars installed and its control file written, in the background (it
  // reads and hashes a few MB). Nothing else waits for it; see agentStarting.
  const agentOptions = typeof options.javaAgent === 'object' ? options.javaAgent : undefined;
  const agentSettings = () => ({
    proxyPort: proxy.port,
    caPath: ca.certPath,
    caPem: ca.cert,
    startup: agentStartup,
  });
  let foundJars: AgentJars | undefined;
  const agentJars = (): AgentJars | undefined =>
    agentOptions ? agentOptions.jars : (foundJars ??= findAgentJars() ?? noAgentJars());
  /** Starts the agent's host, unless it's running or starting. Once started, it runs until quit. */
  const startJavaAgent = (): void => {
    if (javaAgent || agentStarting || !options.javaAgent) return;
    const jars = agentJars();
    if (!jars) {
      agentProblem = "This copy of Wirescry doesn't include its Java agent.";
      return;
    }
    agentProblem = undefined;
    agentStarting = JavaAgentHost.start(
      {
        dir: path.join(dataDir, JAVA_AGENT_DIR),
        jars,
        version: options.app?.version ?? '0.0.0',
        heartbeatMs: agentOptions?.heartbeatMs,
        ops: agentOptions?.ops,
      },
      agentSettings(),
    ).then(
      async (host) => {
        javaAgent = host;
        agentProblem = javaAgentPathProblem(host.stubPath, platform);
        // The port or the certificate may have changed while it started, and terminals now get it.
        // A quit while it started is done by stopJavaAgent, which waits for this.
        await refreshSetup();
        broadcast({ type: 'status', status: status() });
      },
      (error: unknown) => {
        console.error('[wirescry] java agent not set up:', error);
        agentProblem = `Wirescry couldn't set up its Java agent: ${(error as Error).message}`;
        agentStarting = undefined;
        broadcast({ type: 'status', status: status() });
      },
    );
  };
  // Also with the setting off, if it was ever on: terminals from then still carry the agent, and
  // without a heartbeat it would take Wirescry for gone and send them direct.
  if (
    agentStartup ||
    (agentFollowsSetting && existsSync(path.join(dataDir, JAVA_AGENT_DIR, 'control.properties')))
  ) {
    startJavaAgent();
  }
  /** The running host, started if need be: attached agents follow its control file. */
  const agentHost = async (): Promise<JavaAgentHost> => {
    startJavaAgent();
    await agentStarting;
    if (!javaAgent) throw new Error(agentProblem ?? "Wirescry's Java agent isn't set up.");
    return javaAgent;
  };
  /** Attaching to running programs, made when Setup first asks. */
  const javaAttacher = (): JavaAttach => {
    if (!options.javaAgent) throw new Error('Java setup is off.');
    if (javaAttach) return javaAttach;
    const jars = agentJars();
    if (!jars) throw new Error("This copy of Wirescry doesn't include its Java agent.");
    javaAttach = new JavaAttach({
      dir: path.join(dataDir, JAVA_AGENT_DIR),
      attachJar: jars.attach,
      version: options.app?.version ?? '0.0.0',
      host: agentHost,
      running: () => javaAgent,
      warningOk: () => settings.javaAttachWarningOk === true,
      saveWarningOk: async () => {
        const next = { ...settings, javaAttachWarningOk: true };
        await saveSettings(dataDir, next);
        settings = next;
      },
      changed: () => broadcast({ type: 'status', status: status() }),
      ...agentOptions?.attach,
    });
    return javaAttach;
  };
  // Rewritten whenever the port or certificate changes, so the one-line setup stays current.
  await refreshSetup();
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
        await refreshSetup();
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
    await refreshSetup();
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

  /** Text of Wirescry's own (an error, a reason) with anything that looks secret hidden. */
  const sweepText = (text: string): string => applySpans(text, redactBody(text, 'text/plain').spans);

  /** A body masked in the worker, its request body's values learned first for a response. */
  const maskJob = async (
    exchange: ExchangeDetail,
    side: BodySide,
    content: BodyContent,
    formatted?: string,
  ): Promise<MaskAnswer> => {
    let request: { bytes: Uint8Array; mediaType: string; cut: boolean } | undefined;
    if (side === 'response') {
      try {
        const body = await readBody(exchange, 'request');
        if (body && !body.decodeError) {
          request = {
            bytes: Buffer.from(body.base64, 'base64'),
            mediaType: body.contentType ?? '',
            cut: body.truncated,
          };
        }
      } catch {
        // Its values just aren't learned.
      }
    }
    return masker.mask(exchange.summary.id, {
      own: maskPart(exchange),
      ...(request ? { request } : {}),
      body: {
        bytes: Buffer.from(content.base64, 'base64'),
        mediaType: content.contentType ?? '',
        cut: content.truncated,
      },
      ...(formatted !== undefined ? { formatted } : {}),
    });
  };

  /**
   * A body as the window shows it while View › Hide Secrets is on. Fails closed: a body that can't
   * be checked comes back hidden, with no bytes.
   */
  const maskedBody = async (
    exchange: ExchangeDetail,
    side: BodySide,
    content: BodyContent,
  ): Promise<BodyContent> => {
    const [type, encoding] = redactHeaders([
      ['content-type', content.contentType ?? ''],
      ['content-encoding', content.encoding ?? ''],
    ]).headers;
    const { decodeError, ...rest } = content;
    const shown: BodyContent = {
      ...rest,
      ...(content.contentType !== undefined ? { contentType: type![1] } : {}),
      ...(content.encoding !== undefined ? { encoding: encoding![1] } : {}),
    };
    const hidden = (why: string): BodyContent => ({ ...shown, base64: '', masked: { hidden: why } });
    // Still compressed: it can't be read, so it can't be checked.
    if (decodeError) return hidden(`This body couldn’t be decoded, so it can’t be checked for secrets.`);
    let answer: MaskAnswer;
    try {
      answer = await maskJob(exchange, side, content);
    } catch (error) {
      if (error instanceof Superseded) throw error;
      return hidden('Couldn’t check this body for secrets.');
    }
    if ('failed' in answer) return hidden(answer.failed);
    const { masked, full } = answer;
    if ('hidden' in masked) return hidden(masked.hidden);
    return {
      ...shown,
      base64: Buffer.from(masked.bytes).toString('base64'),
      masked: {
        ...(masked.text !== undefined ? { text: masked.text } : {}),
        ranges: masked.ranges,
        ...(masked.binary ? { binary: true as const } : {}),
        ...(full ? { full: true as const } : {}),
      },
    };
  };

  /**
   * A page of WebSocket messages as the window shows them while Hide Secrets is on. Fails closed.
   * If the worker lost what the stream's earlier pages taught (it restarted), they're taught again.
   */
  const maskedMessages = async (
    exchange: ExchangeDetail,
    page: WebSocketMessages,
    fresh: boolean,
  ): Promise<WebSocketMessages> => {
    if (page.messages.length === 0) return page;
    const id = exchange.summary.id;
    const run = (messages: WebSocketMessages['messages'], fromStart: boolean) =>
      masker.maskMessages(id, {
        own: maskPart(exchange),
        stream: { key: `ws:${id}`, fresh: fromStart },
        messages: messages.map((m) => {
          const bytes = Buffer.from(m.base64, 'base64');
          return { bytes, binary: m.isBinary, cut: bytes.length < m.size };
        }),
      });
    let answer: MessagesAnswer | undefined;
    try {
      answer = await run(page.messages, fresh);
      if (!('failed' in answer) && answer.lost) {
        const first = page.messages[0]!.index;
        const earlier = websockets
          .get(id, -1, Number.MAX_SAFE_INTEGER)
          .messages.filter((m) => m.index < first)
          .slice(-MAX_REPLAYED);
        const again = await run([...earlier, ...page.messages], true);
        answer = 'failed' in again ? again : { ...again, messages: again.messages.slice(earlier.length) };
      }
    } catch (error) {
      if (error instanceof Superseded) throw error;
      answer = undefined;
    }
    return assembleMessages(page, answer);
  };

  /** A page of an event stream's items as the window shows them while Hide Secrets is on. Fails closed. */
  const maskedEvents = async (
    exchange: ExchangeDetail,
    view: SseEventsView,
    fresh: boolean,
  ): Promise<SseEventsView> => {
    if (view.items.length === 0) return assembleEvents(view, undefined, sweepText);
    const id = exchange.summary.id;
    const run = (items: SseItem[], fromStart: boolean) =>
      masker.maskEvents(id, {
        own: maskPart(exchange),
        stream: { key: `sse:${id}:${view.serial}`, fresh: fromStart },
        items,
      });
    let answer: EventsAnswer | undefined;
    try {
      answer = await run(view.items, fresh);
      if (!('failed' in answer) && answer.lost) {
        const first = view.items[0]!.index;
        const kept = await sse.read(id, 0);
        const earlier =
          kept && kept.serial === view.serial
            ? kept.items.filter((item) => item.index < first).slice(-MAX_REPLAYED)
            : [];
        const again = await run([...earlier, ...view.items], true);
        answer = 'failed' in again ? again : { ...again, items: again.items.slice(earlier.length) };
      }
    } catch (error) {
      if (error instanceof Superseded) throw error;
      answer = undefined;
    }
    return assembleEvents(view, answer, sweepText);
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

  /** Exports running, stopped by `stop()`, which waits for them to finish. */
  const exportsRunning = new Set<AbortController>();
  const exportsFinishing = new Set<Promise<void>>();

  const exportHar = async (
    file: string,
    exchangeIds: string[],
    { redact = true, signal }: HarExportOptions = {},
  ): Promise<HarExportCounts> => {
    const stopper = new AbortController();
    const onAbort = (): void => stopper.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) stopper.abort();
    const checkStopped = (): void => {
      if (stopper.signal.aborted) throw new Error('The export was stopped.');
    };
    const redactor = redact ? new HarRedactor() : undefined;
    stopper.signal.addEventListener('abort', () => void redactor?.close(), { once: true });
    const { head, tail } = harFrame(options.app?.version ?? '0.0.0', { redacted: redact });
    // Written to a temporary file and renamed into place, so a failure never leaves half a file.
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    let out: Awaited<ReturnType<typeof open>> | undefined;
    // Small entries are gathered and written together.
    let pending: string[] = [];
    let pendingLength = 0;
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const text = pending.join('');
      pending = [];
      pendingLength = 0;
      await out!.writeFile(text, 'utf8');
    };
    const write = async (text: string): Promise<void> => {
      pending.push(text);
      pendingLength += text.length;
      if (pendingLength >= 1024 * 1024) await flush();
    };
    let count = 0;
    const redaction: HarRedactionCounts = {
      values: 0,
      requests: 0,
      dropped: 0,
      notScanned: 0,
      leftOut: 0,
      full: false,
    };
    // Added just before the try, so its finally always takes them out again.
    exportsRunning.add(stopper);
    let finished!: () => void;
    const finishing = new Promise<void>((resolve) => (finished = resolve));
    exportsFinishing.add(finishing);
    try {
      out = await open(temp, 'wx', 0o600);
      // The exchanges as they are now: one cleared meanwhile is still written, as it was.
      const exchanges = [...new Set(exchangeIds)].flatMap((id) => {
        const exchange = store.get(id);
        return exchange ? [exchange] : [];
      });
      if (redactor) {
        // First, the values in every URL and header, so one seen in any of them is found in
        // every body.
        await redactor.collect(
          exchanges.map((detail) =>
            knownPart(harEntry({ detail, requestBody: null, responseBody: null, notes: [] })),
          ),
        );
      }
      await write(head);
      for (const exchange of exchanges) {
        checkStopped();
        const id = exchange.summary.id;
        const notes: string[] = [];
        const item = {
          detail: exchange,
          requestBody: await harBody(exchange, 'request', notes),
          responseBody: await harBody(exchange, 'response', notes),
          messages: exchange.summary.websocket ? websockets.get(id, -1, Number.MAX_SAFE_INTEGER) : undefined,
          notes,
        };
        // Two very large bodies can make an entry longer than a string can be: then leave out
        // the response body, and if need be the request body too. Redacting does the same
        // when an entry can't be redacted.
        const attempt = (step: number, why: string): HarExportItem =>
          step === 0
            ? item
            : step === 1
              ? {
                  ...item,
                  responseBody: null,
                  notes: [...notes, `The response body ${why}, so it was left out.`],
                }
              : {
                  ...item,
                  requestBody: null,
                  responseBody: null,
                  notes: [...notes, `The bodies ${why}, so they were left out.`],
                };
        let text: string | undefined;
        let why = 'was too large to write';
        const last = 2;
        // The worker gets one more try at an entry without bodies before the export fails.
        let lastRetried = false;
        for (let step = 0; step <= last; step++) {
          const tried = attempt(step, step === 1 ? why : why.replace(/^was/, 'were'));
          if (!redactor) {
            try {
              text = JSON.stringify(harEntry(tried));
              break;
            } catch (error) {
              if (!(error instanceof RangeError) || step === last) throw error;
              continue;
            }
          }
          checkStopped();
          const meta: HarEntryMeta = {
            cut: { request: false, response: false },
            base64Frames: [],
            cutFrames: [],
          };
          let entry: Record<string, unknown>;
          try {
            entry = harEntry(tried, meta);
          } catch (error) {
            if (!(error instanceof RangeError) || step === last) throw error;
            why = 'was too large to write';
            continue;
          }
          let outcome: RedactOutcome;
          try {
            outcome = await redactor.redact(entry, meta);
          } catch (error) {
            checkStopped();
            // Even without its bodies, the worker can't redact it: something is wrong with
            // redaction itself, so stop rather than leave out every request.
            if (step === last && !lastRetried) {
              lastRetried = true;
              step -= 1;
              continue;
            }
            if (step === last)
              throw new Error(`Couldn't redact the requests: ${(error as Error).message}`, { cause: error });
            why = "couldn't be redacted";
            continue;
          }
          if ('tooLarge' in outcome) {
            if (step === last) break;
            why = 'was too large to write';
            continue;
          }
          if ('dropped' in outcome) break;
          text = outcome.text;
          redaction.values += outcome.values;
          if (outcome.values > 0) redaction.requests += 1;
          redaction.notScanned += outcome.notScanned;
          // Bodies the ladder took out count as left out too.
          const removed =
            step === 0
              ? 0
              : step === 1
                ? Number(item.responseBody !== null)
                : Number(item.requestBody !== null && (exchange.requestBody?.size ?? 0) > 0) +
                  Number(item.responseBody !== null);
          redaction.leftOut += outcome.leftOut + removed;
          redaction.full ||= outcome.full;
          break;
        }
        if (text === undefined) {
          // Only when redacting: the entry couldn't be redacted, so it's left out.
          redaction.dropped += 1;
          continue;
        }
        await write((count > 0 ? ',\n' : '') + text);
        count += 1;
      }
      checkStopped();
      if (count === 0) {
        throw new Error(
          redaction.dropped > 0
            ? 'None of these requests could be redacted.'
            : 'None of those requests are in the list any more.',
        );
      }
      await write(tail);
      await flush();
      await out.close();
      // Stopped while finishing: the caller may have gone, so nothing goes in place.
      checkStopped();
      await rename(temp, file);
    } catch (error) {
      await out?.close().catch(() => undefined);
      await rm(temp, { force: true });
      // Stopping fails whatever was waiting on the worker: say why.
      if (stopper.signal.aborted) throw new Error('The export was stopped.', { cause: error });
      throw error;
    } finally {
      exportsRunning.delete(stopper);
      signal?.removeEventListener('abort', onAbort);
      await redactor?.close();
      exportsFinishing.delete(finishing);
      finished();
    }
    return redactor ? { count, redaction } : { count };
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
    return {
      imported,
      skipped: parsed.skipped,
      problems: parsed.problems,
      removed,
      redacted: parsed.redacted === true,
    };
  };

  // Searches running, so Clear, stop or their window closing can stop them; and those each window
  // named, so it can cancel one it has replaced (its oldest goes past MAX_NAMED_SEARCHES). Names
  // are per window: one window can't cancel another's search.
  const searches = new Map<AbortController, Promise<unknown>>();
  const namedByWindow = new WeakMap<AbortSignal, Map<string, AbortController>>();
  // Windows with searches, while they're open: for searchListeners(), in tests.
  const openWindows = new Set<AbortSignal>();
  const namesOf = (context: CommandContext): Map<string, AbortController> => {
    let names = namedByWindow.get(context.signal);
    if (!names) {
      namedByWindow.set(context.signal, (names = new Map()));
      openWindows.add(context.signal);
      context.signal.addEventListener('abort', () => openWindows.delete(context.signal), { once: true });
    }
    return names;
  };
  const stopSearches = (reason: StopReason): void => {
    for (const search of searches.keys()) search.abort(new SearchStopped(reason));
  };

  // Body search reads stored bodies piece by piece, decoded as the body view decodes them. A
  // body that can't be read (removed meanwhile, or a file error) counts as gone.
  // A body still arriving is searched as far as it has arrived.
  const bodyAccess: BodyAccess = {
    source: (exchange, side) => {
      const id = exchange.summary.id;
      const state = bodies.state(id, side);
      if (!state) return undefined;
      return {
        read: (start, max) => bodies.readRange(id, side, start, max).catch(() => undefined),
        encoding: headerValue(decodingHeaders(exchange, side), 'content-encoding'),
        serial: state.serial,
        state,
      };
    },
  };
  // An arriving body whose search had to wait for its throttle: told about again when it may be
  // searched, so a last part that came meanwhile is found.
  const nudge = (id: string, at: number): void => nudges.schedule(id, at);

  const handleCommand = async (command: ClientCommand, context: CommandContext): Promise<unknown> => {
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
          await refreshSetup();
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
        if (await docker.refresh()) await refreshSetup();
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
        // First: a search reading what's about to go stops (on Windows, before its files are removed).
        stopSearches('cleared');
        bodyMemo.clear();
        nudges.clear();
        updates.reset();
        store.clear();
        // The session's values go with its traffic.
        masker.reset();
        completed.clear();
        for (const timer of completionTimers.values()) clearTimeout(timer);
        completionTimers.clear();
        websockets.clear();
        sse.clear();
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
      case 'setJavaAgentStartup': {
        if (!options.javaAgent) throw new Error('Java setup is off.');
        const enabled = command.enabled === true;
        const next = { ...settings, javaAgentStartup: enabled ? true : undefined };
        await saveSettings(dataDir, next);
        settings = next;
        agentStartup = enabled;
        // Once running, the host stays until quit: turned off, it tells agents so.
        if (agentStartup) startJavaAgent();
        await refreshSetup();
        broadcast({ type: 'status', status: status() });
        return undefined;
      }
      case 'javaRefresh':
        return javaAttacher().refresh();
      case 'javaAttach':
        return javaAttacher().attach(Number(command.pid), command.confirmWarning === true);
      case 'javaDetach':
        await javaAttacher().detach(Number(command.pid));
        return undefined;
      case 'setDockerSetup': {
        docker.setActive(command.enabled === true);
        settings = { ...settings, dockerSetup: command.enabled === true ? undefined : false };
        await saveSettings(dataDir, settings);
        // New terminals get DOCKER_HOST only while it's on.
        await refreshSetup();
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
                code === 'EADDRINUSE'
                  ? `Port ${port} is already in use.`
                  : // Windows: another user's program has it, or the system reserved it (Hyper-V, WSL).
                    code === 'EACCES'
                    ? `Port ${port} is already in use, or reserved by the system.`
                    : (error as Error).message,
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
      case 'matchExchanges': {
        if (typeof command.query !== 'string') throw new Error('query must be text');
        const ids = command.ids;
        if (ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')))
          throw new Error('ids must be a list of ids');
        // The UI sends at most a few thousand, and asks about all of them by leaving ids out.
        if (ids && ids.length > 10_000) throw new Error('Too many ids');
        const { searchId } = command;
        if (searchId !== undefined) checkSearchId(searchId);
        const search = new AbortController();
        const onClose = (): void => search.abort(new SearchStopped('closed'));
        context.signal.addEventListener('abort', onClose, { once: true });
        const names = namesOf(context);
        if (searchId !== undefined) {
          // The same name again replaces the earlier search.
          names.get(searchId)?.abort(new SearchStopped('canceled'));
          names.delete(searchId);
          names.set(searchId, search);
          if (names.size > MAX_NAMED_SEARCHES) {
            const [oldest, controller] = names.entries().next().value!;
            controller.abort(new SearchStopped('canceled'));
            names.delete(oldest);
          }
        }
        // Progress only for a whole search with body terms, which can take a while, to the
        // window that asked.
        const progress =
          searchId !== undefined && ids === undefined && compileQuery(command.query).needsBody
            ? (done: number, total: number): void =>
                context.notify({ type: 'matchProgress', searchId, done, total })
            : undefined;
        const partial = new Set<string>();
        const running = matchExchanges(store, command.query, ids, {
          signal: search.signal,
          bodies: bodyAccess,
          memo: bodyMemo,
          nudge,
          partial,
          ...(progress ? { onProgress: progress } : {}),
        });
        searches.set(
          search,
          running.catch(() => undefined),
        );
        try {
          const matched = await running;
          return partial.size > 0 ? { ids: matched, partial: [...partial] } : { ids: matched };
        } catch (error) {
          if (!(error instanceof SearchStopped)) throw error;
          // Only the window that replaced it sees this, and doesn't show it.
          if (error.reason === 'canceled') throw new Error('Canceled', { cause: error });
          // Cleared, closed or stopping: nothing to answer about.
          return { ids: [] };
        } finally {
          searches.delete(search);
          context.signal.removeEventListener('abort', onClose);
          if (searchId !== undefined && names.get(searchId) === search) names.delete(searchId);
        }
      }
      case 'cancelMatch': {
        checkSearchId(command.searchId);
        const names = namesOf(context);
        names.get(command.searchId)?.abort(new SearchStopped('canceled'));
        names.delete(command.searchId);
        return undefined;
      }
      case 'getExchange': {
        const exchange: ExchangeDetail | undefined = store.get(command.exchangeId);
        if (!exchange) throw new Error('Exchange not found');
        return exchange;
      }
      case 'getBody': {
        const exchange = store.get(command.exchangeId);
        if (!exchange) throw new Error('Exchange not found');
        const content: BodyContent | null = await readBody(exchange, command.side);
        if (command.mask !== true || !content) return content;
        return maskedBody(exchange, command.side, content);
      }
      case 'getBodyRange': {
        if (command.side !== 'request' && command.side !== 'response') {
          throw new Error('side must be request or response');
        }
        const exchange = store.get(command.exchangeId);
        if (!exchange) throw new Error('Exchange not found');
        const range = await bodies.readRange(
          command.exchangeId,
          command.side,
          command.offset,
          command.maxBytes,
        );
        if (!range) return null;
        const { bytes, ...rest } = range;
        const content: BodyRangeContent = {
          ...rest,
          // Bodies imported from HAR files are stored decoded.
          decoded: exchange.importedFrom !== undefined,
          base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('base64'),
        };
        return content;
      }
      case 'plugin': {
        return pluginHost.call(command.plugin, command.name, command.args);
      }
      case 'getSseEvents': {
        const exchange = store.get(command.exchangeId);
        if (!exchange) throw new Error('Exchange not found');
        if (!Number.isSafeInteger(command.after) || command.after < 0) {
          throw new Error('after must be a whole number, 0 or more');
        }
        const view = await sse.read(command.exchangeId, command.after);
        if (command.mask !== true || !view) return view;
        // Read from the start: the stream's learned values start afresh too.
        return maskedEvents(exchange, view, command.after === 0);
      }
      case 'getWebSocketMessages': {
        const exchange = store.get(command.exchangeId);
        if (!exchange) throw new Error('Exchange not found');
        const result: WebSocketMessages = websockets.get(command.exchangeId, command.after);
        if (command.mask !== true) return result;
        return maskedMessages(exchange, result, command.after === undefined || command.after < 0);
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
        // Still compressed: it can't be checked for secrets, so it isn't formatted to be shown.
        if (command.mask === true && content.decodeError) {
          return result({ ok: false, reason: 'it couldn’t be decoded, so it can’t be checked for secrets' });
        }
        const text = Buffer.from(content.base64, 'base64').toString('utf8');
        let formatted: string;
        try {
          formatted = await formatter.format(type, text);
        } catch (error) {
          const reason = (error as Error).message;
          // A formatter's message could quote the body.
          return result({ ok: false, reason: command.mask === true ? sweepText(reason) : reason });
        }
        if (command.mask !== true)
          return result({ ok: true, language: type satisfies FormatLanguage, text: formatted });
        const answer = await maskJob(exchange, side, content, formatted);
        if ('failed' in answer) return result({ ok: false, reason: answer.failed });
        if (typeof answer.formatted !== 'string') {
          return result({ ok: false, reason: 'some secrets in it couldn’t be found again once formatted' });
        }
        return result({ ok: true, language: type satisfies FormatLanguage, text: answer.formatted });
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
  // Wirescry's own ports, never a call's server. Plugins start below, once all of them are open.
  ownPorts = () => [proxy.port, api.port, ...listeners.list().map((l) => l.port)];
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
    searchesRunning: () => searches.size,
    bodyMemoSize: () => bodyMemo.size,
    // Each open window has one listener of its own (for openWindows); the rest are searches'.
    searchListeners: () =>
      [...openWindows].reduce((sum, signal) => sum + getEventListeners(signal, 'abort').length - 1, 0),
    listeners,
    async stopAndroid(timeoutMs = ANDROID_STOP_TIMEOUT_MS) {
      await android?.stopAll(timeoutMs);
    },
    async stop() {
      stopping = true;
      // Searches first, and waited for, so none is reading when the body store closes below.
      stopSearches('stopped');
      // Exports stop too: they'd be writing from a closing store.
      for (const running of exportsRunning) running.abort();
      // And their temporary files are gone before the process is.
      await Promise.all(exportsFinishing);
      await Promise.all(searches.values());
      // After the searches: one finishing could have asked for a nudge.
      nudges.stop();
      // First, and quickly, side by side: put capturing devices back before their listeners go (a
      // device left pointing at a closed port has no internet), well inside the time the app gives
      // the backend to stop; any it can't reach keep their records, and are offered Restore next
      // time. And tell Java agents to stop sending to the proxy before it closes; they read it
      // within a second, so a request or two may still be refused (Java 8 agents that miss it
      // stop when the heartbeat does).
      javaAttach?.stop();
      await Promise.all([android?.stopAll(ANDROID_STOP_TIMEOUT_MS), stopJavaAgent()]);
      android?.stop();
      composer.close();
      clearRefusals();
      for (const timer of completionTimers.values()) clearTimeout(timer);
      completionTimers.clear();
      await pluginHost.stopAll();
      updates.reset();
      await Promise.all([
        api.stop(),
        proxy.stop(),
        devices.stopAll(),
        formatter.close(),
        masker.close(),
        docker.stop(),
      ]);
      await bodies.close();
    },
  };
}
