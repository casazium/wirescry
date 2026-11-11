import type { ExchangeSummary } from './api';
import { exchangeType, type ExchangeType } from './exchange-type';
import { isGrpcError } from './grpc';
import { compileQuery, type CompiledQuery } from './query';

export const QUICK_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'json', label: 'JSON' },
  { id: 'html', label: 'HTML' },
  { id: 'js', label: 'JS' },
  { id: 'css', label: 'CSS' },
  { id: 'image', label: 'Images' },
  { id: 'media', label: 'Media' },
  { id: 'font', label: 'Fonts' },
  { id: 'websocket', label: 'WebSockets' },
  { id: 'grpc', label: 'gRPC' },
  { id: 'other', label: 'Other' },
  { id: 'errors', label: 'Errors' },
] as const;

export type QuickFilter = (typeof QUICK_FILTERS)[number]['id'];

const NAMED_TYPES = new Set<ExchangeType>([
  'json',
  'html',
  'js',
  'css',
  'image',
  'media',
  'font',
  'websocket',
  'grpc',
]);

/** A failure, an HTTP error status, or a gRPC error status (gRPC errors come with HTTP 200). */
export function isError(exchange: ExchangeSummary): boolean {
  return (
    exchange.failure !== undefined ||
    (exchange.status !== undefined && exchange.status >= 400) ||
    isGrpcError(exchange.grpcStatus)
  );
}

function matchesQuick(exchange: ExchangeSummary, filter: QuickFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'errors') return isError(exchange);
  const type = exchangeType(exchange);
  return filter === 'other' ? !NAMED_TYPES.has(type) : type === filter;
}

/** A quick filter plus a compiled search, ready to test many exchanges. */
export function compileFilter(search: string, filter: QuickFilter): CompiledQuery {
  const query = compileQuery(search);
  return { ...query, matches: (e) => matchesQuick(e, filter) && query.matches(e) };
}

/** True if the exchange passes the quick filter and the search (see query.ts for the syntax). */
export function matchesFilter(exchange: ExchangeSummary, search: string, filter: QuickFilter): boolean {
  return compileFilter(search, filter).matches(exchange);
}
