/**
 * The HTTP version in HAR files (src/backend/har.ts): what's read on import, what's written on
 * export, and that a version the file didn't give stays unknown rather than becoming HTTP/1.1.
 */
import { describe, expect, it } from 'vitest';
import { harEntry, parseHar } from '../src/backend/har';
import type { ExchangeDetail } from '../src/shared/api';

/** An entry with these versions on its request and response (left out when undefined). */
const entry = (request: unknown, response?: unknown): Record<string, unknown> => ({
  startedDateTime: '2026-11-09T12:00:00.000Z',
  time: 10,
  request: {
    method: 'GET',
    url: 'https://api.example.com/v1',
    headers: [],
    ...(request !== undefined ? { httpVersion: request } : {}),
  },
  response: {
    status: 200,
    statusText: 'OK',
    headers: [],
    content: { size: 0, mimeType: 'text/plain' },
    ...(response !== undefined ? { httpVersion: response } : {}),
  },
  timings: { send: 1, wait: 8, receive: 1 },
});
const har = (entries: unknown[]): string => JSON.stringify({ log: { version: '1.2', entries } });
const imported = async (request: unknown, response?: unknown): Promise<string> =>
  (await parseHar(har([entry(request, response)]), 10)).exchanges[0]!.summary.httpVersion;

describe('Importing a HAR file’s HTTP version', () => {
  it('reads each way browsers and tools write it', async () => {
    expect(await imported('HTTP/1.1')).toBe('1.1');
    expect(await imported('http/1.0')).toBe('1.0');
    expect(await imported('HTTP/2.0')).toBe('2.0');
    expect(await imported('h2')).toBe('2.0');
    expect(await imported('http/2')).toBe('2.0');
    expect(await imported('h3')).toBe('3.0');
    expect(await imported('HTTP/3')).toBe('3.0');
    expect(await imported('  HTTP/1.1  ')).toBe('1.1');
  });

  it('takes the response’s when the request’s is empty, unknown or missing', async () => {
    expect(await imported('', 'HTTP/2.0')).toBe('2.0');
    expect(await imported('unknown', 'h2')).toBe('2.0');
    expect(await imported(undefined, 'HTTP/1.1')).toBe('1.1');
  });

  it('prefers the request’s when both say', async () => {
    expect(await imported('h2', 'HTTP/1.1')).toBe('2.0');
  });

  it('leaves it unknown when neither says, rather than guessing HTTP/1.1', async () => {
    expect(await imported(undefined, undefined)).toBe('');
    expect(await imported('', '')).toBe('');
    expect(await imported('unknown', 'unknown')).toBe('');
    expect(await imported('SPDY/3', 42)).toBe('');
  });
});

describe('Exporting a HAR file’s HTTP version', () => {
  const exported = (httpVersion: string) => {
    const detail: ExchangeDetail = {
      summary: {
        id: 'a',
        method: 'GET',
        protocol: 'https',
        httpVersion,
        host: 'example.com',
        path: '/',
        url: 'https://example.com/',
        startedAt: 0,
        status: 200,
      },
      requestHeaders: [],
      responseHeaders: [],
      timing: { startTimestamp: 0 },
    };
    const written = harEntry({ detail, requestBody: null, responseBody: null }) as {
      request: { httpVersion: string };
      response: { httpVersion: string };
    };
    return [written.request.httpVersion, written.response.httpVersion];
  };

  it('writes known versions as before', () => {
    expect(exported('1.1')).toEqual(['HTTP/1.1', 'HTTP/1.1']);
    expect(exported('1.0')).toEqual(['HTTP/1.0', 'HTTP/1.0']);
    expect(exported('2.0')).toEqual(['HTTP/2.0', 'HTTP/2.0']);
  });

  it('writes an unknown one as "", as browsers do, never "HTTP/"', () => {
    expect(exported('')).toEqual(['', '']);
  });

  it('keeps an unknown version unknown through an export and import', async () => {
    const [first] = (await parseHar(har([entry('')]), 10)).exchanges;
    const detail: ExchangeDetail = {
      summary: { ...first!.summary, id: 'x' },
      requestHeaders: [],
      responseHeaders: [],
      timing: { startTimestamp: 0 },
    };
    const written = harEntry({ detail, requestBody: null, responseBody: null });
    const [again] = (await parseHar(har([written]), 10)).exchanges;
    expect(again!.summary.httpVersion).toBe('');
  });
});
