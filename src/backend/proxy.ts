import * as mockttp from 'mockttp';
import type { BodyInfo, BodySide, ExchangeDetail, ExchangeTiming } from '../shared/api';
import type { BodyStore } from './body-store';
import type { CertificateAuthority } from './ca';
import type { RequestStore } from './store';

/** Bodies larger than this aren't captured (traffic still flows). Keeps memory bounded. */
export const MAX_CAPTURED_BODY = 100 * 1024 * 1024;

export interface ProxyOptions {
  ca: CertificateAuthority;
  store: RequestStore;
  bodies: BodyStore;
  /** Called whenever an exchange is added or updated. */
  onExchange: (exchange: ExchangeDetail) => void;
  /** Fixed port. Picks a free one if omitted. */
  port?: number;
  /** Extra CAs to trust for upstream servers (PEM). */
  upstreamCAs?: string[];
  maxBodySize?: number;
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
    if (buffer.length === 0) return;
    bodies.put(id, side, buffer).catch((error: unknown) => {
      console.error(`[leverframe] could not store ${side} body for ${id}:`, error);
    });
  };

  await server.on('request-initiated', (req) => {
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

  const passThrough = { additionalTrustedCAs: options.upstreamCAs?.map((cert) => ({ cert })) };
  await server.forAnyRequest().thenPassThrough(passThrough);
  await server.forAnyWebSocket().thenPassThrough(passThrough);

  await server.start(options.port);

  return {
    port: server.port,
    stop: () => server.stop(),
  };
}
