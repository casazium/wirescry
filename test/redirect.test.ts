/** Where a redirect points, and the request that followed it (src/renderer/src/redirect.ts). */
import { describe, expect, it } from 'vitest';
import type { ExchangeSummary } from '../src/shared/api';
import { FOLLOW_WINDOW_MS, followingRequest, redirectTarget } from '../src/renderer/src/redirect';

const from = { status: 302, url: 'https://shop.test/cart/checkout?step=2' };

describe('redirectTarget', () => {
  it('resolves Location against the request’s URL', () => {
    expect(redirectTarget(from, [['Location', 'https://login.test/sign-in']])).toBe(
      'https://login.test/sign-in',
    );
    expect(redirectTarget(from, [['location', '/sign-in?next=%2Fcart']])).toBe(
      'https://shop.test/sign-in?next=%2Fcart',
    );
    expect(redirectTarget(from, [['LOCATION', 'done']])).toBe('https://shop.test/cart/done');
    expect(redirectTarget(from, [['location', '../help']])).toBe('https://shop.test/help');
    expect(redirectTarget(from, [['location', '//cdn.test/a.png']])).toBe('https://cdn.test/a.png');
    expect(redirectTarget(from, [['location', '  /spaced  ']])).toBe('https://shop.test/spaced');
  });

  it('is there for every 3xx but 304, and only those', () => {
    const headers: Array<[string, string]> = [['location', '/next']];
    for (const status of [300, 301, 302, 303, 307, 308, 399]) {
      expect(redirectTarget({ ...from, status }, headers), String(status)).toBe('https://shop.test/next');
    }
    for (const status of [200, 299, 304, 400, 404]) {
      expect(redirectTarget({ ...from, status }, headers), String(status)).toBeUndefined();
    }
    expect(redirectTarget({ ...from, status: undefined }, headers)).toBeUndefined();
  });

  it('is nothing without a Location, or with an empty one', () => {
    expect(redirectTarget(from, [['content-type', 'text/html']])).toBeUndefined();
    expect(redirectTarget(from, [['location', '   ']])).toBeUndefined();
    expect(redirectTarget(from, [])).toBeUndefined();
  });

  it('reads an absolute Location even when the request’s own URL can’t be read', () => {
    expect(
      redirectTarget({ status: 302, url: '/relative-only' }, [['location', 'HTTPS://Login.Test/a b']]),
    ).toBe('https://login.test/a%20b');
  });

  it('gives a Location that isn’t a URL as it is', () => {
    expect(redirectTarget(from, [['location', 'http://[not-a-host/']])).toBe('http://[not-a-host/');
  });
});

describe('followingRequest', () => {
  const exchange = (
    id: string,
    url: string,
    startedAt: number,
    method = 'GET',
    extra: Partial<ExchangeSummary> = {},
  ): ExchangeSummary => ({
    ...extra,
    id,
    method,
    url,
    startedAt,
    protocol: 'https',
    httpVersion: '1.1',
    host: new URL(url).host,
    path: new URL(url).pathname,
  });
  const redirected = exchange('r', 'https://shop.test/old', 100, 'POST');

  it('is the first request for the target made after the redirect, whatever its method', () => {
    const list = [
      exchange('earlier', 'https://shop.test/new', 50),
      redirected,
      exchange('later', 'https://shop.test/new', 300),
      exchange('other', 'https://shop.test/elsewhere', 150),
      exchange('next', 'https://shop.test/new', 120),
    ];
    expect(followingRequest(list, redirected, 'https://shop.test/new')?.id).toBe('next');
  });

  it('counts one made in the same millisecond, but never the redirect itself', () => {
    const same = exchange('same', 'https://shop.test/old', 100);
    expect(followingRequest([redirected, same], redirected, 'https://shop.test/old')?.id).toBe('same');
    expect(followingRequest([redirected], redirected, 'https://shop.test/old')).toBeUndefined();
  });

  it('matches the URL as it’s requested: the fragment never reaches the server', () => {
    const list = [redirected, exchange('next', 'https://shop.test/new', 120)];
    expect(followingRequest(list, redirected, 'https://shop.test/new#reviews')?.id).toBe('next');
    expect(followingRequest(list, redirected, 'https://shop.test/new?tab=2')).toBeUndefined();
    expect(followingRequest(list, redirected, 'http://shop.test/new')).toBeUndefined();
  });

  it('is nothing when there’s no such request, or the target isn’t a URL', () => {
    expect(followingRequest([redirected], redirected, 'https://shop.test/new')).toBeUndefined();
    expect(followingRequest([redirected], redirected, 'http://[not-a-host/')).toBeUndefined();
  });

  it('pairs redirects made at once with their own follow-ups, by when each was answered', () => {
    // Two tabs sent to the login page together: A answered at 110, B at 131.
    const a = exchange('a', 'https://shop.test/account', 100, 'GET', { durationMs: 10 });
    const b = exchange('b', 'https://shop.test/orders', 101, 'GET', { durationMs: 30 });
    const list = [
      a,
      b,
      exchange('login-a', 'https://shop.test/login', 110),
      exchange('login-b', 'https://shop.test/login', 131),
    ];
    expect(followingRequest(list, a, 'https://shop.test/login')?.id).toBe('login-a');
    expect(followingRequest(list, b, 'https://shop.test/login')?.id).toBe('login-b');
  });

  it('allows a few milliseconds of timing jitter, but not a request made before the answer', () => {
    const slow = exchange('slow', 'https://shop.test/old', 100, 'GET', { durationMs: 1000 });
    const at = (startedAt: number) => [slow, exchange('next', 'https://shop.test/new', startedAt)];
    expect(followingRequest(at(1095), slow, 'https://shop.test/new')?.id).toBe('next');
    expect(followingRequest(at(1100), slow, 'https://shop.test/new')?.id).toBe('next');
    expect(followingRequest(at(1094), slow, 'https://shop.test/new')).toBeUndefined();
    expect(followingRequest(at(500), slow, 'https://shop.test/new')).toBeUndefined();
  });

  it('isn’t a request for the URL long after: that’s a new visit, not following it', () => {
    const answered = exchange('r', 'https://shop.test/old', 100, 'GET', { durationMs: 20 });
    const at = (startedAt: number) => [answered, exchange('next', 'https://shop.test/new', startedAt)];
    expect(followingRequest(at(120 + FOLLOW_WINDOW_MS), answered, 'https://shop.test/new')?.id).toBe('next');
    expect(followingRequest(at(121 + FOLLOW_WINDOW_MS), answered, 'https://shop.test/new')).toBeUndefined();
  });

  it('is from the same client: this computer, or the same device', () => {
    const pixel = { kind: 'android' as const, id: 'pixel', label: 'Pixel 8' };
    const tablet = { kind: 'android' as const, id: 'tablet', label: 'Tablet' };
    const fromPixel = exchange('r', 'https://shop.test/old', 100, 'GET', { source: pixel });
    const list = [
      fromPixel,
      exchange('mac', 'https://shop.test/new', 110),
      exchange('tablet', 'https://shop.test/new', 111, 'GET', { source: tablet }),
      exchange('pixel', 'https://shop.test/new', 112, 'GET', { source: pixel }),
    ];
    expect(followingRequest(list, fromPixel, 'https://shop.test/new')?.id).toBe('pixel');
    const fromMac = exchange('m', 'https://shop.test/old', 100);
    expect(followingRequest([fromMac, ...list.slice(1)], fromMac, 'https://shop.test/new')?.id).toBe('mac');
  });

  it('keeps imported and composed requests to their own kind', () => {
    // An imported file keeps its own times, so live traffic always comes "after" it.
    const imported = exchange('i', 'https://shop.test/old', 100, 'GET', { imported: true });
    const live = exchange('live', 'https://shop.test/new', 110);
    const alsoImported = exchange('i2', 'https://shop.test/new', 120, 'GET', { imported: true });
    expect(followingRequest([imported, live], imported, 'https://shop.test/new')).toBeUndefined();
    expect(followingRequest([imported, live, alsoImported], imported, 'https://shop.test/new')?.id).toBe(
      'i2',
    );
    const capturedRedirect = exchange('c', 'https://shop.test/old', 100);
    expect(
      followingRequest([capturedRedirect, alsoImported], capturedRedirect, 'https://shop.test/new'),
    ).toBeUndefined();
    const composed = exchange('k', 'https://shop.test/old', 100, 'POST', { composed: true });
    expect(followingRequest([composed, live], composed, 'https://shop.test/new')).toBeUndefined();
    expect(
      followingRequest(
        [composed, exchange('k2', 'https://shop.test/new', 110, 'GET', { composed: true })],
        composed,
        'https://shop.test/new',
      )?.id,
    ).toBe('k2');
  });
});
