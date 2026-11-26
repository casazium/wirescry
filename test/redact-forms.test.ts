/**
 * Credentials written in common forms the name and URL rules used to miss: a scheme and a
 * credential under a token name in JSON (`"auth": "ApiKey <key>"`), a token as a URL's user name,
 * a URL written inside another URL (in its path, plain or percent-encoded, its query or its
 * fragment), and an API key in a query or form field named just `key`. Found by an independent
 * review of 0.1.40 (F7, the name and URL rules).
 */
import { describe, expect, it } from 'vitest';
import { collectKnown, redactHarEntry } from '../src/backend/har-redact';
import { maskBytes } from '../src/backend/mask-body';
import { KnownValues, redactBody } from '../src/shared/redact-body';
import { applySpans, REDACTED, redactUrl } from '../src/shared/redact';
import { expectGrowthUnder, timeOnce as once } from './timing';

// Fake secrets, built at run time so the file itself holds nothing a secret scanner flags.
const SECRET = 'Zq9x' + 'Tk7Lm2Pw4Rt8Vn6Yb3';
const OTHER = 'Hw3c' + 'Jd8Fs1Qa5Ue9Gk2Xo7';
const THIRD = 'Pm4v' + 'Ry6Ct2Ln9Bd5Kx8Ws1';
/** An AWS access key ID's shape (AWS's documented example). */
const AWS_KEY_ID = 'AKIA' + 'IOSFODNN7EXAMPLE';
const rep = (s: string, n: number) => s.repeat(n);
const R = REDACTED;

const redact = (text: string, type: string, known = new KnownValues()) =>
  applySpans(text, redactBody(text, type, known).spans);
const json = (text: string, known?: KnownValues) => redact(text, 'application/json', known);
const url = (text: string, known?: KnownValues) => redactUrl(text, known).url;
/** Whether `value` was learned: found again standing alone in a body. */
const learned = (known: KnownValues, value: string) => json(`{"log":"${value}"}`, known) === `{"log":"${R}"}`;

describe('a scheme and a credential under a token name in JSON', () => {
  it.each([
    [`{"auth":"ApiKey ${SECRET}"}`, `{"auth":"ApiKey ${R}"}`],
    [`{"credentials":"svc ${SECRET}"}`, `{"credentials":"svc ${R}"}`],
    [`{"authorization":"Token ${SECRET}"}`, `{"authorization":"Token ${R}"}`],
    [`{"sessionToken":"v2 ${SECRET}"}`, `{"sessionToken":"v2 ${R}"}`],
    [`{"session":"sid ${SECRET}"}`, `{"session":"sid ${R}"}`],
    // Spaces around it, and a tab or a line break between; escapes before it are kept as written.
    [`{"auth":" ApiKey  ${SECRET} "}`, `{"auth":" ApiKey  ${R} "}`],
    [`{"auth":"ApiKey\\t${SECRET}"}`, `{"auth":"ApiKey\\t${R}"}`],
    [`{"auth":"ApiKey\\n${SECRET}"}`, `{"auth":"ApiKey\\n${R}"}`],
    [`{"auth":"ApiKey\\u0020${SECRET}"}`, `{"auth":"ApiKey\\u0020${R}"}`],
    // The credential may itself hold escapes, and base64's `+`, `/` and `=`.
    [`{"auth":"ApiKey ${SECRET}\\/x"}`, `{"auth":"ApiKey ${R}"}`],
    [`{"auth":"ApiKey ${SECRET}+/=="}`, `{"auth":"ApiKey ${R}"}`],
    // Nested under a token-named object.
    [`{"auth":{"value":"ApiKey ${SECRET}"}}`, `{"auth":{"value":"ApiKey ${R}"}}`],
    // A credential of exactly 16 characters, the fewest allowed.
    [`{"auth":"ApiKey a1b2c3d4e5f6g7h8"}`, `{"auth":"ApiKey ${R}"}`],
    // A credential with dots or a tilde; a scheme word with `-`, `_` or `.`.
    [`{"auth":"ApiKey ${SECRET}.${OTHER}"}`, `{"auth":"ApiKey ${R}"}`],
    [`{"auth":"ApiKey ${SECRET}~1"}`, `{"auth":"ApiKey ${R}"}`],
    [`{"auth":"X-Key ${SECRET}"}`, `{"auth":"X-Key ${R}"}`],
    [`{"auth":"api_key.v2 ${SECRET}"}`, `{"auth":"api_key.v2 ${R}"}`],
    // A scheme word of 32 characters, the most allowed.
    [`{"auth":"${rep('A', 32)} ${SECRET}"}`, `{"auth":"${rep('A', 32)} ${R}"}`],
  ])('redacts the credential in %s, keeping the scheme', (text, expected) => {
    expect(json(text)).toBe(expected);
  });

  it('records it under its name', () => {
    const text = `{"auth":"ApiKey ${SECRET}"}`;
    expect(redactBody(text, 'application/json', new KnownValues()).records).toEqual([
      { name: 'auth', count: 1 },
    ]);
  });

  it('redacts a credential too long to judge (past 4,096 characters), even if it looks like a word', () => {
    expect(json(`{"auth":"x ${rep('b', 4_097)}"}`)).toBe(`{"auth":"x ${R}"}`);
    expect(json(`{"auth":"x ${rep('b', 4_096)}"}`)).toBe(`{"auth":"x ${rep('b', 4_096)}"}`);
  });

  it('handles a credential megabytes long without failing', () => {
    const text = `{"auth":"x ${rep('A1', 3_000_000)}","password":"${SECRET}"}`;
    expect(json(text)).toBe(`{"auth":"x ${R}","password":"${R}"}`);
  });

  it('still looks for token shapes and known values in the whole string', () => {
    // A shape in the scheme's place.
    expect(json(`{"auth":"${AWS_KEY_ID} ${OTHER}"}`)).toBe(`{"auth":"${R} ${R}"}`);
    // A known value in the scheme's place.
    const known = new KnownValues();
    json(`{"password":"${SECRET}"}`, known);
    expect(json(`{"auth":"${SECRET} ${OTHER}"}`, known)).toBe(`{"auth":"${R} ${R}"}`);
  });

  it('learns a bearer token under a session or inherited name, as before', () => {
    expect(json(`{"session":"Bearer ${SECRET}","log":"${SECRET}"}`)).toBe(
      `{"session":"Bearer ${R}","log":"${R}"}`,
    );
    expect(json(`{"auth":{"value":"Bearer ${SECRET}"},"log":"${SECRET}"}`)).toBe(
      `{"auth":{"value":"Bearer ${R}"},"log":"${R}"}`,
    );
  });

  it('learns the credential, so it is found again elsewhere in the body', () => {
    expect(json(`{"auth":"ApiKey ${SECRET}","log":"sent ${SECRET}"}`)).toBe(
      `{"auth":"ApiKey ${R}","log":"sent ${R}"}`,
    );
  });

  it('learns the credential only under its own name, not one it is nested under', () => {
    expect(json(`{"auth":{"value":"ApiKey ${SECRET}"},"log":"${SECRET}"}`)).toBe(
      `{"auth":{"value":"ApiKey ${R}"},"log":"${SECRET}"}`,
    );
  });

  it('does not learn a dotted credential, though it redacts it', () => {
    expect(json(`{"auth":"ApiKey ${SECRET}.${OTHER}","log":"${SECRET}.${OTHER}"}`)).toBe(
      `{"auth":"ApiKey ${R}","log":"${SECRET}.${OTHER}"}`,
    );
  });

  it('does not learn a credential that is not one run of token characters', () => {
    const known = new KnownValues();
    json(`{"auth":"ApiKey ${SECRET}+/=="}`, known);
    expect(learned(known, `${SECRET}+/==`)).toBe(false);
  });

  it.each([
    // A language model's tokens and plain words stay.
    `{"token":" Hello world"}`,
    `{"auth":"not required"}`,
    `{"auth":"ApiKey short1"}`,
    `{"auth":"ApiKey a1b2c3d4e5f6g7h"}`,
    `{"auth":"ApiKey 1234567890123456"}`,
    // A scheme word starts with a letter.
    `{"auth":"2fa ${SECRET}"}`,
    // More than one word, however long.
    `{"auth":"a b ${rep('c', 4_097)}"}`,
    `{"auth":"ApiKey abcdefghijklmnop"}`,
    `{"token":"is JavaScript2015"}`,
    `{"token":"Hello wonderful-world!"}`,
    `{"session":"Expires 20261126"}`,
    `{"session":"expires 2026-11-26T00:00:00Z"}`,
    `{"session":"User bob.smith2024@example.com"}`,
    // Three words or more read as prose, not a scheme and a credential.
    `{"token":"see ApiKey ${SECRET}"}`,
    `{"auth":"ApiKey ${SECRET} extra"}`,
    // A scheme word of 33 characters is too long to be one.
    `{"auth":"${rep('A', 33)} ${SECRET}"}`,
    // A name that isn't a secret's.
    `{"note":"ApiKey ${SECRET}"}`,
    // A name about tokens, not holding one.
    `{"token_type":"ApiKey ${SECRET}"}`,
  ])('keeps %s', (text) => {
    expect(json(text)).toBe(text);
  });

  it('still redacts a password with spaces whole', () => {
    expect(json(`{"password":"correct horse ${SECRET}"}`)).toBe(`{"password":"${R}"}`);
  });
});

describe('a token as a URL’s user name', () => {
  it.each([
    [`https://${SECRET}@git.example/r.git`, `https://${R}@git.example/r.git`],
    [`https://${SECRET}:x-oauth-basic@github.example/o/r`, `https://${R}:${R}@github.example/o/r`],
    [`//${SECRET}@git.example/r`, `//${R}@git.example/r`],
    [`https://${SECRET}@git.example`, `https://${R}@git.example`],
    [`https://${SECRET}@git.example?x=1`, `https://${R}@git.example?x=1`],
    [`https://${SECRET}@[::1]:8080/x`, `https://${R}@[::1]:8080/x`],
    // Exactly 16 characters, with letters and digits.
    ['https://a1b2c3d4e5f6g7h8@h.example/', `https://${R}@h.example/`],
    // 24 of mixed case, no digits.
    ['https://abcdefghijklMNOPQRSTUVWX@h.example/', `https://${R}@h.example/`],
    // `@` in the password: the authority's last `@` ends it.
    [`https://bob:p@ss${SECRET}@h.example/`, `https://bob:${R}@h.example/`],
  ])('redacts %s', (text, expected) => {
    expect(url(text)).toBe(expected);
  });

  it.each([
    'https://bob@git.example/',
    'https://john.smith@h.example/',
    'https://deploy-user-for-ci@h.example/',
    'https://user1@h.example/',
    // 15 characters: one short.
    'https://a1b2c3d4e5f6g7h@h.example/',
    // Digits only, letters of one case only, 23 of mixed case.
    'https://1234567890123456@h.example/',
    'https://abcdefghijklmnopqrstuvwx@h.example/',
    'https://abcdefghijkLMNOPQRSTUVW@h.example/',
    // An email or a dotted name, however long, decoded first.
    'https://a1b2c3d4e5f6g7h8%40corp@h.example/',
    `https://${SECRET}%2E@h.example/`,
    'https://john.smith2024%40example.com@h.example/',
    'https://first.last.20241126@h.example/',
    // `@` in the path, not the authority.
    `https://h.example/users/@${SECRET}`,
    `https://h.example/a/b:c@${SECRET}`,
    'https://h.example/users/bob@example.com',
  ])('keeps %s', (text) => {
    expect(url(text)).toBe(text);
  });

  it('keeps a person’s user name but redacts the password', () => {
    expect(url(`https://bob:${SECRET}@h.example/`)).toBe(`https://bob:${R}@h.example/`);
  });

  it('records it as a URL user name', () => {
    expect(redactUrl(`https://${SECRET}@git.example/r.git`).records).toEqual([
      { kind: 'URL user name', count: 1 },
    ]);
  });

  it('learns a user name that looks like a credential, so it is found again in a body', () => {
    const known = new KnownValues();
    url(`https://${SECRET}@git.example/r.git`, known);
    expect(learned(known, SECRET)).toBe(true);
  });

  it('does not learn a user name that is only token-like', () => {
    const known = new KnownValues();
    url('https://deploy-user-for-ci2@h.example/', known);
    url('https://abcdefghijklMNOPQRSTUVWX@h.example/', known);
    expect(known.size).toBe(0);
  });
});

describe('a URL written inside another URL', () => {
  it.each([
    [
      `https://a.example/proxy/https://bob:${SECRET}@b.example/`,
      `https://a.example/proxy/https://bob:${R}@b.example/`,
    ],
    [`/proxy/https://bob:${SECRET}@b.example/x`, `/proxy/https://bob:${R}@b.example/x`],
    [`https://a.example/p/https://${SECRET}@b.example/`, `https://a.example/p/https://${R}@b.example/`],
    // Ending the path, then a query or a fragment.
    [`https://a.example/p/https://bob:${SECRET}@b.example`, `https://a.example/p/https://bob:${R}@b.example`],
    [
      `https://a.example/p/https://bob:${SECRET}@b.example?y=1`,
      `https://a.example/p/https://bob:${R}@b.example?y=1`,
    ],
    [
      `https://a.example/p/https://bob:${SECRET}@b.example#f`,
      `https://a.example/p/https://bob:${R}@b.example#f`,
    ],
    // Two of them, and two or three written one after another with no `/` between.
    [
      `/p/https://a:${SECRET}@b.example/q/http://c:${OTHER}@d.example/`,
      `/p/https://a:${R}@b.example/q/http://c:${R}@d.example/`,
    ],
    [`/p/https://a:${SECRET}@bhttp://c:${OTHER}@d.example/`, `/p/https://a:${R}@bhttp://c:${R}@d.example/`],
    [
      `https://a.example/p/https://a:${SECRET}@bhttp://c:${OTHER}@dhttp://e:${THIRD}@f.example/`,
      `https://a.example/p/https://a:${R}@bhttp://c:${R}@dhttp://e:${R}@f.example/`,
    ],
    // Inside an outer URL that has credentials of its own.
    [
      `https://u:${OTHER}@a.example/p/https://bob:${SECRET}@b.example/`,
      `https://u:${R}@a.example/p/https://bob:${R}@b.example/`,
    ],
    // In a fragment's route, and in a query with no name.
    [
      `https://a.example/p#/route/https://bob:${SECRET}@c.example/`,
      `https://a.example/p#/route/https://bob:${R}@c.example/`,
    ],
    [
      `https://a.example/p?https://bob:${SECRET}@c.example/`,
      `https://a.example/p?https://bob:${R}@c.example/`,
    ],
    // Percent-encoded in the path: the segment is redacted whole.
    [`https://a.example/proxy/https%3A%2F%2Fbob:${SECRET}@b.example/x`, `https://a.example/proxy/${R}/x`],
    [`https://a.example/proxy/https%3a%2f%2fbob%3A${SECRET}%40b.example%2F`, `https://a.example/proxy/${R}`],
    [`https://a.example/proxy/https:%2F%2Fbob:${SECRET}@b.example/x`, `https://a.example/proxy/${R}/x`],
    [`https://a.example/proxy/https%3A%2F%2F${SECRET}%40b.example`, `https://a.example/proxy/${R}`],
    // Half encoded.
    [`https://a.example/proxy/https%3A//bob:${SECRET}@b.example/x`, `https://a.example/proxy/${R}/x`],
    [`https://a.example/proxy/https:/%2Fbob:${SECRET}@b.example/x`, `https://a.example/proxy/${R}/x`],
    [`https://a.example/proxy/https%3A/%2Fbob:${SECRET}@b.example/x`, `https://a.example/proxy/${R}/x`],
    [`https://a.example/proxy/https%3A%2F/bob:${SECRET}@b.example/x`, `https://a.example/proxy/${R}/x`],
    [`https://a.example/proxy/https:%2F/bob:${SECRET}@b.example/x`, `https://a.example/proxy/${R}/x`],
    // After a harmless encoded URL in the same segment, from where that one ends.
    [
      `https://a.example/p/https%3A%2F%2Fy.example,https%3A%2F%2Fbob:${SECRET}@b/tail`,
      `https://a.example/p/https%3A%2F%2Fy.example,${R}/tail`,
    ],
    // From the segment's start; ending at the query or fragment, even before a later `/`.
    [`https://a.example/p/prefix,https%3A%2F%2Fbob:${SECRET}@h.example`, `https://a.example/p/${R}`],
    [`https://a.example/p/https%3A%2F%2Fbob:${SECRET}@h?x=1/2`, `https://a.example/p/${R}?x=1/2`],
    [`https://a.example/p/https%3A%2F%2Fbob:${SECRET}@h#x/2`, `https://a.example/p/${R}#x/2`],
    // Two or three one after another, each its own.
    [`/proxy/https%3A%2F%2Fa:${SECRET}@bhttp%3A%2F%2Fc:${OTHER}@d/x`, `/proxy/${R}${R}/x`],
    [
      `/proxy/https%3A%2F%2Fa:${SECRET}@bhttp%3A%2F%2Fc:${OTHER}@dhttp%3A%2F%2Fe:${THIRD}@f/x`,
      `/proxy/${R}${R}${R}/x`,
    ],
    // Encoded twice: decoded once, its query value holds the rest.
    [
      `https://a.example/p/https%3A%2F%2Fh.example%2F%3Fu%3Dhttps%253A%252F%252Fbob%253A${SECRET}%2540c`,
      `https://a.example/p/${R}`,
    ],
    // A token shape inside the decoded URL.
    [
      'https://a.example/p/https%3A%2F%2Fhooks.slack.com%2Fservices%2FT00000000%2FB00000000%2FXXXXXXXXXXXXXXXXXXXXXXXX',
      `https://a.example/p/${R}`,
    ],
  ])('redacts %s', (text, expected) => {
    expect(url(text)).toBe(expected);
  });

  it.each([
    'https://a.example/proxy/https://b.example/x',
    'https://a.example/p/https://b.example/a:b@c',
    'https://a.example/p/https://bob@b.example/',
    'https://a.example/p/://',
    'https://a.example/proxy/https%3A%2F%2Fb.example%2Fx',
    'https://a.example/proxy/https%3A%2F%2Fbob%40b.example',
    'https://a.example/p#/route/https://c.example/x',
    // The authority ends at `&`, `?` or `#`: a later `@` is not its.
    'https://a.example/?a=https://h.example&email=bob:x@y.example',
    'https://a.example/p/https://h.example?email=a:b@c.example',
    'https://a.example/p/https://h.example#a:b@c.example',
    'https://a.example/?redirect_uri=https://app.example/cb&state=x&login=bob@example.com',
    'https://a.example/p#mailto:bob@example.com',
    'https://a.example/p#user@host',
    'https://a.example/files/bob%40example.com/report.pdf',
    // An encoded URL with nothing secret in it.
    'https://a.example/p/https%3A%2F%2Fh.example%2Fx%3Fq%3D1',
  ])('keeps %s', (text) => {
    expect(url(text)).toBe(text);
  });

  it('records an encoded segment and a fragment route', () => {
    expect(redactUrl(`https://a.example/proxy/https%3A%2F%2Fbob:${SECRET}@b.example/x`).records).toEqual([
      { kind: 'encoded', count: 1 },
    ]);
    expect(redactUrl(`https://a.example/p#/route/https://bob:${SECRET}@c.example/`).records).toEqual([
      { kind: 'URL password', count: 1 },
    ]);
  });

  it('learns a password from a URL written inside another, plain or encoded', () => {
    for (const text of [
      `https://a.example/p/https://bob:${SECRET}@b.example/`,
      `https://a.example/p/https%3A%2F%2Fbob:${SECRET}@b.example/`,
    ]) {
      const known = new KnownValues();
      url(text, known);
      expect(learned(known, SECRET)).toBe(true);
    }
  });

  it('counts a URL in a query value once', () => {
    const { url: out, records } = redactUrl(`https://a.example/?next=https://bob:${SECRET}@b.example/`);
    expect(out).toBe(`https://a.example/?next=https://bob:${R}@b.example/`);
    expect(records).toEqual([{ kind: 'URL password', count: 1 }]);
  });

  it('records each kind and count', () => {
    const { records } = redactUrl(`https://${SECRET}@a.example/p/https://${SECRET}@b.example/?key=${OTHER}`);
    expect(records).toEqual([
      { kind: 'URL user name', count: 2 },
      { name: 'key', count: 1 },
    ]);
  });

  it.each([
    [
      'text',
      `see https://a.example/proxy/https://bob:${SECRET}@b.example/ now`,
      `see https://a.example/proxy/https://bob:${R}@b.example/ now`,
      'text/plain',
    ],
    [
      'escaped text',
      `u = "https:\\/\\/a.example\\/proxy\\/https:\\/\\/bob:${SECRET}@b.example\\/";`,
      `u = "https:\\/\\/a.example\\/proxy\\/https:\\/\\/bob:${R}@b.example\\/";`,
      'application/javascript',
    ],
    [
      'JSON with \\u002f',
      `{"u":"https:\\u002f\\u002fa.example\\u002fp\\u002fhttps:\\u002f\\u002fbob:${SECRET}@b.example\\u002f"}`,
      `{"u":"https:\\u002f\\u002fa.example\\u002fp\\u002fhttps:\\u002f\\u002fbob:${R}@b.example\\u002f"}`,
      'application/json',
    ],
  ])('redacts it in a URL found in %s', (_where, text, expected, type) => {
    expect(redact(text, type)).toBe(expected);
  });
});

describe('a query or form field named just key', () => {
  it.each([
    [`https://a.example/v1?key=${SECRET}`, `https://a.example/v1?key=${R}`],
    [`https://a.example/v1?Key=${SECRET}&q=1`, `https://a.example/v1?Key=${R}&q=1`],
    [`https://a.example/v1?q=1&KEY=${SECRET}`, `https://a.example/v1?q=1&KEY=${R}`],
    [`https://a.example/v1?q=1&amp;key=${SECRET}`, `https://a.example/v1?q=1&amp;key=${R}`],
    [`https://a.example/v1?k%65y=${SECRET}`, `https://a.example/v1?k%65y=${R}`],
    [`https://a.example/v1#key=${SECRET}`, `https://a.example/v1#key=${R}`],
    [`https://a.example/v1;key=${SECRET}/x`, `https://a.example/v1;key=${R}/x`],
    ['https://a.example/v1?key=item1234', `https://a.example/v1?key=${R}`],
    // Judged decoded: `%2D` is `-`.
    [`https://a.example/v1?key=AIza%2D${SECRET}`, `https://a.example/v1?key=${R}`],
    // Too long to judge.
    [`https://a.example/v1?key=${rep('b', 4_097)}`, `https://a.example/v1?key=${R}`],
    // `=`, `_` and `+` (encoded, so not a space) are an API key's characters.
    [`https://a.example/v1?key=${SECRET}%3D%3D`, `https://a.example/v1?key=${R}`],
    [`https://a.example/v1?key=AIza_${SECRET}`, `https://a.example/v1?key=${R}`],
    [`https://a.example/v1?key=Ab%2B${SECRET}`, `https://a.example/v1?key=${R}`],
    // Base64, with `/` encoded or not and `+` written as is.
    [
      `https://a.example/v1?key=wJalrXUtnFEMI%2FK7MDENG%2FbPxRfiCYEXAMPLEKEY`,
      `https://a.example/v1?key=${R}`,
    ],
    [`https://a.example/v1?key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, `https://a.example/v1?key=${R}`],
    ['https://a.example/v1?key=AbCd+1234efgh5678', `https://a.example/v1?key=${R}`],
    // 16 characters of base64, the fewest.
    ['https://a.example/v1?key=AbCd+1234efgh567', `https://a.example/v1?key=${R}`],
    // `+` and `=` decoded from escapes, and a value with a line break.
    ['https://a.example/v1?key=a1b2%2Bc3d4', `https://a.example/v1?key=${R}`],
    ['https://a.example/v1?key=abcd1234%3D', `https://a.example/v1?key=${R}`],
    ['https://a.example/v1?key=abcd1234efgh%0A', `https://a.example/v1?key=${R}`],
    ['https://a.example/v1?key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY%0A', `https://a.example/v1?key=${R}`],
    // Base64 with padding.
    ['https://a.example/v1?key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKE==', `https://a.example/v1?key=${R}`],
    // A line break or spaces around it are trimmed.
    [`https://a.example/v1?key=${SECRET}%0A`, `https://a.example/v1?key=${R}`],
  ])('redacts %s', (text, expected) => {
    expect(url(text)).toBe(expected);
  });

  it.each([
    'https://a.example/v1?key=name',
    'https://a.example/v1?key=12345678901234567890',
    'https://a.example/v1?key=search-term',
    'https://a.example/v1?key=sort_by_created_at',
    'https://a.example/v1?key=uploads/2026/photo1.jpg',
    'https://a.example/v1?key=bob.smith2024@example.com',
    'https://a.example/v1?key=2026-11-26T00:00:00Z',
    'https://a.example/v1?key=Hello+wonderful+world',
    // Paths and phrases whose parts are words with digits after them.
    'https://a.example/v1?key=Hello+wonderful+world2',
    'https://a.example/v1?key=uploads/User123/Avatar',
    'https://a.example/v1?key=Reports/Q3/2026/Summary',
    'https://a.example/v1?key=New+York+City+2024',
    'https://a.example/v1?key=Uploads/2026/Photo1.jpg',
    'https://a.example/v1?key=Uploads/User_123/Avatar-1',
    'https://a.example/v1?key=a1b2c3d',
    'https://a.example/v1?key=uploads/2026/photo1',
    // Base64's look needs both cases and digits.
    'https://a.example/v1?key=abc/def+12345678==',
    'https://a.example/v1?key=ABCD/EFGH/1234/5678',
    // 15 characters of base64: one short.
    'https://a.example/v1?key=AbCd+1234efgh56',
    'https://a.example/v1?key=feature.flags.checkout-v2',
    `https://a.example/v1?key=${rep('b', 4_096)}`,
    'https://a.example/v1?key=',
    'https://a.example/v1?key=a1',
    `https://a.example/v1?monkey=${SECRET}`,
    `https://a.example/v1?keyword=${SECRET}`,
    `https://a.example/v1?key_type=${SECRET}`,
    `https://a.example/v1?keys=${SECRET}`,
  ])('keeps %s', (text) => {
    expect(url(text)).toBe(text);
  });

  it('learns only values that look like credentials', () => {
    const known = new KnownValues();
    url(`https://a.example/v1?key=${SECRET}`, known);
    url('https://a.example/v1?key=item1234', known);
    url('https://a.example/v1?key=550e8400e29b41d4a716446655440000a1', known);
    url('https://a.example/v1?key=550e8400-e29b-41d4-a716-446655440000', known);
    expect(learned(known, SECRET)).toBe(true);
    expect(learned(known, 'item1234')).toBe(false);
    expect(learned(known, '550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(known.size).toBe(2);
  });

  it('learns neither base64 nor a value too long to judge', () => {
    const known = new KnownValues();
    url('https://a.example/v1?key=wJalrXUtnFEMI%2FK7MDENG%2FbPxRfiCYEXAMPLEKEY', known);
    url(`https://a.example/v1?key=${rep('A1', 2_049)}`, known);
    expect(known.size).toBe(0);
  });

  it('learns a value of 20 characters, the fewest', () => {
    const known = new KnownValues();
    url('https://a.example/v1?key=Ab1defghijklmnopqrst', known);
    url('https://a.example/v1?key=Ab1defghijklmnopqrs', known);
    expect(learned(known, 'Ab1defghijklmnopqrst')).toBe(true);
    expect(known.size).toBe(1);
  });

  it('learns a value with a line break, trimmed', () => {
    const known = new KnownValues();
    url(`https://a.example/v1?key=${SECRET}%0A`, known);
    expect(learned(known, SECRET)).toBe(true);
  });

  it('redacts it in a form body, and keeps a plain word', () => {
    expect(redact(`key=${SECRET}&a=1&key=name`, 'application/x-www-form-urlencoded')).toBe(
      `key=${R}&a=1&key=name`,
    );
  });

  const part = (extra: string, value = SECRET) =>
    `--X\r\nContent-Disposition: form-data; name="key"${extra}\r\n\r\n${value}\r\n--X--\r\n`;
  const MULTIPART = 'multipart/form-data; boundary=X';

  it('redacts it in a multipart field, but not in a file part', () => {
    expect(redact(part(''), MULTIPART)).toBe(part('').replace(SECRET, R));
    expect(redact(part('\r\nContent-Type: text/plain'), MULTIPART)).toBe(
      part('\r\nContent-Type: text/plain').replace(SECRET, R),
    );
    // A file's contents are read by the file's own rules: a bare string in a text file is kept.
    expect(redact(part('; filename="k.txt"'), MULTIPART)).toBe(part('; filename="k.txt"'));
    // An S3 upload's object key is a path, kept.
    expect(redact(part('', 'uploads/2026/photo1.jpg'), MULTIPART)).toBe(part('', 'uploads/2026/photo1.jpg'));
    // Base64, as written.
    expect(redact(part('', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'), MULTIPART)).toBe(
      part('', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY').replace(
        'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        R,
      ),
    );
  });

  it('does not learn a multipart value that only looks like a key', () => {
    const known = new KnownValues();
    expect(redact(part('', 'photo_2026'), MULTIPART, known)).toBe(part('', R));
    expect(known.size).toBe(0);
  });

  it('learns a multipart field’s value, trimmed', () => {
    const known = new KnownValues();
    redact(part('', ` ${SECRET} `), MULTIPART, known);
    expect(learned(known, SECRET)).toBe(true);
  });

  it('keeps a JSON key named key: the rule is for queries and forms', () => {
    expect(json(`{"key":"${SECRET}"}`)).toBe(`{"key":"${SECRET}"}`);
  });
});

describe('where it shows', () => {
  const URL_WITH_ALL = `https://${OTHER}@a.example/proxy/https://bob:${SECRET}@b.example/v1?key=${THIRD}`;
  const BODY = `{"auth":"ApiKey ${SECRET}"}`;

  it('in a redacted HAR export: the URL, its query string and the body', () => {
    const entry = {
      startedDateTime: '2026-11-26T00:00:00.000Z',
      time: 1,
      request: {
        method: 'POST',
        url: URL_WITH_ALL,
        httpVersion: 'HTTP/1.1',
        headers: [],
        queryString: [{ name: 'key', value: THIRD }],
        postData: { mimeType: 'application/json', text: BODY },
      },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [],
        content: { size: 2, mimeType: 'application/json', text: '{}' },
      },
      timings: { send: 0, wait: 1, receive: 0 },
    };
    const known = new KnownValues();
    collectKnown(entry, known);
    const out = redactHarEntry(
      entry,
      { cut: { request: false, response: false }, base64Frames: [] } as never,
      known,
    );
    const text = JSON.stringify(out);
    for (const secret of [SECRET, OTHER, THIRD]) expect(text).not.toContain(secret);
    expect(text).toContain('ApiKey ' + R);
    expect(text).toContain(`"name":"key","value":"${R}"`);
  });

  it('with Hide Secrets and to agents (the masked body)', () => {
    const masked = maskBytes(new TextEncoder().encode(BODY), 'application/json', false, new KnownValues());
    expect('bytes' in masked).toBe(true);
    const shown = new TextDecoder().decode((masked as { bytes: Uint8Array }).bytes);
    expect(shown).not.toContain(SECRET);
    expect(shown).toContain('ApiKey ');
  });

  it('in the URL the window and agents show', () => {
    expect(url(URL_WITH_ALL)).toBe(`https://${R}@a.example/proxy/https://bob:${R}@b.example/v1?key=${R}`);
  });
});

describe('time', () => {
  it.each([
    ['many URLs in a path', (n: number) => 'https://a.example/' + rep('x://', n)],
    ['many URLs in a path, each with @', (n: number) => 'https://a.example/' + rep('a://b@', n)],
    ['many URLs in a path, each with :', (n: number) => 'https://a.example/' + rep('a://b:c', n) + '@'],
    ['many URLs in a path, with slashes', (n: number) => 'https://a.example/' + rep('/h://u:p@h', n)],
    ['many URLs in a fragment', (n: number) => 'https://a.example/#' + rep('h://u:p@h', n)],
    ['many URLs in a query', (n: number) => 'https://a.example/?' + rep('next=h://u:p@h&', n / 4)],
    ['many encoded URLs in a path', (n: number) => 'https://a.example/' + rep('h%3A%2F%2Fu:p@h', n / 2)],
    ['an encoded URL with a long tail', (n: number) => 'https://a.example/h%3A%2F%2F' + rep('a', n * 4)],
    ['a long user name', (n: number) => 'https://' + rep('a', n) + '@h.example/'],
    ['many key fields', (n: number) => 'https://a.example/?' + rep(`key=${SECRET}&`, n / 20)],
  ])('stays linear on %s', { timeout: 60_000 }, (_what, make) => {
    const run = (text: string) => () => redactUrl(text, new KnownValues());
    let n = 2_000;
    run(make(n))();
    while (once(run(make(n))) < 10 && make(n).length < 2_000_000) n *= 2;
    expectGrowthUnder(run(make(n)), run(make(n * 8)), 20);
  });

  it.each([
    ['a long scheme value', (n: number) => `{"auth":"ApiKey ${rep('A1', n / 2)} b"}`],
    ['many scheme values', (n: number) => `[${rep(`{"auth":"ApiKey ${SECRET}"},`, n / 30)}1]`],
    ['spaces after the scheme', (n: number) => `{"auth":"ApiKey${rep(' ', n)}x"}`],
    ['spaces before the scheme', (n: number) => `{"auth":"${rep(' ', n)}ApiKey ${SECRET}"}`],
  ])('stays linear on %s', { timeout: 60_000 }, (_what, make) => {
    const run = (text: string) => () => redactBody(text, 'application/json', new KnownValues());
    let n = 2_000;
    run(make(n))();
    while (once(run(make(n))) < 10 && make(n).length < 2_000_000) n *= 2;
    expectGrowthUnder(run(make(n)), run(make(n * 8)), 20);
  });
});
