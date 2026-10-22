import type { ExchangeSummary } from './api';
import { exchangeType, type ExchangeType } from './exchange-type';

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
]);

export function isError(exchange: ExchangeSummary): boolean {
  return exchange.failure !== undefined || (exchange.status !== undefined && exchange.status >= 400);
}

function matchesQuick(exchange: ExchangeSummary, filter: QuickFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'errors') return isError(exchange);
  const type = exchangeType(exchange);
  return filter === 'other' ? !NAMED_TYPES.has(type) : type === filter;
}

/**
 * True if the exchange passes the quick filter and contains every word of the search
 * (case-insensitive) in its URL, method, status or content type.
 */
export function matchesFilter(exchange: ExchangeSummary, search: string, filter: QuickFilter): boolean {
  if (!matchesQuick(exchange, filter)) return false;
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack =
    `${exchange.method} ${exchange.status ?? ''} ${exchange.url} ${exchange.contentType ?? ''} ${exchange.failure ? `${exchange.failure.code} ${exchange.failure.kind}` : ''}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
