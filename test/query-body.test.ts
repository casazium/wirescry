/**
 * Body terms in the search box's language (src/shared/query.ts): what they compile to, their
 * errors, and that the rest of the language is unchanged by them.
 */
import { describe, expect, it } from 'vitest';
import type { ExchangeSummary } from '../src/shared/api';
import { compileFilter } from '../src/shared/filter';
import { compileQuery, foldText, MAX_HEADER_VALUE, MAX_QUERY_LENGTH } from '../src/shared/query';

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

const terms = (query: string) => compileQuery(query).bodyTerms;
const errorsOf = (query: string) => compileQuery(query).errors;

describe('body terms', () => {
  it('compile each form, folded, with its side', () => {
    expect(terms('body~Error')).toEqual([{ needle: 'error', side: 'both', negated: false }]);
    expect(terms('reqbody~X')).toEqual([{ needle: 'x', side: 'request', negated: false }]);
    expect(terms('RESBODY~"Not Found"')).toEqual([{ needle: 'not found', side: 'response', negated: false }]);
    expect(terms('-body~x')).toEqual([{ needle: 'x', side: 'both', negated: true }]);
    expect(terms('body~ΟΔΟΣ')).toEqual([{ needle: 'οδοσ', side: 'both', negated: false }]);
  });

  it('take operator characters and = inside the value', () => {
    expect(terms('body~a=b')).toEqual([{ needle: 'a=b', side: 'both', negated: false }]);
    expect(terms('body~~x')).toEqual([{ needle: '~x', side: 'both', negated: false }]);
    expect(terms('body~"x: y"')).toEqual([{ needle: 'x: y', side: 'both', negated: false }]);
  });

  it('need the backend, and say they read bodies', () => {
    const q = compileQuery('host=api.* body~x');
    expect(q.needsDetail).toBe(true);
    expect(q.needsBody).toBe(true);
    const header = compileQuery('header~x');
    expect(header.needsDetail).toBe(true);
    expect(header.needsBody).toBe(false);
    expect(compileQuery('host=api.*').needsDetail).toBe(false);
  });

  it('pass in the summary and header checks, which leave them to the body search', () => {
    expect(compileQuery('body~nowhere').matches(summary)).toBe(true);
    expect(compileQuery('-body~x').matches(summary)).toBe(true);
    expect(compileQuery('host=cdn.* body~x').matches(summary)).toBe(false);
    const detail = { summary, requestHeaders: [], timing: { startTimestamp: 0 } };
    expect(compileQuery('body~nowhere').matchesDetail(detail)).toBe(true);
    expect(compileQuery('header.x=* body~nowhere').matchesDetail(detail)).toBe(false);
  });

  it('pass through compileFilter', () => {
    const f = compileFilter('resbody~x', 'json');
    expect(f.needsBody).toBe(true);
    expect(f.bodyTerms).toEqual([{ needle: 'x', side: 'response', negated: false }]);
  });

  it('take only ~, with a clear error otherwise', () => {
    expect(errorsOf('body=x')).toEqual(["body= isn't supported: body terms take only ~, as in body~text"]);
    expect(errorsOf('reqbody!=x')).toEqual([
      "reqbody!= isn't supported: body terms take only ~, as in reqbody~text",
    ]);
    expect(errorsOf('resbody>3')).toEqual([
      "resbody> isn't supported: body terms take only ~, as in resbody~text",
    ]);
    expect(errorsOf('-body=x')).toHaveLength(1);
    for (const term of ['body=x', 'body<3', 'body>=1']) {
      const q = compileQuery(term);
      expect(q.bodyTerms).toEqual([]);
      expect(q.needsDetail).toBe(false);
      // Dropped: it filters nothing.
      expect(q.matches(summary)).toBe(true);
    }
  });

  it('need a value of at most the cap', () => {
    expect(errorsOf('body~')).toEqual(['body~ needs a value']);
    expect(errorsOf('resbody~')).toEqual(['resbody~ needs a value']);
    expect(errorsOf(`body~${'x'.repeat(MAX_HEADER_VALUE)}`)).toEqual([]);
    expect(errorsOf(`body~${'x'.repeat(MAX_HEADER_VALUE + 1)}`)).toEqual([
      `body~ takes at most ${MAX_HEADER_VALUE} characters`,
    ]);
  });

  it('are dropped from a search over the length limit, with the shared error', () => {
    const q = compileQuery(`body~x header~y ${'p'.repeat(MAX_QUERY_LENGTH)}`);
    expect(q.bodyTerms).toEqual([]);
    expect(q.needsDetail).toBe(false);
    expect(q.errors).toEqual(['The search is too long for header and body terms: 4,096 characters at most.']);
  });

  it('near-misses aren’t body terms', () => {
    for (const term of [
      'body',
      'body.css',
      'body.x~y',
      'bodies~x',
      'nobody~x',
      'xbody~x',
      'resbodies=1',
      'bodyx~y',
    ]) {
      const q = compileQuery(term);
      expect({ term, terms: q.bodyTerms, errors: q.errors, needsDetail: q.needsDetail }).toEqual({
        term,
        terms: [],
        errors: [],
        needsDetail: false,
      });
    }
  });

  it('plain words still don’t search bodies, and existing fields are unchanged', () => {
    expect(compileQuery('error').bodyTerms).toEqual([]);
    expect(compileQuery('path~body').matches({ ...summary, path: '/body' })).toBe(true);
    expect(compileQuery('url~"body=1"').matches({ ...summary, url: 'https://x.test/?body=1' })).toBe(true);
  });
});

describe('foldText', () => {
  it('lowercases, and folds final sigma to σ', () => {
    expect(foldText('ABC')).toBe('abc');
    expect(foldText('ΟΔΟΣ')).toBe('οδοσ');
    expect(foldText('ΟΔΟΣ ΚΑΙ')).toBe('οδοσ και');
    expect(foldText('οδος')).toBe('οδοσ');
    expect(foldText('İ')).toBe('i̇');
  });
});
