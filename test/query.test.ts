import { describe, expect, it } from 'vitest';
import type { ExchangeSummary } from '../src/shared/api';
import { describeFailure } from '../src/shared/failure';
import { compileQuery, tokenize } from '../src/shared/query';

const base: ExchangeSummary = {
  id: '1',
  method: 'GET',
  protocol: 'https',
  httpVersion: '2',
  host: 'api.example.com',
  path: '/v1/login?next=%2Fhome',
  url: 'https://api.example.com/v1/login?next=%2Fhome',
  startedAt: 0,
  status: 200,
  contentType: 'application/json',
  responseSize: 2048,
  durationMs: 750,
};

const rows: Record<string, ExchangeSummary> = {
  apiOk: base,
  apiPost: {
    ...base,
    id: '2',
    method: 'POST',
    status: 201,
    path: '/v1/orders',
    url: 'https://api.example.com/v1/orders',
  },
  notFound: {
    ...base,
    id: '3',
    host: 'cdn.example.com',
    path: '/logo.png',
    url: 'https://cdn.example.com/logo.png',
    status: 404,
    contentType: 'image/png',
    responseSize: 5 * 1024 * 1024,
    durationMs: 40,
  },
  serverError: {
    ...base,
    id: '4',
    host: 'www.google.com',
    path: '/',
    url: 'https://www.google.com/',
    status: 503,
    contentType: 'text/html',
    durationMs: 2500,
  },
  dns: {
    ...base,
    id: '5',
    host: 'nope.invalid',
    path: '/login',
    url: 'https://nope.invalid/login',
    status: 502,
    responseSize: 30,
    failure: describeFailure('ENOTFOUND', 'nope.invalid'),
  },
};

/** Ids of the rows the query matches. */
const ids = (query: string): string[] => {
  const q = compileQuery(query);
  return Object.entries(rows)
    .filter(([, e]) => q.matches(e))
    .map(([name]) => name);
};

describe('compileQuery', () => {
  it('matches everything when empty', () => {
    expect(ids('')).toHaveLength(5);
  });

  it('compares status numerically and by class', () => {
    expect(ids('status>=400')).toEqual(['notFound', 'serverError', 'dns']);
    expect(ids('status<300')).toEqual(['apiOk', 'apiPost']);
    expect(ids('status=404')).toEqual(['notFound']);
    expect(ids('status!=200')).toEqual(['apiPost', 'notFound', 'serverError', 'dns']);
    expect(ids('status=5xx')).toEqual(['serverError', 'dns']);
    expect(ids('status=20x')).toEqual(['apiOk', 'apiPost']);
    expect(ids('status!=2xx')).toEqual(['notFound', 'serverError', 'dns']);
  });

  it('matches text fields exactly, ignoring case, with wildcards', () => {
    expect(ids('method=POST')).toEqual(['apiPost']);
    expect(ids('method=post')).toEqual(['apiPost']);
    expect(ids('host=api.*')).toEqual(['apiOk', 'apiPost']);
    expect(ids('host=*.example.com')).toEqual(['apiOk', 'apiPost', 'notFound']);
    expect(ids('host=api')).toEqual([]); // = is a full match.
    expect(ids('host=ap?.example.com')).toEqual(['apiOk', 'apiPost']);
    expect(ids('method!=GET')).toEqual(['apiPost']);
  });

  it('treats a dot as a literal dot in wildcards', () => {
    expect(compileQuery('host=api.example.com').matches({ ...base, host: 'apixexample.com' })).toBe(false);
  });

  it('finds substrings with ~', () => {
    expect(ids('path~login')).toEqual(['apiOk', 'dns']);
    expect(ids('url~GOOGLE')).toEqual(['serverError']);
  });

  it('compares size and time with units', () => {
    expect(ids('size>1mb')).toEqual(['notFound']);
    expect(ids('size<=2kb')).toEqual(['apiOk', 'apiPost', 'serverError', 'dns']);
    expect(ids('size=2048')).toEqual(['apiOk', 'apiPost', 'serverError']);
    expect(ids('time>=1s')).toEqual(['serverError']);
    expect(ids('time<100ms')).toEqual(['notFound']);
  });

  it('filters by type and failure', () => {
    expect(ids('type=image')).toEqual(['notFound']);
    expect(ids('type=json')).toEqual(['apiOk', 'apiPost']);
    expect(ids('failure=dns')).toEqual(['dns']);
    expect(ids('error=ENOTFOUND')).toEqual(['dns']);
    expect(ids('failure=*')).toEqual(['dns']);
  });

  it('accepts aliases', () => {
    expect(ids('code=404')).toEqual(['notFound']);
    expect(ids('domain=www.*')).toEqual(['serverError']);
    expect(ids('duration>2s')).toEqual(['serverError']);
  });

  it('combines terms with AND and negates with -', () => {
    expect(ids('host=api.* method=GET')).toEqual(['apiOk']);
    expect(ids('status>=400 -host=*.google.com')).toEqual(['notFound', 'dns']);
    expect(ids('-png')).toEqual(['apiOk', 'apiPost', 'serverError', 'dns']);
    expect(ids('example -cdn')).toEqual(['apiOk', 'apiPost']);
  });

  it('still searches plain words everywhere', () => {
    expect(ids('orders')).toEqual(['apiPost']);
    expect(ids('enotfound')).toEqual(['dns']);
    expect(ids('503')).toEqual(['serverError']);
  });

  it('searches unknown fields as text, with a hint', () => {
    const q = compileQuery('next=%2Fhome');
    expect(q.hints).toEqual(['No field called "next", so "next=%2Fhome" is searched as text.']);
    expect(ids('next=%2Fhome')).toEqual(['apiOk']);
  });

  it('reports invalid values and skips those terms', () => {
    expect(compileQuery('status>abc').errors).toEqual([`"abc" isn't a valid status; try something like 404`]);
    expect(compileQuery('size>lots').errors[0]).toContain('10kb or 2mb');
    expect(compileQuery('method>GET').errors[0]).toContain("can't be compared with >");
    expect(compileQuery('status~40').errors[0]).toContain('is a number');
    expect(compileQuery('host=').errors).toEqual(['host= needs a value']);
    expect(ids('status>abc method=POST')).toEqual(['apiPost']); // The bad term is ignored.
  });

  it('filters by the plugin rule that handled a request', () => {
    const mocked = { ...base, handledBy: { plugin: 'pro', ruleId: 'r1', label: 'Login mock' } };
    expect(compileQuery('rule=login*').matches(mocked)).toBe(true);
    expect(compileQuery('rule=login*').matches(base)).toBe(false);
    expect(compileQuery('rule=*').matches(base)).toBe(false);
  });

  it("doesn't match missing values in numeric comparisons", () => {
    const pending = { ...base, status: undefined, responseSize: undefined, durationMs: undefined };
    expect(compileQuery('status<500').matches(pending)).toBe(false);
    expect(compileQuery('size<1kb').matches(pending)).toBe(false);
  });
});

describe('tokenize', () => {
  it('splits on spaces and keeps quoted text together', () => {
    expect(tokenize('  a  b ')).toEqual(['a', 'b']);
    expect(tokenize('"not found" path~"my file" x')).toEqual(['not found', 'path~my file', 'x']);
    expect(tokenize('""')).toEqual(['']);
  });
});
