import net from 'node:net';
import * as mockttp from 'mockttp';
import type { BodyInfo, BodySide, ExchangeDetail, ExchangeTiming } from '../shared/api';
import type { BodyStore } from './body-store';
import type { CertificateAuthority } from './ca';
import { SETUP_HOST, setupPageHtml } from './setup-page';
import type { RequestStore } from './store';

/** Bodies larger than this aren't captured (traffic still flows). Keeps memory bounded. */
export const MAX_CAPTURED_BODY = 100 * 1024 * 1024;

export interface ProxyOptions {
  ca: CertificateAuthority;
  store: RequestStore;
  bodies: BodyStore;
  /** Called whenever an exchange is added or updated. */
  onExchange: (exchange: ExchangeDetail) => void;
  /** While this returns true, new exchanges pass through but aren't recorded. */
  isPaused?: () => boolean;
  /** Fixed port. Picks a free one if omitted. */
  port?: number;
  /** Extra CAs to trust for upstream servers (PEM). */
  upstreamCAs?: string[];
  maxBodySize?: number;
  /** Called when a browser proves over HTTPS that it trusts the CA, with its User-Agent. */
  onCATrusted?: (userAgent: string) => void;
}

export interface RunningProxy {
  port: number;
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

/** Mockttp empties bodies over maxBodySize. Spot that from the declared length. */
function bodyInfo(buffer: Buffer, headers: mockttp.Headers): BodyInfo {
  const declared = Number(headers['content-length']);
  if (buffer.length === 0 && declared > 0) return { size: declared, dropped: true };
  return { size: buffer.length };
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

function mediaType(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(';')[0]?.trim().toLowerCase() || undefined;
}

export async function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const { ca, store, bodies, onExchange } = options;
  const server = mockttp.getLocal({
    https: { key: ca.key, cert: ca.cert },
    http2: true,
    recordTraffic: false,
    maxBodySize: options.maxBodySize ?? MAX_CAPTURED_BODY,
  });

  const save = (exchange: ExchangeDetail): void => {
    store.upsert(exchange);
    onExchange(exchange);
  };

  const update = (id: string, change: (existing: ExchangeDetail) => ExchangeDetail): void => {
    const existing = store.get(id);
    if (existing) save(change(existing));
  };

  const storeBody = (id: string, side: BodySide, buffer: Buffer): void => {
    // Skip empty bodies, and bodies of exchanges that weren't recorded (e.g. while paused).
    if (buffer.length === 0 || !store.get(id)) return;
    bodies.put(id, side, buffer).catch((error: unknown) => {
      console.error(`[leverframe] could not store ${side} body for ${id}:`, error);
    });
  };

  await server.on('request-initiated', (req) => {
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
      },
      requestHeaders: req.rawHeaders,
      timing: timingOf(req.timingEvents),
    });
  });

  await server.on('request', (req) => {
    storeBody(req.id, 'request', req.body.buffer);
    update(req.id, (existing) => ({
      ...existing,
      requestHeaders: req.rawHeaders,
      timing: timingOf(req.timingEvents),
      requestBody: bodyInfo(req.body.buffer, req.headers),
    }));
  });

  await server.on('response', (res) => {
    storeBody(res.id, 'response', res.body.buffer);
    const { startTimestamp, responseSentTimestamp } = res.timingEvents;
    update(res.id, (existing) => ({
      ...existing,
      summary: {
        ...existing.summary,
        status: res.statusCode,
        statusMessage: res.statusMessage,
        durationMs:
          responseSentTimestamp !== undefined
            ? Math.round(responseSentTimestamp - startTimestamp)
            : undefined,
        contentType: mediaType(res.headers['content-type']),
        responseSize: res.body.buffer.length || Number(res.headers['content-length']) || 0,
      },
      responseHeaders: res.rawHeaders,
      timing: timingOf(res.timingEvents),
      responseBody: bodyInfo(res.body.buffer, res.headers),
    }));
  });

  await server.on('abort', (req) => {
    update(req.id, (existing) => ({
      ...existing,
      summary: { ...existing.summary, error: req.error?.code ?? req.error?.message ?? 'aborted' },
      timing: timingOf(req.timingEvents),
    }));
  });

  // Requests to the setup host are answered by the proxy itself. Rules are marked
  // always() because otherwise Mockttp moves on to the next matching rule once a rule
  // has been used.
  await server
    .forAnyRequest()
    .forHostname(SETUP_HOST)
    .always()
    .thenCallback((req) => {
      const route = req.path.split('?')[0];
      if (route === '/certificate') {
        return { statusCode: 200, headers: { 'content-type': 'application/x-x509-ca-cert' }, body: ca.cert };
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
    });

  const passThrough = { additionalTrustedCAs: options.upstreamCAs?.map((cert) => ({ cert })) };
  await server.forAnyRequest().always().thenPassThrough(passThrough);
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
    stop: () => server.stop(),
  };
}
