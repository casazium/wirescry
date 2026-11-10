/** Copy as curl from a captured exchange (src/renderer/src/curl-command.ts). */
import { describe, expect, it, vi } from 'vitest';
import { curlCommand, fetchCurlCommand } from '../src/renderer/src/curl-command';
import type { BodyContent, ExchangeDetail, ExchangeSummary } from '../src/shared/api';

const summary: ExchangeSummary = {
  id: 'x1',
  method: 'POST',
  protocol: 'https',
  httpVersion: '1.1',
  host: 'api.test',
  path: '/items',
  url: 'https://api.test/items',
  startedAt: 0,
  status: 201,
};
const detail = (headers: Array<[string, string]>, requestBody?: { size: number }): ExchangeDetail => ({
  summary,
  requestHeaders: headers,
  responseHeaders: [],
  timing: { startTimestamp: 0 },
  ...(requestBody ? { requestBody: { ...requestBody, stored: requestBody.size } } : {}),
});
const body = (text: string, extra: Partial<BodyContent> = {}): BodyContent => ({
  base64: Buffer.from(text).toString('base64'),
  size: text.length,
  truncated: false,
  ...extra,
});

describe('curlCommand', () => {
  it('sends a body the window decoded without its Content-Encoding header', () => {
    const command = curlCommand(
      summary,
      detail([
        ['Content-Type', 'application/json'],
        ['Content-Encoding', 'gzip'],
      ]),
      body('{"a":1}', { decodedSize: 7, encoding: 'gzip' }),
    );
    expect(command).toContain(`--data-raw '{"a":1}'`);
    expect(command).toContain(`-H 'Content-Type: application/json'`);
    expect(command.toLowerCase()).not.toContain('content-encoding');
  });

  it('keeps Content-Encoding when the body wasn’t decoded, so it matches what’s sent', () => {
    const command = curlCommand(summary, detail([['content-encoding', 'x-made-up']]), body('raw bytes'));
    expect(command).toContain(`-H 'content-encoding: x-made-up'`);
    expect(command).toContain(`--data-raw 'raw bytes'`);
  });

  it('keeps Content-Encoding when there’s no body to send', () => {
    const command = curlCommand(summary, detail([['Content-Encoding', 'gzip']]), null);
    expect(command).toContain(`-H 'Content-Encoding: gzip'`);
    expect(command).not.toContain('--data');
  });
});

describe('fetchCurlCommand', () => {
  it('asks for the request body only when there is one', async () => {
    const withBody = vi.fn(async (command: { command: string }) =>
      command.command === 'getExchange' ? detail([], { size: 7 }) : body('{"a":1}'),
    );
    expect(await fetchCurlCommand(summary, withBody as never)).toContain(`--data-raw '{"a":1}'`);
    expect(withBody.mock.calls.map(([c]) => c)).toEqual([
      { command: 'getExchange', exchangeId: 'x1' },
      { command: 'getBody', exchangeId: 'x1', side: 'request' },
    ]);

    for (const requestBody of [undefined, { size: 0 }]) {
      const without = vi.fn(async () => detail([], requestBody));
      expect(await fetchCurlCommand(summary, without as never)).not.toContain('--data');
      expect(without).toHaveBeenCalledTimes(1);
    }
  });
});
