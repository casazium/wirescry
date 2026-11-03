import net from 'node:net';
import * as mockttp from 'mockttp';
import type { BodySide, ExchangeDetail, ExchangeTiming, HandledBy } from '../shared/api';
import {
  describeFailure,
  describePartialFailure,
  describeRuleEnded,
  upstreamErrorCode,
} from '../shared/failure';
import type { BodyStore, BodyWriter } from './body-store';
import type { CertificateAuthority } from './ca';
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
  /** Fixed port. Picks a free one if omitted. */
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
}

export interface RunningProxy {
  port: number;
  /** Re-reads `extraRules`, e.g. after a plugin changes its rules. */
  refreshRules(): Promise<void>;
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

/**
 * Mockttp listens on every network interface and has no option to change that. Drop
 * connections from other machines, so the proxy isn't open to the local network.
 */
function restrictToLoopback(server: mockttp.Mockttp): void {
  const listener = (server as unknown as { server?: net.Server }).server;
  if (!listener) throw new Error("Can't restrict the proxy to this machine");
  listener.prependListener('connection', (socket: net.Socket) => {
    if (!isLoopback(socket.remoteAddress)) socket.destroy();
  });
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
    update(res.id, (existing) => ({
      ...existing,
      summary: {
        ...existing.summary,
        failure: !code
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
          body: setupPageHtml(),
        };
      }),
    ],
    completionChecker: new mockttp.completionCheckers.Always(),
  };

  const passThrough = { additionalTrustedCAs: options.upstreamCAs?.map((cert) => ({ cert })) };
  const passThroughRule: mockttp.RequestRuleData = {
    matchers: [new mockttp.matchers.WildcardMatcher()],
    steps: [new mockttp.requestSteps.PassThroughStep(passThrough)],
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
  const applyRules = async (): Promise<void> => {
    await server.setRequestRules(setupRule, ...(options.extraRules?.() ?? []).map(always), passThroughRule);
  };
  await applyRules();
  await server.forAnyWebSocket().always().thenPassThrough(passThrough);

  if (options.port !== undefined) await assertLoopbackPortFree(options.port);
  await server.start(options.port);
  try {
    restrictToLoopback(server);
  } catch (error) {
    await server.stop();
    throw error;
  }

  return {
    port: server.port,
    refreshRules: applyRules,
    stop: () => server.stop(),
  };
}
