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
  grpcClientSideStatus,
  grpcDeadlinePassed,
  isGrpcClientCancel,
  isGrpcError,
  MAX_GRPC_MESSAGE,
  binaryHeaderHex,
  describeGrpcTimeout,
  grpcTimeoutMs,
  MAX_BINARY_HEADER_BYTES,
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

describe('a gRPC deadline', () => {
  it('reads every unit grpc-timeout allows', () => {
    expect(grpcTimeoutMs('2H')).toBe(7_200_000);
    expect(grpcTimeoutMs('3M')).toBe(180_000);
    expect(grpcTimeoutMs('5S')).toBe(5000);
    expect(grpcTimeoutMs('250m')).toBe(250);
    expect(grpcTimeoutMs('1500u')).toBe(1.5);
    expect(grpcTimeoutMs('99999999n')).toBeCloseTo(99.999999);
  });

  it("isn't there for a value grpc-timeout doesn't allow", () => {
    expect(grpcTimeoutMs('123456789S')).toBeUndefined(); // more than 8 digits
    expect(grpcTimeoutMs('5')).toBeUndefined();
    expect(grpcTimeoutMs('5h')).toBeUndefined();
    expect(grpcTimeoutMs('-5S')).toBeUndefined();
    expect(grpcTimeoutMs('S')).toBeUndefined();
    expect(grpcTimeoutMs(undefined)).toBeUndefined();
  });

  it('says it in plain words', () => {
    expect(describeGrpcTimeout('250m')).toBe('250 ms');
    expect(describeGrpcTimeout('1500m')).toBe('1.5 s');
    expect(describeGrpcTimeout('5S')).toBe('5 s');
    expect(describeGrpcTimeout('2M')).toBe('2 min');
    expect(describeGrpcTimeout('90M')).toBe('1.5 h');
    expect(describeGrpcTimeout('100u')).toBe('under 1 ms');
    expect(describeGrpcTimeout('0S')).toBe('0 ms');
    // Rounding up to the next unit says it in that unit.
    expect(describeGrpcTimeout('999600u')).toBe('1 s');
    expect(describeGrpcTimeout('59960m')).toBe('1 min');
    expect(describeGrpcTimeout('3599999m')).toBe('1 h');
    expect(describeGrpcTimeout('soon')).toBeUndefined();
  });
});

describe('binary gRPC metadata', () => {
  it('shows base64 as hex bytes, padded or not', () => {
    expect(binaryHeaderHex('AQID')).toBe('01 02 03');
    expect(binaryHeaderHex('AQI')).toBe('01 02');
    expect(binaryHeaderHex('AQI=')).toBe('01 02');
    expect(binaryHeaderHex('')).toBe('');
  });

  it('shows each of several values joined by commas', () => {
    expect(binaryHeaderHex('AQ==, Ag')).toBe('01, 02');
  });

  it('cuts a long value, saying how long it was', () => {
    const long = btoa(String.fromCharCode(...new Array(100).fill(255)));
    const hex = binaryHeaderHex(long)!;
    expect(hex.startsWith('ff ff')).toBe(true);
    expect(hex.endsWith(`… (100 bytes)`)).toBe(true);
    expect(hex.split(' ').filter((b) => b === 'ff')).toHaveLength(MAX_BINARY_HEADER_BYTES);
  });

  it("isn't decoded when it isn't base64", () => {
    expect(binaryHeaderHex('not base64!')).toBeUndefined();
    expect(binaryHeaderHex('A')).toBeUndefined();
    expect(binaryHeaderHex('AQ=I')).toBeUndefined();
    expect(binaryHeaderHex('AQ==,%%')).toBeUndefined();
    // Padding in the wrong amount (atob would throw on these).
    expect(binaryHeaderHex('QQ=')).toBeUndefined();
    expect(binaryHeaderHex('QUJD=')).toBeUndefined();
    expect(binaryHeaderHex('QQ===')).toBeUndefined();
  });
});

describe('a gRPC call its client canceled', () => {
  const closed = { kind: 'client-closed', code: 'CLIENT_CLOSED', message: 'x' } as never;
  const reset = { kind: 'reset', code: 'ECONNRESET', message: 'x' } as never;

  it('is a gRPC call whose client closed it', () => {
    expect(isGrpcClientCancel(call({ failure: closed }))).toBe(true);
    expect(isGrpcClientCancel(call({ grpc: undefined, failure: closed }))).toBe(false);
    expect(isGrpcClientCancel(call({ failure: reset }))).toBe(false);
    expect(isGrpcClientCancel(call())).toBe(false);
  });

  it("isn't an error, but other requests the client closed still are", () => {
    expect(isError(call({ failure: closed }))).toBe(false);
    expect(isError(call({ grpc: undefined, contentType: 'application/json', failure: closed }))).toBe(true);
    expect(isError(call({ failure: reset }))).toBe(true);
  });

  it('is found as CANCELLED, and still by its failure', () => {
    const canceled = call({ failure: closed });
    expect(matchesFilter(canceled, 'grpc=CANCELLED', 'all')).toBe(true);
    expect(matchesFilter(canceled, 'grpc=1', 'all')).toBe(true);
    expect(matchesFilter(canceled, 'failure=client-closed', 'all')).toBe(true);
    expect(matchesFilter(canceled, '', 'errors')).toBe(false);
    expect(matchesFilter(call({ grpc: undefined, failure: closed }), 'grpc=CANCELLED', 'all')).toBe(false);
    // The server's own status wins.
    expect(matchesFilter(call({ failure: closed, grpcStatus: 13 }), 'grpc=INTERNAL', 'all')).toBe(true);
  });
});

describe('a gRPC call whose deadline passed', () => {
  const closed = { kind: 'client-closed', code: 'CLIENT_CLOSED', message: 'gave up' } as never;

  it('is told by time, allowing for the client starting its clock first', () => {
    expect(grpcDeadlinePassed('5S', 5000)).toBe(true);
    expect(grpcDeadlinePassed('5S', 4600)).toBe(true); // within a tenth
    expect(grpcDeadlinePassed('5S', 4000)).toBe(false);
    expect(grpcDeadlinePassed('30M', 1_799_100)).toBe(true); // at most a second early
    expect(grpcDeadlinePassed('30M', 1_798_000)).toBe(false);
    expect(grpcDeadlinePassed('500m', 400)).toBe(true); // at least 100 ms early
    expect(grpcDeadlinePassed('500m', 300)).toBe(false);
    expect(grpcDeadlinePassed(undefined, 99_999)).toBe(false);
    expect(grpcDeadlinePassed('soon', 99_999)).toBe(false);
  });

  it("isn't a cancel: it's DEADLINE_EXCEEDED, and an error", () => {
    const timedOut = call({ failure: closed, grpcDeadlineExceeded: true });
    expect(isGrpcClientCancel(timedOut)).toBe(false);
    expect(grpcClientSideStatus(timedOut)).toBe(4);
    expect(isError(timedOut)).toBe(true);
    expect(matchesFilter(timedOut, 'grpc=DEADLINE_EXCEEDED', 'all')).toBe(true);
    expect(matchesFilter(timedOut, 'grpc=CANCELLED', 'all')).toBe(false);
  });

  it('gives way to a status the server sent, everywhere', () => {
    const answered = call({ failure: closed, grpcStatus: 13 });
    expect(isGrpcClientCancel(answered)).toBe(false);
    expect(grpcClientSideStatus(answered)).toBeUndefined();
    expect(isError(answered)).toBe(true);
    expect(
      grpcClientSideStatus(call({ failure: closed, grpcStatus: 13, grpcDeadlineExceeded: true })),
    ).toBeUndefined();
    expect(grpcClientSideStatus(call({ failure: closed }))).toBe(1);
    expect(grpcClientSideStatus(call({ grpc: undefined, failure: closed }))).toBeUndefined();
  });
});
