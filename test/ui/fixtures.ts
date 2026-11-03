import type { ExchangeDetail, ExchangeSummary, ProxyStatus } from '../../src/shared/api';

export const summary = (id: string, overrides: Partial<ExchangeSummary> = {}): ExchangeSummary => ({
  id,
  method: 'GET',
  protocol: 'https',
  httpVersion: '2.0',
  host: 'api.test',
  path: `/${id}`,
  url: `https://api.test/${id}`,
  startedAt: 0,
  status: 200,
  contentType: 'application/json',
  durationMs: 12,
  responseSize: 10,
  ...overrides,
});

export const detail = (s: ExchangeSummary, marker: string): ExchangeDetail => ({
  summary: s,
  requestHeaders: [['x-marker', marker]],
  responseHeaders: [['content-type', 'application/json']],
  timing: { startTimestamp: 0, responseSentTimestamp: 12 },
});

export const status = (): ProxyStatus =>
  ({
    proxyPort: 8001,
    proxyPortSetting: null,
    browsers: [],
    terminals: [],
    terminalEnv: {},
    terminalScripts: {
      posix: '/data/wirescry.sh',
      fish: '/data/wirescry.fish',
      powershell: 'C:\\data\\wirescry.ps1',
      cmd: 'C:\\data\\wirescry.cmd',
    },
    plugins: [],
    platform: 'darwin',
    firefoxTrusted: false,
  }) as unknown as ProxyStatus;

/** A promise to settle later, for replies that arrive out of order. */
export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
