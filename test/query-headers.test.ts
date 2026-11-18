/**
 * Header terms in the search box's language (src/shared/query.ts): what they match, what they
 * don't, their errors, and that the rest of the language is unchanged by them.
 */
import { describe, expect, it } from 'vitest';
import type { ExchangeDetail, ExchangeSummary, Header } from '../src/shared/api';
import { compileFilter } from '../src/shared/filter';
import { compileQuery, MAX_HEADER_VALUE, MAX_QUERY_LENGTH, wildcardMatch } from '../src/shared/query';

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

describe('non-ASCII', () => {
  it('matches non-ASCII header values, case-insensitively', () => {
    const intl = exchange({ request: [['x-city', 'Zürich']], response: [['x-note', 'ÉTÉ 日本']] });
    expect(matches('header.x-city=zürich', intl)).toBe(true);
    expect(matches('header.x-city=z?rich', intl)).toBe(true);
    expect(matches('resheader~été', intl)).toBe(true);
    expect(matches('header~日本', intl)).toBe(true);
    expect(matches('header.x-city=zurich', intl)).toBe(false);
  });

  it('searches a non-ASCII header name as text', () => {
    const q = compileQuery('header.größe=1');
    expect(q.needsDetail).toBe(false);
    expect(q.hints).toHaveLength(1);
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

  it('searches a name with other characters as text, with a hint (it is likely part of a URL)', () => {
    for (const term of [
      'header.php?id=1',
      'header.js?v=3',
      'header.a/b=x',
      'header.a.b=x',
      'header.:path=x',
    ]) {
      const q = compileQuery(term);
      expect(q.errors).toEqual([]);
      expect(q.hints).toEqual([`"${term}" is searched as text: header names use letters, digits, - and _.`]);
      expect(q.needsDetail).toBe(false);
      expect(q.matches(summary)).toBe(false);
      expect(q.matches({ ...summary, url: `https://x.test/${term}` })).toBe(true);
    }
    // Negated, it's plain text excluded.
    expect(
      compileQuery('-header.php?id=1').matches({ ...summary, url: 'https://x.test/header.php?id=1' }),
    ).toBe(false);
  });

  it('caps a header term’s value', () => {
    const max = 'x'.repeat(MAX_HEADER_VALUE);
    expect(errorsOf(`header.a=${max}`)).toEqual([]);
    expect(errorsOf(`header.a=${max}x`)).toEqual([`header.a= takes at most ${MAX_HEADER_VALUE} characters`]);
    expect(errorsOf(`header~${max}x`)).toEqual([`header~ takes at most ${MAX_HEADER_VALUE} characters`]);
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
    const q = compileQuery('host=api.* header.a>3');
    expect(q.needsDetail).toBe(false);
    expect(q.matches(summary)).toBe(true);
  });

  it('drops header terms from a search that is too long', () => {
    const long = `header~x ${'a'.repeat(MAX_QUERY_LENGTH)}`;
    const q = compileQuery(long);
    expect(q.errors).toEqual(['The search is too long for header terms: 4,096 characters at most.']);
    expect(q.needsDetail).toBe(false);
    // Exactly at the limit is fine.
    const atLimit = `header~x ${'a'.repeat(MAX_QUERY_LENGTH - 9)}`;
    expect(atLimit).toHaveLength(MAX_QUERY_LENGTH);
    expect(compileQuery(atLimit).errors).toEqual([]);
    expect(compileQuery(atLimit).needsDetail).toBe(true);
  });

  it('says nothing about length for a long search without header terms', () => {
    const q = compileQuery(`items ${'a'.repeat(MAX_QUERY_LENGTH)}`);
    expect(q.errors).toEqual([]);
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

  it('handles ? inside pieces between stars, and repeated stars', () => {
    expect(wildcardMatch('session=abc; path=/', 's?ssion=*; p?th=*')).toBe(true);
    expect(wildcardMatch('abcabd', '*ab?')).toBe(true);
    expect(wildcardMatch('abcabd', '*a?d')).toBe(true);
    expect(wildcardMatch('abcabd', 'a**d')).toBe(true);
    expect(wildcardMatch('abcabd', '*x?d')).toBe(false);
    // The first and last pieces mustn't overlap.
    expect(wildcardMatch('aba', 'ab*ba')).toBe(false);
    expect(wildcardMatch('abba', 'ab*ba')).toBe(true);
    // A middle piece must fit between them.
    expect(wildcardMatch('abXcd', 'ab*X*cd')).toBe(true);
    expect(wildcardMatch('abcd', 'ab*c*cd')).toBe(false);
    expect(wildcardMatch('ab?cd', 'ab*?*cd')).toBe(true);
  });

  it('agrees with a plain reference on thousands of random cases', () => {
    // A small, slow, obviously right matcher: fine on short strings.
    const reference = (text: string, pattern: string): boolean => {
      const memo = new Map<string, boolean>();
      const go = (t: number, p: number): boolean => {
        const key = `${t},${p}`;
        const known = memo.get(key);
        if (known !== undefined) return known;
        let result: boolean;
        if (p === pattern.length) result = t === text.length;
        else if (pattern[p] === '*') result = go(t, p + 1) || (t < text.length && go(t + 1, p));
        else result = t < text.length && (pattern[p] === '?' || pattern[p] === text[t]) && go(t + 1, p + 1);
        memo.set(key, result);
        return result;
      };
      return go(0, 0);
    };
    // Seeded, so a failure repeats.
    let seed = 12345;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pick = (alphabet: string, length: number): string =>
      Array.from({ length }, () => alphabet[random(alphabet.length)]).join('');
    let agreed = 0;
    for (let i = 0; i < 4000; i++) {
      const text = pick('ab', random(90));
      // Pieces long enough to cross a 32-bit word, with ? and * mixed in.
      const pattern = pick('ab??*', random(i % 4 === 0 ? 80 : 12));
      expect({ text, pattern, result: wildcardMatch(text, pattern) }).toEqual({
        text,
        pattern,
        result: reference(text, pattern),
      });
      agreed++;
    }
    expect(agreed).toBe(4000);
  });

  it('a middle piece with ? must end before the last piece starts', () => {
    expect(wildcardMatch('xabcd', '*a?c*cd')).toBe(false);
    expect(wildcardMatch('xabccd', '*a?c*cd')).toBe(true);
    expect(wildcardMatch('ab', '*?b*b')).toBe(false);
  });

  it('agrees with the reference on long pieces with ?, where most should match', () => {
    const reference = (text: string, pattern: string): boolean =>
      new RegExp(`^${pattern.replace(/\?/g, '.').replace(/\*/g, '.*')}$`, 's').test(text);
    let seed = 777;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pick = (alphabet: string, length: number): string =>
      Array.from({ length }, () => alphabet[random(alphabet.length)]).join('');
    for (let i = 0; i < 2000; i++) {
      // A piece of 20 to 100 characters, some of them ?, found inside a text built around it.
      const piece = pick('ab', 20 + random(81))
        .split('')
        .map((c) => (random(6) === 0 ? '?' : c))
        .join('');
      const instance = piece.replace(/\?/g, () => 'ab'[random(2)]!);
      // Sometimes broken by one character, so it shouldn't match there.
      const broken =
        random(3) === 0
          ? (() => {
              const at = random(instance.length);
              return `${instance.slice(0, at)}${instance[at] === 'a' ? 'b' : 'a'}${instance.slice(at + 1)}`;
            })()
          : instance;
      const text = `${pick('ab', random(40))}${broken}${pick('ab', random(40))}`;
      for (const pattern of [`*${piece}*`, `*${piece}`, `${piece}*`, `*a*${piece}*b`]) {
        expect({ text, pattern, result: wildcardMatch(text, pattern) }).toEqual({
          text,
          pattern,
          result: reference(text, pattern),
        });
      }
    }
  });

  it('finds a piece with ? that crosses a 32-bit word, at the very end', () => {
    const piece = `${'a'.repeat(31)}?${'b'.repeat(33)}`;
    const text = `${'x'.repeat(100)}${'a'.repeat(31)}Z${'b'.repeat(33)}${'y'.repeat(5)}`;
    expect(wildcardMatch(text, `*${piece}*`)).toBe(true);
    expect(wildcardMatch(text, `*${piece}`)).toBe(false);
    expect(wildcardMatch(`${text.slice(0, -5)}`, `x*${piece}`)).toBe(true);
    expect(wildcardMatch(text, `*${piece.replace('?', 'Q')}*`)).toBe(false);
  });

  it('finishes quickly against a huge value', () => {
    const value = 'a'.repeat(1024 * 1024);
    const started = performance.now();
    expect(wildcardMatch(value, `*${'a'.repeat(250)}b`)).toBe(false);
    expect(wildcardMatch(value, `*${'a'.repeat(250)}b*`)).toBe(false);
    expect(wildcardMatch(value, `*${'a'.repeat(120)}?${'a'.repeat(120)}b*`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
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

describe('more header term semantics', () => {
  it('!= fails if either side has the value, and looks at one side for reqheader', () => {
    const both = exchange({
      request: [['content-type', 'application/json']],
      response: [['content-type', 'text/html']],
    });
    expect(matches('header.content-type!=application/json', both)).toBe(false);
    expect(matches('header.content-type!=text/html', both)).toBe(false);
    expect(matches('reqheader.content-type!=text/html', both)).toBe(true);
    expect(matches('resheader.content-type!=application/json', both)).toBe(true);
    expect(matches('resheader.content-type!=text/*', both)).toBe(false);
  });

  it('several header terms can each be met by a different line or side', () => {
    expect(matches('header.set-cookie=a=1 header.set-cookie=session=*')).toBe(true);
    expect(matches('reqheader.authorization=* resheader.cache-control~private')).toBe(true);
    expect(matches('header.set-cookie=a=1 header.set-cookie=b=2')).toBe(false);
    expect(matches('reqheader.authorization=* resheader.authorization=*')).toBe(false);
  });

  it('negates header~, and a double negative is the positive', () => {
    expect(matches('-header~bearer')).toBe(false);
    expect(matches('-header~nowhere')).toBe(true);
    for (const value of ['req-42', 'other']) {
      expect(matches(`-header.x-request-id!=${value}`)).toBe(matches(`header.x-request-id=${value}`));
    }
  });

  it('takes names with digits and _', () => {
    const odd = exchange({ request: [['x_trace_2', 'on']] });
    expect(matches('header.x_trace_2=on', odd)).toBe(true);
    expect(matches('header.X_TRACE_2=ON', odd)).toBe(true);
  });

  it('handles a header with an empty value', () => {
    const empty = exchange({ request: [['x-empty', '']] });
    expect(matches('header.x-empty=*', empty)).toBe(true);
    expect(matches('header.x-empty~a', empty)).toBe(false);
    expect(matches('header.x-empty=?*', empty)).toBe(false);
    expect(matches('header~"x-empty: "', empty)).toBe(true);
  });

  it('takes operator characters inside values', () => {
    const odd = exchange({
      request: [
        ['x-a', '=y'],
        ['x-b', 'a<b'],
        ['x-c', '!=z'],
      ],
    });
    expect(matches('header.x-a==y', odd)).toBe(true);
    expect(matches('header.x-a!==y', odd)).toBe(false);
    expect(matches('header.x-a~=y', odd)).toBe(true);
    expect(matches('header.x-b=a<b', odd)).toBe(true);
    expect(matches('header.x-c=!=z', odd)).toBe(true);
  });

  it('keeps quoted spaces in values, without trimming', () => {
    const spaced = exchange({ request: [['x-s', 'a b']] });
    expect(matches('header.x-s="a b"', spaced)).toBe(true);
    expect(matches('header~" "', spaced)).toBe(true);
    expect(matches('header.x-s=" a b"', spaced)).toBe(false);
  });

  it('? stands for one UTF-16 unit, so an emoji takes two', () => {
    const emoji = exchange({ request: [['x-mood', 'ok😀']] });
    expect(matches('header.x-mood=ok??', emoji)).toBe(true);
    expect(matches('header.x-mood=ok?', emoji)).toBe(false);
    expect(matches('header.x-mood=ok*', emoji)).toBe(true);
  });

  it('accepts a ~ value of exactly the cap', () => {
    expect(errorsOf(`header~${'x'.repeat(MAX_HEADER_VALUE)}`)).toEqual([]);
    expect(errorsOf(`header.a~${'x'.repeat(MAX_HEADER_VALUE)}`)).toEqual([]);
  });
});

describe('more header term errors', () => {
  it('turns header with an operator but no name into an error, negated or not', () => {
    for (const term of ['header=foo', 'header!=x', 'header<5', 'reqheader>=1', '-header=x']) {
      const q = compileQuery(term);
      expect(q.errors).toHaveLength(1);
      expect(q.errors[0]).toContain('needs a header name');
      expect(q.hints).toEqual([]);
      expect(q.needsDetail).toBe(false);
      // Dropped: it filters nothing.
      expect(q.matches(summary)).toBe(true);
    }
  });

  it('needs a value or a name in the other forms too', () => {
    expect(errorsOf('header.x!=')).toEqual(['header.x!= needs a value']);
    expect(errorsOf('-header~')).toEqual(['header~ needs a value']);
    expect(errorsOf('header.!=x')).toEqual([
      'header.!= needs a header name: header.NAME=value, or header~text',
    ]);
  });

  it('a negated URL-like term gets its one hint, and is negated plain text', () => {
    const q = compileQuery('-header.a.b=c');
    expect(q.hints).toEqual([
      '"header.a.b=c" is searched as text: header names use letters, digits, - and _.',
    ]);
    expect(q.matches({ ...summary, url: 'https://x.test/header.a.b=c' })).toBe(false);
    expect(q.matches(summary)).toBe(true);
  });

  it('quotes don’t make a header term plain text', () => {
    expect(compileQuery('"header~x"').needsDetail).toBe(true);
    expect(compileQuery('"header.a=b"').needsDetail).toBe(true);
  });

  it('can still find such text in a URL through a field', () => {
    const odd = { ...summary, url: 'https://x.test/?header=foo&header~x&header.x=1', path: '/?header=foo' };
    for (const term of ['url~header=foo', 'path~header=foo', 'url~header~x', 'url~"header.x=1"']) {
      const q = compileQuery(term);
      expect(q.errors).toEqual([]);
      expect(q.needsDetail).toBe(false);
      expect(q.matches(odd)).toBe(true);
      expect(q.matches(summary)).toBe(false);
    }
  });

  it('near-misses aren’t header terms', () => {
    for (const term of ['headers~x', 'resheaders=1', 'preheader~x', 'xheader.a=1', 'header']) {
      const q = compileQuery(term);
      expect(q.needsDetail).toBe(false);
      expect(q.errors).toEqual([]);
    }
    // As on main: an unknown field name gets its usual hint.
    expect(compileQuery('headers~x').hints).toEqual([
      'No field called "headers", so "headers~x" is searched as text.',
    ]);
  });
});

describe('a search over the length limit', () => {
  const pad = (query: string) => `${query} ${'p'.repeat(MAX_QUERY_LENGTH)}`;

  it('still filters by its other terms', () => {
    const q = compileQuery(`host=api.* ${'z'.repeat(MAX_QUERY_LENGTH)}`);
    expect(q.matches({ ...summary, url: `https://api.example.com/${'z'.repeat(MAX_QUERY_LENGTH)}` })).toBe(
      true,
    );
    expect(q.matches(summary)).toBe(false);
  });

  it('drops negated header terms too, with one length error for several', () => {
    const q = compileQuery(pad('-header.a=* header~b resheader.c=d'));
    expect(q.needsDetail).toBe(false);
    expect(q.errors).toEqual(['The search is too long for header terms: 4,096 characters at most.']);
  });

  it('reports a header term’s own error as well', () => {
    const q = compileQuery(pad('header=x header~y'));
    expect(q.errors).toEqual([
      'header= needs a header name: header.NAME=value, or header~text',
      'The search is too long for header terms: 4,096 characters at most.',
    ]);
  });
});

describe('compileFilter with header terms', () => {
  const json = exchange({ request: [['x-a', '1']] });
  const html = exchange({ request: [['x-a', '1']], summary: { contentType: 'text/html' } });

  it('passes on needsDetail, errors and hints', () => {
    const f = compileFilter('header~x header=y header.a.b=c', 'json');
    expect(f.needsDetail).toBe(true);
    expect(f.errors).toHaveLength(1);
    expect(f.hints).toHaveLength(1);
  });

  it('applies the quick filter to summaries and to details', () => {
    const f = compileFilter('header.x-a=1', 'json');
    expect(f.matches(json.summary)).toBe(true);
    expect(f.matches(html.summary)).toBe(false);
    expect(f.matchesDetail(json)).toBe(true);
    expect(f.matchesDetail(html)).toBe(false);
    expect(compileFilter('header.x-a=2', 'json').matchesDetail(json)).toBe(false);
    expect(compileFilter('header.x-a=1', 'all').matchesDetail(html)).toBe(true);
  });
});
