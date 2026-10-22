import { describe, expect, it } from 'vitest';
import type { ExchangeSummary } from '../src/shared/api';
import { exchangeType } from '../src/shared/exchange-type';
import { describeFailure } from '../src/shared/failure';
import { matchesFilter } from '../src/shared/filter';
import { ExchangeList } from '../src/renderer/src/exchange-list';

const exchange = (overrides: Partial<ExchangeSummary> = {}): ExchangeSummary => ({
  id: 'id',
  method: 'GET',
  protocol: 'https',
  httpVersion: '2',
  host: 'api.example.com',
  path: '/v1/users?page=2',
  url: 'https://api.example.com/v1/users?page=2',
  startedAt: 0,
  status: 200,
  contentType: 'application/json',
  ...overrides,
});

describe('exchangeType', () => {
  it.each([
    ['application/json', '/x', 'json'],
    ['application/problem+json', '/x', 'json'],
    ['text/html', '/x', 'html'],
    ['text/javascript', '/x', 'js'],
    ['application/javascript', '/x', 'js'],
    ['text/css', '/x', 'css'],
    ['image/svg+xml', '/x', 'image'],
    ['font/woff2', '/x', 'font'],
    ['video/mp4', '/x', 'media'],
    ['application/xml', '/x', 'xml'],
    ['text/plain', '/x', 'text'],
    ['application/octet-stream', '/x', 'other'],
    [undefined, '/app.js?v=3', 'js'],
    [undefined, '/logo.PNG', 'image'],
    [undefined, '/no-extension', 'other'],
  ] as const)('%s at %s is %s', (contentType, path, type) => {
    expect(exchangeType({ contentType, path })).toBe(type);
  });
});

describe('matchesFilter', () => {
  it('matches every search word, ignoring case', () => {
    expect(matchesFilter(exchange(), 'USERS page=2', 'all')).toBe(true);
    expect(matchesFilter(exchange(), 'users orders', 'all')).toBe(false);
    expect(matchesFilter(exchange({ method: 'POST' }), 'post', 'all')).toBe(true);
    expect(matchesFilter(exchange({ status: 404 }), '404', 'all')).toBe(true);
  });

  it('applies quick filters by type and for errors', () => {
    expect(matchesFilter(exchange(), '', 'json')).toBe(true);
    expect(matchesFilter(exchange(), '', 'image')).toBe(false);
    expect(matchesFilter(exchange({ contentType: 'application/xml' }), '', 'other')).toBe(true);
    expect(matchesFilter(exchange({ status: 503 }), '', 'errors')).toBe(true);
    expect(
      matchesFilter(
        exchange({ status: undefined, failure: describeFailure('ECONNREFUSED', 'api.example.com') }),
        '',
        'errors',
      ),
    ).toBe(true);
    expect(matchesFilter(exchange({ status: 304 }), '', 'errors')).toBe(false);
  });
});

describe('ExchangeList', () => {
  it('adds new exchanges, updates existing ones in place, and removes evicted ones', () => {
    const list = new ExchangeList();
    list.reset([exchange({ id: 'a' }), exchange({ id: 'b' })]);
    list.apply([exchange({ id: 'b', status: 500 }), exchange({ id: 'c' })], ['a']);
    expect(list.snapshot().map((e) => [e.id, e.status])).toEqual([
      ['b', 500],
      ['c', 200],
    ]);
    list.apply([exchange({ id: 'c', status: 201 })], []);
    expect(list.snapshot().map((e) => e.status)).toEqual([500, 201]);
  });

  it('handles 10,000 exchanges quickly', () => {
    const list = new ExchangeList();
    const started = performance.now();
    for (let i = 0; i < 10_000; i++) list.apply([exchange({ id: String(i) })], []);
    for (let i = 0; i < 10_000; i++) list.apply([exchange({ id: String(i), status: 204 })], []);
    expect(list.snapshot()).toHaveLength(10_000);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
