import * as mockttp from 'mockttp';
import type { ExchangeSummary } from '../shared/api';
import type { CertificateAuthority } from './ca';
import type { RequestStore } from './store';

export interface ProxyOptions {
  ca: CertificateAuthority;
  store: RequestStore;
  /** Called whenever an exchange is added or updated. */
  onExchange: (exchange: ExchangeSummary) => void;
  /** Fixed port. Picks a free one if omitted. */
  port?: number;
  /** Extra CAs to trust for upstream servers (PEM). */
  upstreamCAs?: string[];
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

export async function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const { ca, store, onExchange } = options;
  const server = mockttp.getLocal({
    https: { key: ca.key, cert: ca.cert },
    http2: true,
    recordTraffic: false,
  });

  const save = (exchange: ExchangeSummary): void => {
    store.upsert(exchange);
    onExchange(exchange);
  };

  await server.on('request-initiated', (req) => {
    save({
      id: req.id,
      method: req.method,
      protocol: req.protocol,
      httpVersion: req.httpVersion,
      host: hostOf(req),
      path: req.path,
      url: req.url,
      startedAt: req.timingEvents.startTime,
    });
  });

  await server.on('response', (res) => {
    const existing = store.get(res.id);
    if (!existing) return;
    const { startTimestamp, responseSentTimestamp } = res.timingEvents;
    save({
      ...existing,
      status: res.statusCode,
      statusMessage: res.statusMessage,
      durationMs:
        responseSentTimestamp !== undefined ? Math.round(responseSentTimestamp - startTimestamp) : undefined,
    });
  });

  await server.on('abort', (req) => {
    const existing = store.get(req.id);
    if (!existing) return;
    save({ ...existing, error: req.error?.code ?? req.error?.message ?? 'aborted' });
  });

  await server.forAnyRequest().thenPassThrough({
    additionalTrustedCAs: options.upstreamCAs?.map((cert) => ({ cert })),
  });
  await server.forAnyWebSocket().thenPassThrough({
    additionalTrustedCAs: options.upstreamCAs?.map((cert) => ({ cert })),
  });

  await server.start(options.port);

  return {
    port: server.port,
    stop: () => server.stop(),
  };
}
