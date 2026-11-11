/**
 * Telling gRPC calls apart and reading their status (src/shared/grpc.ts), and what the list's
 * type, Errors filter, gRPC filter and search make of them.
 */
import { describe, expect, it } from 'vitest';
import type { ExchangeSummary } from '../src/shared/api';
import { exchangeType } from '../src/shared/exchange-type';
import { isError, matchesFilter, QUICK_FILTERS } from '../src/shared/filter';
import {
  decodeGrpcMessage,
  grpcResultOf,
  grpcStatusName,
  isGrpcContentType,
  grpcStatusLabel,
  GRPC_STATUS_NAMES,
  isGrpcError,
  MAX_GRPC_MESSAGE,
} from '../src/shared/grpc';

const call = (overrides: Partial<ExchangeSummary> = {}): ExchangeSummary => ({
  id: 'g',
  method: 'POST',
  protocol: 'https',
  httpVersion: '2.0',
  host: 'api.test',
  path: '/shop.v1.Orders/Get',
  url: 'https://api.test/shop.v1.Orders/Get',
  startedAt: 0,
  status: 200,
  contentType: 'application/grpc',
  grpc: true,
  ...overrides,
});

describe('gRPC status names', () => {
  it('names the standard codes', () => {
    expect(grpcStatusName(0)).toBe('OK');
    expect(grpcStatusName(5)).toBe('NOT_FOUND');
    expect(grpcStatusName(16)).toBe('UNAUTHENTICATED');
  });

  it('has a short label for each standard code, for the list', () => {
    expect(grpcStatusLabel(5)).toBe('Not found');
    expect(grpcStatusLabel(1)).toBe('Canceled');
    for (let code = 0; code < GRPC_STATUS_NAMES.length; code++) {
      // Measured: nine characters of these fit the 64 px column.
      expect(grpcStatusLabel(code).length, GRPC_STATUS_NAMES[code]).toBeLessThanOrEqual(9);
    }
    expect(grpcStatusLabel(42)).toBe('gRPC 42');
  });

  it('gives any other code by its number', () => {
    expect(grpcStatusName(17)).toBe('code 17');
    expect(grpcStatusName(200)).toBe('code 200');
  });
});

describe('gRPC content types', () => {
  it.each([
    'application/grpc',
    'application/grpc+proto',
    'application/grpc+json',
    'application/grpc-web',
    'application/grpc-web+proto',
    'application/grpc-web-text',
    'application/grpc-web-text+proto',
    'APPLICATION/GRPC',
  ])('knows %s', (type) => {
    expect(isGrpcContentType(type)).toBe(true);
  });

  it.each([
    'application/json',
    'application/grpcx',
    'application/grpc-webx',
    'application/grpc-websocket',
    'text/grpc',
    'application/proto',
    '',
  ])("doesn't take %s for gRPC", (type) => {
    expect(isGrpcContentType(type)).toBe(false);
  });

  it("doesn't take a missing type for gRPC", () => {
    expect(isGrpcContentType(undefined)).toBe(false);
  });
});

describe('gRPC messages', () => {
  it('decodes percent-encoding, including UTF-8', () => {
    expect(decodeGrpcMessage('order%2042%20not%20found')).toBe('order 42 not found');
    expect(decodeGrpcMessage('done %E2%9C%93')).toBe('done ✓');
  });

  it('leaves plain text alone', () => {
    expect(decodeGrpcMessage('already plain')).toBe('already plain');
  });

  it("never fails on bad encoding: what doesn't decode stays as written", () => {
    expect(decodeGrpcMessage('100%')).toBe('100%');
    expect(decodeGrpcMessage('bad %zz here')).toBe('bad %zz here');
    // A cut-off UTF-8 sequence, next to a good escape.
    expect(decodeGrpcMessage('half %E2%9C then%20space')).toBe('half %E2%9C then space');
  });
});

describe('a gRPC result', () => {
  it('comes from the trailers', () => {
    expect(
      grpcResultOf(
        [['content-type', 'application/grpc']],
        [
          ['grpc-status', '5'],
          ['grpc-message', 'not%20found'],
        ],
      ),
    ).toEqual({ status: 5, message: 'not found' });
  });

  it('comes from the headers when there are no trailers (an error with nothing else)', () => {
    expect(grpcResultOf([['Grpc-Status', '16']], undefined)).toEqual({ status: 16 });
  });

  it('prefers the trailers when both have one', () => {
    expect(grpcResultOf([['grpc-status', '0']], [['grpc-status', '13']])?.status).toBe(13);
  });

  it("isn't there without a valid grpc-status", () => {
    expect(grpcResultOf([['content-type', 'application/grpc']], [])).toBeUndefined();
    expect(grpcResultOf([['grpc-status', 'five']], undefined)).toBeUndefined();
    expect(grpcResultOf([['grpc-status', '-1']], undefined)).toBeUndefined();
    expect(grpcResultOf([['grpc-status', '1234']], undefined)).toBeUndefined();
    expect(grpcResultOf(undefined, undefined)).toBeUndefined();
  });

  it('cuts a very long message', () => {
    const result = grpcResultOf(undefined, [
      ['grpc-status', '2'],
      ['grpc-message', 'x'.repeat(MAX_GRPC_MESSAGE + 50)],
    ]);
    expect(result?.message).toHaveLength(MAX_GRPC_MESSAGE);
  });

  it('counts as an error unless OK or CANCELLED (the client gave up)', () => {
    expect(isGrpcError(5)).toBe(true);
    expect(isGrpcError(13)).toBe(true);
    expect(isGrpcError(0)).toBe(false);
    expect(isGrpcError(1)).toBe(false);
    expect(isGrpcError(undefined)).toBe(false);
  });
});

describe('gRPC calls in the list', () => {
  it('have their own type, even with a JSON or plain-text response type', () => {
    expect(exchangeType(call())).toBe('grpc');
    expect(exchangeType(call({ grpc: undefined, contentType: 'application/grpc+json' }))).toBe('grpc');
    expect(exchangeType(call({ contentType: 'text/plain' }))).toBe('grpc');
    expect(exchangeType(call({ grpc: undefined, contentType: 'application/json' }))).toBe('json');
  });

  it('count as errors when the gRPC status is one, though HTTP said 200', () => {
    expect(isError(call({ grpcStatus: 5 }))).toBe(true);
    expect(isError(call({ grpcStatus: 0 }))).toBe(false);
    expect(isError(call({ grpcStatus: 1 }))).toBe(false);
    expect(isError(call())).toBe(false);
  });

  it('have a gRPC quick filter, which takes only gRPC calls', () => {
    expect(QUICK_FILTERS.some((f) => f.id === 'grpc' && f.label === 'gRPC')).toBe(true);
    expect(matchesFilter(call(), '', 'grpc')).toBe(true);
    expect(matchesFilter(call({ grpc: undefined, contentType: 'application/json' }), '', 'grpc')).toBe(false);
    // Not "other" any more.
    expect(matchesFilter(call(), '', 'other')).toBe(false);
  });

  it('can be searched by status name or number', () => {
    const notFound = call({ grpcStatus: 5, grpcMessage: 'order 42 not found' });
    expect(matchesFilter(notFound, 'grpc=NOT_FOUND', 'all')).toBe(true);
    expect(matchesFilter(notFound, 'grpc=not_*', 'all')).toBe(true);
    expect(matchesFilter(notFound, 'grpc=5', 'all')).toBe(true);
    expect(matchesFilter(notFound, 'grpc=OK', 'all')).toBe(false);
    expect(matchesFilter(notFound, '-grpc=NOT_FOUND', 'all')).toBe(false);
    expect(matchesFilter(notFound, 'grpc!=OK', 'all')).toBe(true);
    expect(matchesFilter(call({ grpcStatus: 0 }), 'grpc!=OK', 'all')).toBe(false);
    expect(matchesFilter(notFound, 'grpc~found', 'all')).toBe(true);
    expect(matchesFilter(notFound, 'grpc~denied', 'all')).toBe(false);
    expect(matchesFilter(call({ grpcStatus: 0 }), 'grpc=NOT_FOUND', 'all')).toBe(false);
    // A call without a status yet, and a request that isn't gRPC, match no status.
    expect(matchesFilter(call(), 'grpc=OK', 'all')).toBe(false);
    expect(matchesFilter(call({ grpc: undefined }), 'grpc~O', 'all')).toBe(false);
  });

  it('match plain words in the status name and message', () => {
    const notFound = call({ grpcStatus: 5, grpcMessage: 'order 42 not found' });
    expect(matchesFilter(notFound, 'not_found', 'all')).toBe(true);
    expect(matchesFilter(notFound, '"order 42"', 'all')).toBe(true);
    expect(matchesFilter(call({ grpcStatus: 0 }), '"order 42"', 'all')).toBe(false);
    // "ok" doesn't find every successful call.
    expect(matchesFilter(call({ grpcStatus: 0, host: 'api.test' }), 'ok', 'all')).toBe(false);
    expect(matchesFilter(notFound, 'type=grpc', 'all')).toBe(true);
  });
});
