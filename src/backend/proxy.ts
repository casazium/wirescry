import net from 'node:net';
import * as mockttp from 'mockttp';
import type { BodySide, ExchangeDetail, ExchangeSource, ExchangeTiming, HandledBy } from '../shared/api';
import {
  describeBlocked,
  describeFailure,
  describePartialFailure,
  describeRuleEnded,
  upstreamErrorCode,
} from '../shared/failure';
import type { BodyStore, BodyWriter } from './body-store';
import type { CertificateAuthority } from './ca';
import { HOST_NAME as DOCKER_HOST_NAME } from './docker/container';
import { GUARD_HEADER, startEgressGuard, type EgressGuard, type EgressGuardOptions } from './egress-guard';
import { SETUP_HOST, setupPageHtml } from './setup-page';
import type { RequestStore } from './store';
import type { WebSocketStore } from './websocket-store';

/**
 * How much of each body Mockttp itself buffers. Bodies are captured by streaming
 * their chunks into the BodyStore instead, so this only needs to cover small
 * things like the 502 bodies Mockttp writes for upstream errors.
 */
export const MOCKTTP_BUFFER_LIMIT = 64 * 1024;

export interface ProxyOptions {
  ca: CertificateAuthority;
  store: RequestStore;
  bodies: BodyStore;
  websockets: WebSocketStore;
  /** Called whenever an exchange is added or updated. */
  onExchange: (exchange: ExchangeDetail) => void;
  /** While this returns true, new exchanges pass through but aren't recorded. */
  isPaused?: () => boolean;
  /** Whether a new request came from Wirescry's composer: it's then recorded even while paused. */
  isComposed?: (
    remotePort: number | undefined,
    remoteAddress: string | undefined,
    exchangeId: string,
  ) => boolean;
  /**
   * Fixed port. Omitted, Mockttp picks the lowest free one from 8000; 0, the system picks any
   * free one (for ports nobody types in, like device listeners').
   */
  port?: number;
  /** Extra CAs to trust for upstream servers (PEM). */
  upstreamCAs?: string[];
  /** Extra rules (from plugins) that run before normal pass-through, in order. */
  extraRules?: () => mockttp.RequestRuleData[];
  /** Which plugin rule a Mockttp rule id belongs to, for the traffic list. */
  describeRule?: (ruleId: string | undefined) => HandledBy | undefined;
  /** Whether that rule closes the connection or never answers. */
  ruleEndsWithoutResponse?: (ruleId: string | undefined) => boolean;
  /** Called when a browser proves over HTTPS that it trusts the CA, with its User-Agent. */
  onCATrusted?: (userAgent: string) => void;
  /**
   * Whether to accept a connection from this non-loopback address: a Docker container on
   * Linux, whose connections come from Docker's bridge networks. The connection waits for the
   * answer, which may take a lookup. Anything else (or a throw) drops it.
   */
  acceptConnection?: (address: string) => boolean | Promise<boolean>;
  /** The device this listener serves, if not this computer: written onto every exchange. */
  source?: ExchangeSource;
  /**
   * Whether requests for host.docker.internal go to this computer (false: they go where DNS
   * says, like any other host). Only the main listener does this, for Docker containers.
   */
  dockerHostToLocalhost?: boolean;
  /**
   * Keeps this listener's traffic from this computer and its local networks (unless
   * `allowLocal` says otherwise): every pass-through, plugin rules' included, goes upstream
   * through an egress guard that checks each address after DNS. For device listeners.
   */
  egress?: EgressGuardOptions;
}

export interface RunningProxy {
  port: number;
  /** Re-reads `extraRules`, e.g. after a plugin changes its rules. */
  refreshRules(): Promise<void>;
  /** With `egress`: closes open connections to destinations that are refused now. */
  recheckDestinations?(): void;
  stop(): Promise<void>;
}

function hostOf(req: mockttp.InitiatedRequest): string {
  try {
    return new URL(req.url).host;
  } catch {
    return req.headers.host ?? `${req.destination.hostname}:${req.destination.port}`;
  }
}

function timingOf(events: mockttp.TimingEvents): ExchangeTiming {
  return {
    startTimestamp: events.startTimestamp,
    bodyReceivedTimestamp: events.bodyReceivedTimestamp,
    headersSentTimestamp: events.headersSentTimestamp,
    responseSentTimestamp: events.responseSentTimestamp,
    abortedTimestamp: events.abortedTimestamp,
  };
}

/** The message from the body of a 502 that Mockttp generated, e.g. "Error: connect ECONNREFUSED ...". */
function errorBodyMessage(body: Buffer): string | undefined {
  const text = body.subarray(0, 1000).toString('utf8').trim();
  return text ? text.replace(/^Error:\s*/, '') : undefined;
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return v4.startsWith('127.') || address === '::1';
}

/** How long a connection from another address may wait to be accepted. */
const ACCEPT_TIMEOUT_MS = 5000;

/**
 * Mockttp listens on every network interface and has no option to change that. Drop
 * connections from other machines, so the proxy isn't open to the local network. Others are
 * offered to `accept` first, and handed to Mockttp only once it says yes: wrapping the server's
 * 'connection' event, so no listener of Mockttp's sees a connection that wasn't accepted, and
 * nothing is read from it until then.
 */
function restrictToLoopback(
  server: mockttp.Mockttp,
  accept?: (address: string) => boolean | Promise<boolean>,
): { stop(): void } {
  const listener = (server as unknown as { server?: net.Server }).server;
  if (!listener) throw new Error("Can't restrict the proxy to this machine");
  const emit = listener.emit.bind(listener) as (event: string | symbol, ...args: unknown[]) => boolean;
  listener.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
    if (event !== 'connection') return emit(event, ...args);
    const socket = args[0] as net.Socket;
    const address = socket.remoteAddress;
    if (isLoopback(address)) return emit(event, ...args);
    let answer: boolean | Promise<boolean>;
    try {
      answer = !!address && !!accept && accept(address);
    } catch {
      answer = false;
    }
    if (answer === true) return emit(event, ...args);
    if (answer === false) {
      socket.destroy();
      return true;
    }
    // Nothing else listens to it yet: an error now (a reset while waiting) would otherwise be
    // thrown, and take the backend down.
    const onError = (): void => {
      socket.destroy();
    };
    socket.on('error', onError);
    pending.add(socket);
    const timer = setTimeout(() => socket.destroy(), ACCEPT_TIMEOUT_MS);
    socket.once('close', () => {
      clearTimeout(timer);
      pending.delete(socket);
    });
    answer.then(
      (ok) => {
        clearTimeout(timer);
        pending.delete(socket);
        if (ok && !socket.destroyed && !stopped) {
          socket.off('error', onError);
          emit(event, ...args);
        } else socket.destroy();
      },
      () => socket.destroy(),
    );
    return true;
  }) as typeof listener.emit;
  const pending = new Set<net.Socket>();
  let stopped = false;
  return {
    /** Drops connections still waiting to be accepted, so none reaches a stopped proxy. */
    stop: () => {
      stopped = true;
      for (const socket of pending) socket.destroy();
      pending.clear();
    },
  };
}

/**
 * Mockttp listens on all addresses (::), which some systems allow even when another
 * program already has 127.0.0.1 on that port. Local traffic would then go to that
 * program, so check 127.0.0.1 is free first.
 */
async function assertLoopbackPortFree(port: number): Promise<void> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve());
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
}

interface ResponseHead {
  statusCode?: number;
  statusMessage?: string;
  rawHeaders: mockttp.RawHeaders;
}

/** What Mockttp's passthrough rule events carry, as far as the proxy uses it. */
interface PassthroughEventData {
  statusCode?: number;
  statusMessage?: string;
  rawHeaders?: mockttp.RawHeaders;
  /** On 'passthrough-abort': Mockttp dropped the upstream request because the client went away. */
  downstreamAborted?: boolean;
  error?: { code?: string; message?: string };
}

function mediaType(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(';')[0]?.trim().toLowerCase() || undefined;
}

function rawHeader(headers: mockttp.RawHeaders, name: string): string | undefined {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

export async function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const guard = options.egress ? await startEgressGuard(options.egress) : undefined;
  let running: RunningProxy;
  try {
    running = await startListener(options, guard);
  } catch (error) {
    await guard?.stop();
    throw error;
  }
  return {
    port: running.port,
    refreshRules: running.refreshRules,
    ...(guard ? { recheckDestinations: () => guard.recheck() } : {}),
    stop: async () => {
      await running.stop();
      await guard?.stop();
    },
  };
}

async function startListener(options: ProxyOptions, guard: EgressGuard | undefined): Promise<RunningProxy> {
  const { ca, store, bodies, onExchange } = options;
  const server = mockttp.getLocal({
    https: { key: ca.key, cert: ca.cert },
    http2: true,
    recordTraffic: false,
    maxBodySize: MOCKTTP_BUFFER_LIMIT,
  });

  const save = (exchange: ExchangeDetail): void => {
    store.upsert(exchange);
    onExchange(exchange);
  };

  const update = (id: string, change: (existing: ExchangeDetail) => ExchangeDetail): void => {
    const existing = store.get(id);
    if (existing) save(change(existing));
  };

  // Mockttp reports an upstream error's message in a rule event, over HTTP/1.1 only.
  const upstreamErrors = new Map<string, { code?: string; message?: string }>();
  // Exchanges whose server had sent response headers (rule event), with those headers.
  const answered = new Map<string, ResponseHead>();
  // Responses that broke part way through, or whose client went away. Mockttp then
  // writes its error text after the real bytes; the value is that text, when known,
  // so it can be removed.
  const brokenMidBody = new Map<string, string | undefined>();
  // Response heads as sent to the client, for every rule (pass-through or not). Only used
  // to describe a response the client cut off: Mockttp's own 502 is sent this way too.
  const sentHeads = new Map<string, ResponseHead>();

  await server.on('response-initiated', (res) => {
    if (!store.get(res.id)) return;
    // Mockttp writes its own error reply to a connection that has already gone: not what
    // the client got, and the abort handler has finished with this exchange.
    if (res.timingEvents.abortedTimestamp !== undefined) return;
    sentHeads.set(res.id, {
      statusCode: res.statusCode,
      statusMessage: res.statusMessage,
      rawHeaders: res.rawHeaders,
    });
  });

  await server.on('rule-event', (event: mockttp.RuleEvent<PassthroughEventData>) => {
    const id = event.requestId;
    if (!store.get(id)) return;
    const data = event.eventData;
    if (event.eventType === 'passthrough-response-head') {
      answered.set(id, {
        statusCode: data.statusCode,
        statusMessage: data.statusMessage,
        rawHeaders: data.rawHeaders ?? [],
      });
    }
    if (event.eventType !== 'passthrough-abort') return;
    const error = data.error ?? {};
    const tail = error.message ? `Error: ${error.message}` : undefined;
    if (data.downstreamAborted) {
      // The client went away and Mockttp dropped the upstream request: not the server's
      // fault, and the 'abort' event records it. Only Mockttp's error text is left to remove.
      if (answered.has(id) || brokenMidBody.has(id)) brokenMidBody.set(id, tail);
      return;
    }
    upstreamErrors.set(id, error);
    if (answered.has(id)) brokenMidBody.set(id, tail);
  });

  // Bodies stream into the store chunk by chunk, so large ones never sit in memory whole.
  const writers = new Map<string, BodyWriter>();

  const finishBody = (id: string, side: BodySide, complete: boolean): void => {
    const key = `${id}:${side}`;
    const writer = writers.get(key);
    if (!writer) return;
    writers.delete(key);
    writer.end(complete).then(
      (info) =>
        recordBody(id, side, {
          size: info.size,
          stored: info.stored,
          incomplete: info.incomplete || undefined,
        }),
      (error: unknown) => console.error(`[wirescry] could not store ${side} body for ${id}:`, error),
    );
  };

  const recordBody = (id: string, side: BodySide, info: ExchangeDetail['requestBody']): void => {
    if (info && side === 'response' && brokenMidBody.has(id)) info = { ...info, incomplete: true };
    update(id, (existing) =>
      side === 'request'
        ? { ...existing, requestBody: info }
        : { ...existing, responseBody: info, summary: { ...existing.summary, responseSize: info?.size } },
    );
  };

  const onBodyData = (side: BodySide, data: mockttp.BodyData): void => {
    // Skip exchanges that weren't recorded, e.g. while paused.
    if (!store.get(data.id)) return;
    const key = `${data.id}:${side}`;
    let writer = writers.get(key);
    let content = data.content;
    if (side === 'response' && brokenMidBody.has(data.id)) {
      // The server broke off. Keep what it sent, minus Mockttp's error text, and ignore the rest.
      if (!writer) return;
      const appended = brokenMidBody.get(data.id);
      const tail = appended ? Buffer.from(appended) : undefined;
      if (
        tail &&
        Buffer.from(content.buffer, content.byteOffset, content.length).subarray(-tail.length).equals(tail)
      ) {
        content = content.subarray(0, content.length - tail.length);
      }
      writer.write(content);
      finishBody(data.id, side, false);
      return;
    }
    if (!writer) {
      if (data.isEnded && data.content.length === 0) {
        recordBody(data.id, side, { size: 0, stored: 0 });
        return;
      }
      writer = bodies.open(data.id, side);
      writers.set(key, writer);
    }
    writer.write(content);
    if (data.isEnded) finishBody(data.id, side, true);
  };

  await server.on('request-body-data', (data) => onBodyData('request', data));
  await server.on('response-body-data', (data) => onBodyData('response', data));

  await server.on('request-initiated', (req) => {
    const composed = options.isComposed?.(req.remotePort, req.remoteIpAddress, req.id) ?? false;
    if (!composed && options.isPaused?.()) return;
    save({
      summary: {
        ...(composed ? { composed: true as const } : {}),
        ...(options.source ? { source: { ...options.source } } : {}),
        id: req.id,
        method: req.method,
        protocol: req.protocol,
        httpVersion: req.httpVersion,
        host: hostOf(req),
        path: req.path,
        url: req.url,
        startedAt: req.timingEvents.startTime,
      },
      requestHeaders: req.rawHeaders,
      timing: timingOf(req.timingEvents),
    });
  });

  const handledBy = (ruleId: string | undefined): HandledBy | undefined => options.describeRule?.(ruleId);

  await server.on('request', (req) => {
    update(req.id, (existing) => ({
      ...existing,
      summary: { ...existing.summary, handledBy: handledBy(req.matchedRuleId) ?? existing.summary.handledBy },
      requestHeaders: req.rawHeaders,
      timing: timingOf(req.timingEvents),
    }));
  });

  await server.on('response', (res) => {
    const { startTimestamp, responseSentTimestamp } = res.timingEvents;
    const errorCode = upstreamErrorCode(res.tags);
    const upstream = upstreamErrors.get(res.id);
    upstreamErrors.delete(res.id);
    // Either the server never answered and Mockttp sent a 502 of its own, or the server
    // answered and then broke off. HTTP/1.1 says which through a rule event; over
    // HTTP/2 there are none, but a status other than 502 must have come from the server.
    const partial = errorCode !== undefined && (answered.has(res.id) || res.statusCode !== 502);
    answered.delete(res.id);
    sentHeads.delete(res.id);
    if (partial && !brokenMidBody.has(res.id)) {
      // HTTP/2: the body may already be recorded as complete.
      brokenMidBody.set(res.id, undefined);
      update(res.id, (existing) =>
        existing.responseBody
          ? { ...existing, responseBody: { ...existing.responseBody, incomplete: true } }
          : existing,
      );
    }
    if (brokenMidBody.has(res.id)) {
      // Late chunks for this response are still ignored for a moment, then forget it.
      setTimeout(() => brokenMidBody.delete(res.id), 5000).unref();
    }
    const code = upstream?.code ?? errorCode;
    // The egress guard's own answer, when it refused or couldn't connect.
    const verdict = guard?.verdict(rawHeader(res.rawHeaders, GUARD_HEADER));
    update(res.id, (existing) => ({
      ...existing,
      summary: {
        ...existing.summary,
        failure: verdict
          ? 'refused' in verdict
            ? describeBlocked(existing.summary.host, verdict.refused.address, verdict.refused.description)
            : describeFailure(verdict.error.code, existing.summary.host, verdict.error.message)
          : !code
            ? undefined
            : partial
              ? describePartialFailure(code, existing.summary.host, upstream?.message)
              : describeFailure(
                  code,
                  existing.summary.host,
                  // Over HTTP/2 Mockttp skips the rule event; its 502 body holds the same message.
                  upstream?.message ?? errorBodyMessage(res.body.buffer),
                ),
        status: res.statusCode,
        statusMessage: res.statusMessage,
        durationMs:
          responseSentTimestamp !== undefined
            ? Math.round(responseSentTimestamp - startTimestamp)
            : undefined,
        contentType: mediaType(res.headers['content-type']),
      },
      responseHeaders: res.rawHeaders,
      timing: timingOf(res.timingEvents),
    }));
  });

  await server.on('abort', (req) => {
    const { startTimestamp, headersSentTimestamp, abortedTimestamp } = req.timingEvents;
    const upstream = upstreamErrors.get(req.id);
    upstreamErrors.delete(req.id);
    const head = answered.get(req.id);
    answered.delete(req.id);
    const sent = sentHeads.get(req.id);
    sentHeads.delete(req.id);
    // Whether the server's response had started. Rules other than pass-through send no
    // rule events, so fall back to the timing (unless the upstream failed, when the
    // headers may be Mockttp's 502). Mockttp also sets headersSentTimestamp just after
    // an abort, when it writes its error reply to the closed connection.
    const partial =
      head !== undefined ||
      (!upstream?.code &&
        headersSentTimestamp !== undefined &&
        abortedTimestamp !== undefined &&
        headersSentTimestamp < abortedTimestamp);
    const clientLeftMidBody = partial && !upstream?.code;
    // What the client got: the server's head, or a non-pass-through rule's (a streaming mock).
    const shown = head ?? sent;
    finishBody(req.id, 'request', false);
    // When the client left mid-body, the last chunk is still to come, with Mockttp's
    // error text after it: the body-data handler stores it as incomplete, minus that text.
    // Its bytes can come after this event even if none have yet, so make sure they're kept.
    const responseKey = `${req.id}:response`;
    if (!clientLeftMidBody) finishBody(req.id, 'response', false);
    else if (!writers.has(responseKey) && store.get(req.id)) {
      writers.set(responseKey, bodies.open(req.id, 'response'));
    }
    // Either way, ignore what Mockttp writes to the closed connection from here on.
    if (!brokenMidBody.has(req.id)) brokenMidBody.set(req.id, undefined);
    setTimeout(() => {
      finishBody(req.id, 'response', false);
      brokenMidBody.delete(req.id);
      sentHeads.delete(req.id);
    }, 5000).unref();
    update(req.id, (existing) => {
      const rule = handledBy(req.matchedRuleId) ?? existing.summary.handledBy;
      return {
        ...existing,
        summary: {
          ...existing.summary,
          handledBy: rule,
          failure: !upstream?.code
            ? // A close or timeout rule ends here too; say so instead of "client closed".
              rule && options.ruleEndsWithoutResponse?.(req.matchedRuleId)
              ? describeRuleEnded(rule.label)
              : partial
                ? describePartialFailure('CLIENT_CLOSED', existing.summary.host, req.error?.message)
                : describeFailure('CLIENT_CLOSED', existing.summary.host, req.error?.message)
            : partial
              ? describePartialFailure(upstream.code, existing.summary.host, upstream.message)
              : describeFailure(upstream.code, existing.summary.host, upstream.message),
          ...(clientLeftMidBody
            ? {
                status: shown?.statusCode ?? existing.summary.status,
                statusMessage: shown?.statusMessage ?? existing.summary.statusMessage,
                contentType: shown
                  ? mediaType(rawHeader(shown.rawHeaders, 'content-type'))
                  : existing.summary.contentType,
                durationMs:
                  abortedTimestamp !== undefined ? Math.round(abortedTimestamp - startTimestamp) : undefined,
              }
            : {}),
        },
        ...(clientLeftMidBody && shown ? { responseHeaders: shown.rawHeaders } : {}),
        timing: timingOf(req.timingEvents),
      };
    });
  });

  await server.on('websocket-request', (req) => {
    if (options.isPaused?.()) return;
    save({
      summary: {
        ...(options.source ? { source: { ...options.source } } : {}),
        id: req.id,
        method: req.method,
        protocol: req.protocol,
        httpVersion: req.httpVersion,
        host: hostOf(req),
        path: req.path,
        url: req.url,
        startedAt: req.timingEvents.startTime,
        websocket: true,
      },
      requestHeaders: req.rawHeaders,
      timing: timingOf(req.timingEvents),
    });
  });

  await server.on('websocket-accepted', (res) => {
    update(res.id, (existing) => ({
      ...existing,
      summary: { ...existing.summary, status: res.statusCode, statusMessage: res.statusMessage },
      responseHeaders: res.rawHeaders,
      timing: timingOf(res.timingEvents),
    }));
  });

  const onWebSocketMessage = (message: mockttp.WebSocketMessage): void => {
    if (!store.get(message.streamId)) return; // Not recorded, e.g. while paused.
    options.websockets.add(message.streamId, {
      // Mockttp's point of view: 'received' came from the client, 'sent' went to it.
      fromClient: message.direction === 'received',
      content: message.content,
      isBinary: message.isBinary,
      time: Math.max(0, Math.round(message.eventTimestamp - message.timingEvents.startTimestamp)),
    });
    update(message.streamId, (existing) => ({
      ...existing,
      summary: { ...existing.summary, messageCount: options.websockets.count(message.streamId) },
    }));
  };
  await server.on('websocket-message-received', onWebSocketMessage);
  await server.on('websocket-message-sent', onWebSocketMessage);

  await server.on('websocket-close', (close) => {
    update(close.streamId, (existing) => {
      const { startTimestamp, wsClosedTimestamp } = close.timingEvents;
      return {
        ...existing,
        summary: {
          ...existing.summary,
          closeCode: close.closeCode,
          closeReason: close.closeReason || undefined,
          durationMs:
            wsClosedTimestamp !== undefined ? Math.round(wsClosedTimestamp - startTimestamp) : undefined,
        },
        timing: timingOf(close.timingEvents),
      };
    });
  });

  // Requests to the setup host are answered by the proxy itself.
  const setupRule: mockttp.RequestRuleData = {
    matchers: [new mockttp.matchers.HostnameMatcher(SETUP_HOST)],
    steps: [
      new mockttp.requestSteps.CallbackStep((req) => {
        const route = req.path.split('?')[0];
        if (route === '/certificate') {
          return {
            statusCode: 200,
            headers: { 'content-type': 'application/x-x509-ca-cert' },
            body: ca.cert,
          };
        }
        if (route === '/check') {
          // Only reachable over HTTPS if the browser accepted a certificate signed by our CA.
          if (req.protocol !== 'https') return { statusCode: 400 };
          options.onCATrusted?.(req.headers['user-agent'] ?? '');
          return {
            statusCode: 200,
            headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
            json: { trusted: true },
          };
        }
        return {
          statusCode: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: setupPageHtml(req.headers['user-agent'] ?? ''),
        };
      }),
    ],
    completionChecker: new mockttp.completionCheckers.Always(),
  };

  const proxyConfig = guard ? { proxyUrl: guard.url } : undefined;
  const passThrough = { additionalTrustedCAs: options.upstreamCAs?.map((cert) => ({ cert })), proxyConfig };
  const passThroughRule: mockttp.RequestRuleData = {
    matchers: [new mockttp.matchers.WildcardMatcher()],
    steps: [new mockttp.requestSteps.PassThroughStep(passThrough)],
    completionChecker: new mockttp.completionCheckers.Always(),
  };
  // Docker containers reach this computer as host.docker.internal, a name only they can
  // resolve. Their requests to it come here through the proxy, so send them to localhost.
  // The Host header stays as the container sent it.
  const toLocalhost = {
    matchReplaceHost: {
      replacements: [[new RegExp(`^${DOCKER_HOST_NAME.replace(/\./g, '\\.')}(?=:|$)`, 'i'), 'localhost']] as [
        RegExp,
        string,
      ][],
      updateHostHeader: false as const,
    },
  };
  const dockerHostRule: mockttp.RequestRuleData = {
    matchers: [new mockttp.matchers.HostnameMatcher(DOCKER_HOST_NAME)],
    steps: [new mockttp.requestSteps.PassThroughStep({ ...passThrough, transformRequest: toLocalhost })],
    completionChecker: new mockttp.completionCheckers.Always(),
  };

  // The first matching rule handles each request: the setup host, then plugin rules in
  // order, then normal pass-through. Every rule is "always", or Mockttp would move on to
  // the next matching rule once a rule has been used.
  // Only the id, matchers and steps are kept: a plugin can't set a priority that would put
  // its rule ahead of the setup page.
  const always = (rule: mockttp.RequestRuleData): mockttp.RequestRuleData => ({
    id: rule.id,
    matchers: rule.matchers,
    steps: rule.steps,
    completionChecker: new mockttp.completionCheckers.Always(),
  });
  // Plugins' pass-through steps carry no proxy settings: behind a guard, rebuild each one with
  // them. Matched by type rather than class, in case a plugin made one with its own Mockttp.
  const guarded = (rule: mockttp.RequestRuleData): mockttp.RequestRuleData =>
    proxyConfig
      ? {
          ...rule,
          steps: rule.steps.map((step) =>
            step.type === 'passthrough'
              ? Object.assign(new mockttp.requestSteps.PassThroughStep(), step, { proxyConfig })
              : step,
          ),
        }
      : rule;
  const dockerHost = options.dockerHostToLocalhost ?? true;
  const applyRules = async (): Promise<void> => {
    await server.setRequestRules(
      setupRule,
      ...(options.extraRules?.() ?? []).map(always).map(guarded),
      ...(dockerHost ? [dockerHostRule] : []),
      passThroughRule,
    );
  };
  await applyRules();
  // The more specific WebSocket rule first: Mockttp uses the first that matches.
  if (dockerHost) {
    await server
      .forAnyWebSocket()
      .forHostname(DOCKER_HOST_NAME)
      .always()
      .thenPassThrough({ ...passThrough, transformRequest: toLocalhost });
  }
  await server.forAnyWebSocket().always().thenPassThrough(passThrough);

  // 0 asks the system for any free port, as with listen(0); there's nothing to check first.
  if (options.port !== undefined && options.port !== 0) await assertLoopbackPortFree(options.port);
  await server.start(options.port);
  let restriction: { stop(): void };
  try {
    restriction = restrictToLoopback(server, options.acceptConnection);
  } catch (error) {
    await server.stop();
    throw error;
  }

  return {
    port: server.port,
    refreshRules: applyRules,
    stop: () => {
      restriction.stop();
      return server.stop();
    },
  };
}
