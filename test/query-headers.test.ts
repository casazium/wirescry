/**
 * Header terms in the search box's language (src/shared/query.ts): what they match, what they
 * don't, their errors, and that the rest of the language is unchanged by them.
 */
import { describe, expect, it } from 'vitest';
import type { ExchangeDetail, ExchangeSummary, Header } from '../src/shared/api';
import { compileQuery, MAX_QUERY_LENGTH, wildcardMatch } from '../src/shared/query';

const summary: ExchangeSummary = {
  id: 'a',
  method: 'GET',
  protocol: 'https',
  httpVersion: '2.0',
  host: 'api.example.com',
  path: '/v1/items',
  url: 'https://api.example.com/v1/items',
  startedAt: 0,
  status: 200,
  contentType: 'application/json',
};

function exchange(parts: {
  request?: Header[];
  response?: Header[];
  requestTrailers?: Header[];
  responseTrailers?: Header[];
  summary?: Partial<ExchangeSummary>;
}): ExchangeDetail {
  return {
    summary: { ...summary, ...parts.summary },
    requestHeaders: parts.request ?? [],
    ...(parts.response ? { responseHeaders: parts.response } : {}),
    ...(parts.requestTrailers ? { requestTrailers: parts.requestTrailers } : {}),
    ...(parts.responseTrailers ? { responseTrailers: parts.responseTrailers } : {}),
    timing: { startTimestamp: 0 },
  };
}

const typical = exchange({
  request: [
    [':method', 'GET'],
    [':authority', 'api.example.com'],
    [':path', '/v1/items'],
    ['Authorization', 'Bearer abc.def'],
    ['Accept', '*/*'],
    ['X-Request-Id', 'req-42'],
  ],
  response: [
    [':status', '200'],
    ['content-type', 'application/json'],
    ['Cache-Control', 'no-store, private'],
    ['set-cookie', 'a=1'],
    ['set-cookie', 'session=xyz; HttpOnly'],
  ],
});

const matches = (query: string, detail: ExchangeDetail = typical): boolean => {
  const q = compileQuery(query);
  expect(q.errors).toEqual([]);
  return q.matchesDetail(detail);
};
const errorsOf = (query: string): string[] => compileQuery(query).errors;

describe('header terms', () => {
  it('header~ finds text in any one header line, name and value', () => {
    expect(matches('header~bearer')).toBe(true);
    expect(matches('header~x-request-id')).toBe(true);
    expect(matches('header~"cache-control: no-store"')).toBe(true);
    expect(matches('header~session=xyz')).toBe(true);
    expect(matches('header~missing-text')).toBe(false);
  });

  it('header~ never matches across two header lines', () => {
    // "req-42" ends one line and "content-type" starts another (in the other side too).
    expect(matches('header~"req-42 accept"')).toBe(false);
    expect(matches('header~"*/*x-request-id"')).toBe(false);
    expect(matches('header~"application/jsoncache"')).toBe(false);
  });

  it('header.NAME= matches the value with * and ? wildcards, case-insensitively', () => {
    expect(matches('header.x-request-id=req-42')).toBe(true);
    expect(matches('header.x-request-id=REQ-*')).toBe(true);
    expect(matches('header.x-request-id=req-4?')).toBe(true);
    expect(matches('header.x-request-id=req-4')).toBe(false);
    expect(matches('HEADER.X-Request-ID=req-42')).toBe(true);
  });

  it('header.NAME=* means present; -header.NAME=* means absent', () => {
    expect(matches('header.authorization=*')).toBe(true);
    expect(matches('-header.authorization=*')).toBe(false);
    expect(matches('header.cookie=*')).toBe(false);
    expect(matches('-header.cookie=*')).toBe(true);
  });

  it('header.NAME~ finds text in the value, taking * and ? literally', () => {
    expect(matches('header.cache-control~no-store')).toBe(true);
    expect(matches('header.accept~*/*')).toBe(true);
    expect(matches('header.accept~*/x')).toBe(false);
    // The name isn't part of what ~ looks in.
    expect(matches('header.cache-control~cache')).toBe(false);
  });

  it('header.NAME!= is the same as -header.NAME=, so an absent header matches', () => {
    expect(matches('header.x-request-id!=req-42')).toBe(false);
    expect(matches('header.x-request-id!=other')).toBe(true);
    expect(matches('header.cookie!=anything')).toBe(true);
    for (const detail of [typical, exchange({ request: [['cookie', 'z']] }), exchange({})]) {
      expect(matches('header.cookie!=z', detail)).toBe(matches('-header.cookie=z', detail));
    }
  });

  it('a repeated header matches if any copy does', () => {
    expect(matches('header.set-cookie=a=1')).toBe(true);
    expect(matches('header.set-cookie=session=*')).toBe(true);
    expect(matches('header.set-cookie!=a=1')).toBe(false);
  });

  it('values with = or ~ in them work', () => {
    expect(matches('header~a=1')).toBe(true);
    const tilde = exchange({ request: [['x-path', '~/home']] });
    expect(matches('header.x-path~~/ho', tilde)).toBe(true);
    expect(matches('header~"x-path: ~/home"', tilde)).toBe(true);
  });

  it('reqheader and resheader look on one side only', () => {
    expect(matches('reqheader.authorization=*')).toBe(true);
    expect(matches('resheader.authorization=*')).toBe(false);
    expect(matches('resheader~no-store')).toBe(true);
    expect(matches('reqheader~no-store')).toBe(false);
    expect(matches('-resheader.set-cookie=*')).toBe(false);
    expect(matches('-reqheader.set-cookie=*')).toBe(true);
  });

  it('trailers count, on their own side', () => {
    const grpc = exchange({
      request: [['content-type', 'application/grpc']],
      response: [['content-type', 'application/grpc']],
      requestTrailers: [['x-upload-checksum', 'abc']],
      responseTrailers: [
        ['grpc-status', '5'],
        ['grpc-message', 'not found'],
      ],
    });
    expect(matches('resheader.grpc-status=5', grpc)).toBe(true);
    expect(matches('header~"grpc-message: not found"', grpc)).toBe(true);
    expect(matches('reqheader.grpc-status=*', grpc)).toBe(false);
    expect(matches('reqheader.x-upload-checksum=abc', grpc)).toBe(true);
    expect(matches('resheader.x-upload-checksum=*', grpc)).toBe(false);
  });

  it('leaves out HTTP/2 pseudo-headers', () => {
    expect(matches('header~:authority')).toBe(false);
    expect(matches('header~":path: /v1"')).toBe(false);
    expect(matches('header~"status: 200"')).toBe(false);
    expect(matches('header~"method: get"')).toBe(false);
  });

  it('an exchange still waiting for its response has no response headers', () => {
    const pending = exchange({ request: [['x-a', '1']], summary: { status: undefined } });
    expect(matches('resheader.x-a=*', pending)).toBe(false);
    expect(matches('resheader~x', pending)).toBe(false);
    expect(matches('reqheader.x-a=1', pending)).toBe(true);
  });

  it('combines with the other terms, all of which must match', () => {
    expect(matches('host=api.* header.authorization=* -resheader.x-cache=*')).toBe(true);
    expect(matches('host=cdn.* header.authorization=*')).toBe(false);
    expect(matches('status>=400 header.authorization=*')).toBe(false);
    expect(matches('items header~bearer')).toBe(true);
    expect(matches('nothing-like-this header~bearer')).toBe(false);
  });

  it('says it needs the backend only when there are header terms', () => {
    expect(compileQuery('header~x').needsDetail).toBe(true);
    expect(compileQuery('-resheader.a=*').needsDetail).toBe(true);
    expect(compileQuery('host=api.* status>=400 bearer').needsDetail).toBe(false);
    expect(compileQuery('header.css').needsDetail).toBe(false);
    expect(compileQuery('header.x>3').needsDetail).toBe(false);
  });

  it('counts header terms as passing when only the summary is checked', () => {
    const q = compileQuery('host=api.* header.nope=*');
    expect(q.matches(summary)).toBe(true);
    expect(compileQuery('-header.nope=*').matches(summary)).toBe(true);
    expect(compileQuery('host=cdn.* header~x').matches(summary)).toBe(false);
  });
});

describe('plain words and existing fields are unchanged', () => {
  it('plain words don’t search headers', () => {
    expect(matches('bearer')).toBe(false);
    expect(matches('req-42')).toBe(false);
    expect(matches('items')).toBe(true);
  });

  it('header.css and other words without an operator stay plain text', () => {
    const css = { ...summary, url: 'https://cdn.test/header.css', path: '/header.css' };
    for (const word of ['header.css', 'header.js', 'header', 'headers', 'header.x!y']) {
      const q = compileQuery(word);
      expect(q.errors).toEqual([]);
      expect(q.hints).toEqual([]);
      expect(q.needsDetail).toBe(false);
    }
    expect(compileQuery('header.css').matches(css)).toBe(true);
    expect(compileQuery('header.css').matches(summary)).toBe(false);
  });

  it('dotted names on other fields stay plain text, with no new hint', () => {
    for (const term of ['host.foo=bar', 'foo.bar=1', 'status.code=404']) {
      const q = compileQuery(term);
      expect(q.errors).toEqual([]);
      expect(q.hints).toEqual([]);
      expect(q.matches(summary)).toBe(false);
      expect(q.matches({ ...summary, url: `https://x.test/?${term}` })).toBe(true);
    }
  });
});

describe('header term errors', () => {
  it('asks for a header name', () => {
    expect(errorsOf('header=x')).toEqual(['header= needs a header name: header.NAME=value, or header~text']);
    expect(errorsOf('resheader!=x')).toEqual([
      'resheader!= needs a header name: resheader.NAME=value, or resheader~text',
    ]);
    expect(errorsOf('header.=x')).toEqual([
      'header.= needs a header name: header.NAME=value, or header~text',
    ]);
  });

  it('refuses names with other characters', () => {
    expect(errorsOf('header.a/b=x')).toEqual([
      `"a/b" isn't a header name; names use letters, digits, - and _`,
    ]);
    expect(errorsOf('header.a.b=x')).toEqual([
      `"a.b" isn't a header name; names use letters, digits, - and _`,
    ]);
    expect(errorsOf('header.:path=x')).toHaveLength(1);
  });

  it('refuses number comparisons', () => {
    expect(errorsOf('header.content-length>3')).toEqual([
      "header.content-length can't be compared with >; use =, != or ~",
    ]);
    expect(errorsOf('reqheader.x<=3')).toEqual(["reqheader.x can't be compared with <=; use =, != or ~"]);
  });

  it('needs a value', () => {
    expect(errorsOf('header~')).toEqual(['header~ needs a value']);
    expect(errorsOf('header.x=')).toEqual(['header.x= needs a value']);
  });

  it('drops a term with an error and keeps the rest', () => {
    const q = compileQuery('host=api.* header.a/b=x');
    expect(q.needsDetail).toBe(false);
    expect(q.matches(summary)).toBe(true);
  });

  it('drops header terms from a search that is too long', () => {
    const long = `header~x ${'a'.repeat(MAX_QUERY_LENGTH)}`;
    const q = compileQuery(long);
    expect(q.errors[0]).toContain('too long');
    expect(q.needsDetail).toBe(false);
    expect(compileQuery(`header~x ${'a'.repeat(MAX_QUERY_LENGTH - 9)}`).needsDetail).toBe(true);
  });
});

describe('wildcardMatch', () => {
  it('matches like a glob', () => {
    expect(wildcardMatch('abc', 'abc')).toBe(true);
    expect(wildcardMatch('abc', 'a*')).toBe(true);
    expect(wildcardMatch('abc', '*c')).toBe(true);
    expect(wildcardMatch('abc', 'a?c')).toBe(true);
    expect(wildcardMatch('abc', '*')).toBe(true);
    expect(wildcardMatch('', '*')).toBe(true);
    expect(wildcardMatch('', '')).toBe(true);
    expect(wildcardMatch('abc', 'a*b*c')).toBe(true);
    expect(wildcardMatch('abc', 'ab')).toBe(false);
    expect(wildcardMatch('ab', 'abc')).toBe(false);
    expect(wildcardMatch('abc', '?')).toBe(false);
    expect(wildcardMatch('', '?')).toBe(false);
    expect(wildcardMatch('aXbXc', 'a*c')).toBe(true);
    expect(wildcardMatch('mississippi', 'm*iss*ppi')).toBe(true);
    expect(wildcardMatch('mississippi', 'm*iss*ppx')).toBe(false);
  });

  it('finishes quickly on a pattern that makes a regular expression backtrack', () => {
    const value = 'a'.repeat(4096);
    const pattern = '*a*a*a*a*a*a*a*a*b';
    const started = performance.now();
    expect(wildcardMatch(value, pattern)).toBe(false);
    expect(
      compileQuery(`header.cookie=${pattern}`).matchesDetail(exchange({ request: [['cookie', value]] })),
    ).toBe(false);
    // Generous: it takes well under a millisecond; a backtracking regex takes minutes.
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
