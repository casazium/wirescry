import { describe, expect, it } from 'vitest';
import { expectGrowthUnder, timeOnce as once } from './timing';
import {
  applySpans,
  distinctive,
  mergeSpans,
  nameWords,
  REDACTED,
  redactAuthorization,
  redactCookieHeader,
  redactHeader,
  redactHeaders,
  redactSetCookie,
  redactUrl,
  secretName,
  shapeSpans,
  textSpans,
  urlInTextSpans,
  type ValueSink,
} from '../src/shared/redact';

// Fake tokens, built at run time so the file itself holds nothing a secret scanner flags.
const rep = (s: string, n: number): string => s.repeat(n);
const JWT = `eyJ${'hbGciOiJIUzI1NiJ9'}.eyJ${'zdWIiOiIxMjM0NTY3ODkwIn0'}.${'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'}`;
const JWE = `eyJ${'hbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0'}..${'AxY8DCtDaGlsbGljb3RoZQ'}.${'KDlTtXchhZTGufMYmOYGS4HffxPSUrfmqCHXaI9wOGY'}.${'Mz-VPPyU4RlcuYv1IwIvzw'}`;
const GH = 'ghp_' + rep('aB3', 12);
const GH_PAT = 'github_pat_' + rep('A1b', 10);
const GLPAT = 'glpat-' + rep('xY9', 7);
const AKIA = 'AKIA' + rep('Z7', 8);
const GOOGLE = 'AIza' + rep('Sy3', 11) + 'Ab';
const YA29 = 'ya29.' + rep('a0A', 10);
const GOCSPX = 'GOCSPX-' + rep('k8L', 8);
const SLACK_B = 'xoxb-' + '1234-5678-' + rep('aBc', 6);
const SLACK_C = 'xoxc-' + rep('9z', 12);
const SLACK_E = 'xoxe.xoxp-' + rep('1a', 12);
const XAPP = 'xapp-' + rep('1-A', 6);
const XAPP_ROTATING = 'xoxe.' + 'xapp-' + rep('1-B', 6);
const GHS_2026 =
  'ghs_' + '123456_' + `eyJ${'hbGciOiJSUzI1NiJ9'}.eyJ${'pc3MiOiIxMjM0NTYifQ'}.${'c2lnbmF0dXJlLXBhcnQ'}`;
const STRIPE = 'sk_' + 'live_' + rep('4eC3', 6);
const STRIPE_RK = 'rk_' + 'test_' + rep('9Zz', 7);
const WHSEC = 'whsec_' + rep('MfK2', 8);
const ANTHROPIC = 'sk-' + 'ant-api03-' + rep('Xy7_', 10);
const OPENAI_PROJ = 'sk-' + 'proj-' + rep('Ab9', 10);
const OPENAI_OLD = 'sk-' + rep('Ab1', 16);
const NPM = 'npm_' + rep('a1B2', 9);
const HF = 'hf_' + rep('QwE4', 9);
const SENDGRID = 'SG.' + rep('aB3', 7) + '.' + rep('Cd5', 10);
const SHOPIFY = 'shpat_' + rep('0a1b', 8);
const BASIC = btoa('alice:s3cret!');

/** Every span's text. */
const found = (text: string, spans: { start: number; end: number }[]): string[] =>
  spans.map((s) => text.slice(s.start, s.end));

const sinkOf = (): ValueSink & { values: string[] } => {
  const values: string[] = [];
  return { values, add: (v) => values.push(v) };
};

describe('nameWords', () => {
  it('splits at separators, case changes and runs of capitals', () => {
    expect(nameWords('X-CSRFToken')).toEqual(['x', 'csrf', 'token']);
    expect(nameWords('accessToken')).toEqual(['access', 'token']);
    expect(nameWords('user[password]')).toEqual(['user', 'password']);
    expect(nameWords('api.key')).toEqual(['api', 'key']);
    expect(nameWords('__Host-session_ID')).toEqual(['host', 'session', 'id']);
    expect(nameWords('')).toEqual([]);
  });
});

describe('secretName', () => {
  it.each([
    ['password', 'json', 'password'],
    ['user[password]', 'form', 'password'],
    ['X-CSRFToken', 'header', 'token'],
    ['accessToken', 'json', 'token'],
    ['access_token', 'query', 'token'],
    ['accesstoken', 'query', 'token'],
    ['authtoken', 'json', 'token'],
    ['csrfmiddlewaretoken', 'form', 'token'],
    ['clientsecret', 'json', 'secret'],
    ['client_secret', 'form', 'secret'],
    ['jsessionid', 'query', 'session'],
    ['hapikey', 'query', 'secret'],
    ['x-api-key', 'header', 'secret'],
    ['apiKey', 'json', 'secret'],
    ['privateKey', 'json', 'secret'],
    ['Ocp-Apim-Subscription-Key', 'header', 'secret'],
    ['X-Auth-Token', 'header', 'token'],
    ['X-Amz-Security-Token', 'query', 'token'],
    ['X-Amz-Signature', 'query', 'token'],
    ['X-Amz-Credential', 'query', 'token'],
    ['sig', 'query', 'token'],
    ['SAMLResponse', 'form', 'token'],
    ['id_token', 'json', 'token'],
    ['refresh_token', 'form', 'token'],
    ['authorization', 'json', 'token'],
    ['pin', 'json', 'password'],
    ['otp', 'form', 'password'],
    ['cvv', 'json', 'password'],
    ['session', 'json', 'session'],
    ['code', 'query', 'code'],
    ['code_verifier', 'form', 'code'],
    ['device_code', 'form', 'code'],
  ] as const)('%s in %s is a %s', (name, where, family) => {
    expect(secretName(name, where)).toBe(family);
  });

  it.each([
    ['totalTokenCount', 'json'],
    ['promptTokenCount', 'json'],
    ['max_tokens', 'json'],
    ['token_type', 'json'],
    ['token_type_hint', 'form'],
    ['auth_type', 'json'],
    ['code', 'json'],
    ['code', 'header'],
    ['AccountSid', 'json'],
    ['CallSid', 'form'],
    ['Idempotency-Key', 'header'],
    ['Sec-WebSocket-Key', 'header'],
    ['key', 'json'],
    ['monkey', 'json'],
    ['Keep-Alive', 'header'],
    ['state', 'query'],
    ['nonce', 'query'],
    ['WWW-Authenticate', 'header'],
    ['Proxy-Authenticate', 'header'],
    [':authority', 'header'],
    ['author', 'json'],
    ['tokenizer', 'json'],
    ['tokenization', 'json'],
    ['token_endpoint', 'json'],
    ['token_uri', 'json'],
    ['auth_url', 'json'],
    ['auth_method', 'json'],
    ['secret_name', 'json'],
    ['SecretId', 'json'],
    ['session_expires_at', 'json'],
    ['password_policy', 'json'],
    ['cookie_consent', 'form'],
    ['pass_through', 'json'],
    ['passwordless', 'json'],
    ['anthropic-ratelimit-tokens-remaining', 'header'],
    ['Access-Control-Allow-Credentials', 'header'],
    ['Access-Control-Allow-Headers', 'header'],
    ['client_id', 'query'],
    ['username', 'form'],
    ['', 'json'],
  ] as const)('%s in %s is not a secret', (name, where) => {
    expect(secretName(name, where)).toBeUndefined();
  });
});

describe('distinctive', () => {
  it('takes long or mixed values', () => {
    expect(distinctive('abcdefghijklmnopQ')).toBe(true);
    expect(distinctive('ab12cd34')).toBe(true);
  });
  it.each([
    'short1',
    '12345678901234',
    '1234567890123456789',
    'internationalization',
    'api.longexample.example.com',
    'production',
    'Europe/Berlin',
    'https://example.com/x',
    'api.example.com',
    'dark-mode',
  ])('rejects %s', (value) => {
    expect(distinctive(value)).toBe(false);
  });
});

describe('spans', () => {
  it('joins overlapping spans and applies them', () => {
    const text = 'abcdefghij';
    const spans = [
      { start: 1, end: 4, kind: 'a' },
      { start: 3, end: 6, kind: 'b' },
      { start: 8, end: 9, kind: 'c', replacement: '"x"' },
    ];
    expect(mergeSpans(spans)).toEqual([
      { start: 1, end: 6, kind: 'a' },
      { start: 8, end: 9, kind: 'c', replacement: '"x"' },
    ]);
    expect(applySpans(text, spans)).toBe(`a${REDACTED}gh"x"j`);
  });
  it('drops a replacement once a span is joined with a longer one', () => {
    expect(
      mergeSpans([
        { start: 0, end: 2, kind: 'a', replacement: '1' },
        { start: 1, end: 3, kind: 'b' },
      ]),
    ).toEqual([{ start: 0, end: 3, kind: 'a' }]);
  });
  it('leaves text without spans as it is', () => {
    expect(applySpans('abc', [])).toBe('abc');
  });
});

describe('token shapes', () => {
  it.each([
    ['JSON Web Token', JWT],
    ['JSON Web Encryption', JWE],
    ['GitHub token', GH],
    ['GitHub token', GH_PAT],
    ['GitLab token', GLPAT],
    ['AWS access key ID', AKIA],
    ['Google API key', GOOGLE],
    ['Google OAuth token', YA29],
    ['Google OAuth client secret', GOCSPX],
    ['Slack token', SLACK_B],
    ['Slack token', SLACK_C],
    ['Slack token', SLACK_E],
    ['Slack token', XAPP],
    ['Slack token', XAPP_ROTATING],
    ['GitHub token', GHS_2026],
    ['Stripe key', STRIPE],
    ['Stripe key', STRIPE_RK],
    ['Stripe webhook secret', WHSEC],
    ['API key', ANTHROPIC],
    ['API key', OPENAI_PROJ],
    ['API key', OPENAI_OLD],
    ['npm token', NPM],
    ['Hugging Face token', HF],
    ['SendGrid key', SENDGRID],
    ['Shopify token', SHOPIFY],
  ])('finds a %s in text', (kind, token) => {
    const text = `before "${token}" after`;
    const spans = shapeSpans(text);
    expect(found(text, spans)).toContain(token);
    expect(spans.find((s) => text.slice(s.start, s.end) === token)?.kind).toBe(kind);
  });

  it('finds bearer and basic credentials, keeping the scheme word', () => {
    const text = `Authorization was Bearer abc123def456ghi789jkl0 and basic ${BASIC}.`;
    expect(found(text, shapeSpans(text))).toEqual(['abc123def456ghi789jkl0', BASIC]);
  });

  it('finds tokens after a percent escape', () => {
    const text = `?h=Bearer%20${JWT}&x=%3D${GH}`;
    expect(found(text, shapeSpans(text))).toEqual(expect.arrayContaining([JWT, GH]));
  });

  it('finds a private key, with real or written-out line breaks, keeping the BEGIN line', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7';
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    const spans = shapeSpans(pem);
    expect(applySpans(pem, spans)).toBe(`-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`);
    const json = JSON.stringify({ key: pem }).slice(8, -2);
    expect(applySpans(json, shapeSpans(json))).toBe(
      `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`,
    );
    const rsa = `-----BEGIN RSA PRIVATE KEY-----\n${body}`;
    expect(applySpans(rsa, shapeSpans(rsa))).toBe(`-----BEGIN RSA PRIVATE KEY-----${REDACTED}`);
  });

  it('finds a Slack webhook path', () => {
    const text = 'post to https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX now';
    expect(found(text, shapeSpans(text))).toEqual(['T000/B000/XXXXXXXXXXXXXXXX']);
  });

  it.each([
    ['prose about basic auth', 'Basic authentication is required for this'],
    ['a bearer word with no digits', 'Bearer tokenrequiredforthisendpoint'],
    ['a short bearer value', 'Bearer abc123'],
    ['basic base64 that is not user:pass', `Basic ${btoa('nocolonhere')}`],
    ['basic base64 with control characters', `Basic ${btoa('\u0001\u0002:\u0003\u0004xyz')}`],
    ['a publishable Stripe key', 'pk_' + 'live_' + rep('4eC3', 6)],
    ['a CSS class', 'class="sk-wandering-cubes-loader"'],
    ['a Slovak slug', '/sk-nabytok-do-obyvacky-a-spalne'],
    ['an sk- run with no digits', 'sk-' + rep('abc', 12)],
    ['a short AWS ID', 'AKIA' + 'ABC123'],
    ['an AWS ID inside a longer run', 'X' + AKIA + 'Q'],
    ['a short GitHub token', 'ghp_' + 'abc123'],
    ['a GitHub token inside a longer run', 'a' + GH],
    ['a JWT inside a longer run', 'x' + JWT],
    ['a Google key one short', 'AIza' + rep('a', 34)],
    ['a Google key in longer base64', 'data:image/png;base64,' + GOOGLE + 'More'],
    ['a short whsec', 'whsec_' + 'abc'],
    ['a BEGIN line with no body', '-----BEGIN PRIVATE KEY-----'],
    ['a public key', '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq'],
    ['an ordinary sentence', 'The quick brown fox jumps over the lazy dog.'],
  ])('leaves %s alone', (_what, text) => {
    expect(shapeSpans(text)).toEqual([]);
  });
});

describe('redactUrl', () => {
  it('redacts query values with secret names, keeping everything else byte for byte', () => {
    const url = 'https://example.com/cb?code=Spl0xAbc&state=xyz%7E&scope=a+b&access_token=tok%2Fen';
    expect(redactUrl(url).url).toBe(
      `https://example.com/cb?code=${REDACTED}&state=xyz%7E&scope=a+b&access_token=${REDACTED}`,
    );
    expect(redactUrl(url).records).toEqual([
      { name: 'code', count: 1 },
      { name: 'access_token', count: 1 },
    ]);
  });

  it('redacts the password in user:password@ but not the user', () => {
    expect(redactUrl('https://bob:hunter22@example.com/x?a=1').url).toBe(
      `https://bob:${REDACTED}@example.com/x?a=1`,
    );
    expect(redactUrl('https://bob@example.com/x').url).toBe('https://bob@example.com/x');
    expect(redactUrl('https://example.com/a:b@c').url).toBe('https://example.com/a:b@c');
  });

  it('decodes names before matching', () => {
    expect(redactUrl('/x?api%5Fkey=abc&x%2Dauth%2Dtoken=def').url).toBe(
      `/x?api%5Fkey=${REDACTED}&x%2Dauth%2Dtoken=${REDACTED}`,
    );
  });

  it('redacts fragment parameters, as OAuth implicit flows send them', () => {
    expect(redactUrl('https://app.example/#access_token=abc&token_type=Bearer&expires_in=3600').url).toBe(
      `https://app.example/#access_token=${REDACTED}&token_type=Bearer&expires_in=3600`,
    );
  });

  it('redacts matrix parameters in the path', () => {
    expect(redactUrl('https://example.com/app;jsessionid=ABC123DEF/page;v=2?x=1').url).toBe(
      `https://example.com/app;jsessionid=${REDACTED}/page;v=2?x=1`,
    );
  });

  it('redacts a presigned URL', () => {
    const url =
      'https://bucket.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKID%2F2026&X-Amz-Date=20261119T000000Z&X-Amz-Expires=900&X-Amz-Security-Token=FQoG&X-Amz-Signature=abc123';
    expect(redactUrl(url).url).toBe(
      `https://bucket.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${REDACTED}&X-Amz-Date=20261119T000000Z&X-Amz-Expires=900&X-Amz-Security-Token=${REDACTED}&X-Amz-Signature=${REDACTED}`,
    );
    expect(redactUrl('https://acct.blob.core.windows.net/c/b?sv=2024&sig=Ab%2Bc%3D').url).toBe(
      `https://acct.blob.core.windows.net/c/b?sv=2024&sig=${REDACTED}`,
    );
  });

  it('redacts a value holding a secret once decoded, such as a URL inside a URL', () => {
    const url = 'https://login.example/?next=https%3A%2F%2Fapp.example%2Fcb%3Ftoken%3Dabc123&lang=en';
    expect(redactUrl(url).url).toBe(`https://login.example/?next=${REDACTED}&lang=en`);
    const plain = 'https://login.example/?next=https%3A%2F%2Fapp.example%2Fhome&lang=en';
    expect(redactUrl(plain).url).toBe(plain);
    expect(redactUrl(`/x?h=Bearer%20${JWT}`).url).toBe(`/x?h=${REDACTED}`);
    expect(redactUrl(`/x?h=${encodeURIComponent(GH)}`).url).toBe(`/x?h=${REDACTED}`);
  });

  it('redacts token shapes in the path', () => {
    expect(redactUrl(`https://example.com/reset/${JWT}/confirm`).url).toBe(
      `https://example.com/reset/${REDACTED}/confirm`,
    );
  });

  it('leaves empty values and ordinary URLs alone', () => {
    for (const url of [
      '/x?token=&a=1',
      'https://example.com/search?q=password+reset&page=2',
      'https://example.com/a/b;v=1/c',
      'https://example.com/',
      '',
      'not a url',
      'https://example.com/x?code',
    ]) {
      expect(redactUrl(url).url).toBe(url);
    }
  });
});

describe('URLs in text', () => {
  it('applies the URL rules to URLs in text, including JSON-escaped ones', () => {
    const json = '{"upload_url":"https:\\/\\/b.s3.example\\/k?X-Amz-Signature=abc\\u0026x=1","n":2}';
    expect(applySpans(json, urlInTextSpans(json))).toBe(
      `{"upload_url":"https:\\/\\/b.s3.example\\/k?X-Amz-Signature=${REDACTED}\\u0026x=1","n":2}`,
    );
    const html = '<a href="https://example.com/cb?code=abc&amp;state=1">';
    expect(applySpans(html, urlInTextSpans(html))).toBe(
      `<a href="https://example.com/cb?code=${REDACTED}&amp;state=1">`,
    );
    const text = 'see https://example.com/x?sig=abc and https://example.com/y?page=2.';
    expect(applySpans(text, textSpans(text))).toBe(
      `see https://example.com/x?sig=${REDACTED} and https://example.com/y?page=2.`,
    );
  });

  it('leaves text without URLs or with a bare :// alone', () => {
    expect(urlInTextSpans('no urls here, ://x?token=a')).toEqual([]);
    expect(urlInTextSpans('3://x?token=a')).toEqual([]);
  });
});

describe('headers', () => {
  it('keeps a known Authorization scheme and redacts the credentials', () => {
    expect(redactAuthorization(`Bearer ${JWT}`)).toBe(`Bearer ${REDACTED}`);
    expect(redactAuthorization(`Basic ${BASIC}`)).toBe(`Basic ${REDACTED}`);
    expect(redactAuthorization('AWS4-HMAC-SHA256 Credential=AKID/2026, Signature=abc')).toBe(
      `AWS4-HMAC-SHA256 ${REDACTED}`,
    );
    expect(redactAuthorization('Digest username="a", response="b"')).toBe(`Digest ${REDACTED}`);
  });

  it('redacts an Authorization value without a known scheme whole', () => {
    expect(redactAuthorization(GH)).toBe(REDACTED);
    expect(redactAuthorization(JWT)).toBe(REDACTED);
    expect(redactAuthorization('secretpart1 part2')).toBe(REDACTED);
    expect(redactAuthorization('Bearer')).toBe(REDACTED);
    expect(redactAuthorization('')).toBe('');
  });

  it('redacts each cookie value, keeping the names', () => {
    expect(redactCookieHeader('a=1; b=two=2; crumb;  ; c=')).toEqual({
      value: `a=${REDACTED}; b=${REDACTED}; ${REDACTED};  ; c=`,
      count: 3,
    });
  });

  it('keeps Set-Cookie attributes of the right form', () => {
    const value =
      'sid=abc123; Path=/; Domain=.example.com; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=3600; Secure; HttpOnly; SameSite=Lax; Partitioned; Priority=High';
    expect(redactSetCookie(value)).toEqual({ value: value.replace('abc123', REDACTED), count: 1 });
  });

  it('redacts unknown attributes and cookies folded into a Set-Cookie line', () => {
    expect(redactSetCookie('a=1; Path=/, b=SECRET; HttpOnly').value).toBe(
      `a=${REDACTED}; ${REDACTED}; HttpOnly`,
    );
    expect(redactSetCookie('a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=SECRET').value).toBe(
      `a=${REDACTED}; ${REDACTED}`,
    );
    expect(redactSetCookie('a=1; Foo=bar; SameSite=Lax').value).toBe(
      `a=${REDACTED}; ${REDACTED}; SameSite=Lax`,
    );
    expect(redactSetCookie('bare').value).toBe(REDACTED);
    expect(redactSetCookie('a=; Path=/').value).toBe('a=; Path=/');
  });

  it.each([
    ['Authorization', `Bearer ${JWT}`, `Bearer ${REDACTED}`],
    ['proxy-authorization', `Basic ${BASIC}`, `Basic ${REDACTED}`],
    ['Authentication-Info', 'nextnonce="abc"', REDACTED],
    ['X-Api-Key', 'abc', REDACTED],
    ['x-csrftoken', 'abc', REDACTED],
    [
      'Location',
      'https://app.example/cb?code=abc&state=1',
      `https://app.example/cb?code=${REDACTED}&state=1`,
    ],
    ['Referer', 'https://example.com/reset?token=abc', `https://example.com/reset?token=${REDACTED}`],
    [':path', '/cb?access_token=abc#x', `/cb?access_token=${REDACTED}#x`],
    ['Content-Location', '/a?sig=abc', `/a?sig=${REDACTED}`],
    [
      'Link',
      '<https://x.example/n?sig=abc>; rel="next", <https://x.example/p>; rel="prev"',
      `<https://x.example/n?sig=${REDACTED}>; rel="next", <https://x.example/p>; rel="prev"`,
    ],
    ['Refresh', '5; url=https://x.example/?token=abc', `5; url=https://x.example/?token=${REDACTED}`],
    ['Sec-WebSocket-Protocol', `graphql-transport-ws, ${JWT}`, `graphql-transport-ws, ${REDACTED}`],
    ['Sec-WebSocket-Protocol', 'Authorization.Bearer_abc123def456ghi789', REDACTED],
    ['X-Debug', `token in ${GH} here`, `token in ${REDACTED} here`],
  ])('redacts %s', (name, value, expected) => {
    expect(redactHeader(name, value).value).toBe(expected);
  });

  it.each([
    ['Content-Type', 'application/json'],
    ['Access-Control-Allow-Credentials', 'true'],
    ['Access-Control-Allow-Headers', 'Authorization, X-Api-Key'],
    ['WWW-Authenticate', 'Bearer realm="api"'],
    ['Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ=='],
    ['Sec-WebSocket-Protocol', 'graphql-transport-ws, chat.v2'],
    ['X-Request-Id', '7f3c2a1b-9d8e-4f6a-b5c4-3d2e1f0a9b8c'],
    ['anthropic-ratelimit-tokens-remaining', '39000'],
    ['Location', 'https://example.com/next?page=2'],
    ['X-Api-Key', ''],
    ['Authorization', ''],
  ])('leaves %s alone', (name, value) => {
    expect(redactHeader(name, value)).toEqual({ value, records: [] });
  });

  it('redacts a list, counting by name, HTTP/2 cookie crumbs included', () => {
    const { headers, records } = redactHeaders([
      ['cookie', 'a=1'],
      ['cookie', 'b=2; c=3'],
      ['authorization', `Bearer ${JWT}`],
      ['accept', '*/*'],
    ]);
    expect(headers).toEqual([
      ['cookie', `a=${REDACTED}`],
      ['cookie', `b=${REDACTED}; c=${REDACTED}`],
      ['authorization', `Bearer ${REDACTED}`],
      ['accept', '*/*'],
    ]);
    expect(records).toEqual([
      { name: 'cookie', count: 3 },
      { name: 'authorization', count: 1 },
    ]);
  });

  it('records token shapes found in other headers by kind', () => {
    expect(redactHeader('X-Debug', `${GH} ${JWT}`).records).toEqual([
      { kind: 'GitHub token', count: 1 },
      { kind: 'JSON Web Token', count: 1 },
    ]);
  });
});

describe('collecting values to find elsewhere', () => {
  it('collects credentials, not ordinary values', () => {
    const sink = sinkOf();
    redactHeader('Authorization', `Bearer ${JWT}`, sink);
    redactHeader('X-Api-Key', 'k3yValue99', sink);
    redactHeader('X-Session', 'abcdefgh', sink); // A session header: not a strong family.
    redactHeader(
      'Cookie',
      'consent=accepted; tz=Europe%2FBerlin; theme=dark-mode; sid=Q2xA9fK3mZ7pL1sW8eR4',
      sink,
    );
    redactUrl('https://bob:Hunter2022@example.com/?token=short&access_token=Zq81kLm0Pq&code=12345678', sink);
    redactHeader('X-Debug', `see ${GH}`, sink);
    expect(sink.values).toEqual([JWT, 'k3yValue99', 'Q2xA9fK3mZ7pL1sW8eR4', 'Hunter2022', 'Zq81kLm0Pq', GH]);
  });
});

describe('time', () => {
  it.each([
    ['repeated eyJ', (n: number) => rep('eyJ', n)],
    ['repeated eyJ.', (n: number) => rep('eyJabcdefghij.', n)],
    ['letters after ://', (n: number) => 'http://' + rep('a', n * 3)],
    ['repeated ://', (n: number) => rep('a://', n)],
    ['repeated BEGIN lines', (n: number) => rep('-----BEGIN PRIVATE KEY-----\nMIIE', n)],
    ['repeated bearer', (n: number) => rep('bearer ', n)],
    ['bearer then a long run', (n: number) => 'Bearer ' + rep('a', n * 3)],
    ['repeated sk-', (n: number) => rep('sk-', n)],
    ['query pairs with no =', (n: number) => '/x?' + rep('a&', n * 5)],
    ['repeated ;', (n: number) => '/x' + rep(';a', n)],
    ['repeated <', (n: number) => rep('<a', n * 10)],
    ['repeated bearer+', (n: number) => rep('bearer+', n)],
    ['repeated basic+', (n: number) => rep('basic+', n)],
    ['repeated Refresh spaces', (n: number) => rep(' ', n * 20) + 'x'],
    ['dots before the end of a URL', (n: number) => 'http://a/' + rep('.', n) + 'x'],
    ['closing brackets after a URL', (n: number) => 'http://a/' + rep(')', n)],
    ['brackets and dots after a URL', (n: number) => 'http://a/' + rep(').', n)],
    ['a long escape run in a URL', (n: number) => 'https://a/?q=' + rep('\\u0041', n)],
    ['WebSocket protocols', (n: number) => rep('abcdefghijklmnopqrstu, ', n)],
  ])('stays linear on %s', { timeout: 60_000 }, (_what, make) => {
    const run = (text: string) => () => {
      textSpans(text);
      redactUrl(text);
      redactHeader('Link', text);
      redactHeader('Refresh', text);
      redactHeader('Cookie', text);
      redactHeader('Set-Cookie', text);
      redactHeader('Authorization', text);
      redactHeader('Sec-WebSocket-Protocol', text);
    };
    // Grow the input until one run takes at least 10 ms (or the text is 2 MB), so a busy machine's
    // noise is small next to what's measured.
    let n = 10_000;
    run(make(n))(); // Warm up.
    while (once(run(make(n))) < 10 && make(n).length < 2_000_000) n *= 2;
    // Eight times the input should take about eight times as long; quadratic would take 64. The
    // limit sits between them, with room for a busy machine; a miss is timed again (see growth).
    expectGrowthUnder(run(make(n)), run(make(n * 8)), 20);
  });
});

describe('a realistic exchange', () => {
  it('leaves none of the planted secrets in its headers, trailers or URLs', () => {
    const session = 'Q2xA9fK3mZ7pL1sW8eR4tY6u';
    const csrf = 'c5rfT0kenV4lue88';
    const code = 'SplxlOBeZQQYbYS6WxSbIA';
    const secrets = [JWT, session, csrf, code, 'Hunter2022', GH, STRIPE, 'S1gnatureXyz'];
    const requestUrl = `https://bob:Hunter2022@api.example.com/v1/cb;jsessionid=${session}?code=${code}&state=af0ifjsldkj`;
    const requestHeaders: [string, string][] = [
      [':method', 'GET'],
      [':path', `/v1/cb;jsessionid=${session}?code=${code}&state=af0ifjsldkj`],
      [':authority', 'api.example.com'],
      ['authorization', `Bearer ${JWT}`],
      ['cookie', `__Host-sid=${session}; theme=dark`],
      ['cookie', `csrftoken=${csrf}`],
      ['x-csrftoken', csrf],
      ['referer', `https://app.example.com/login?next=%2Fhome&token=${JWT}`],
      ['x-stripe-debug', `key ${STRIPE}`],
      ['user-agent', 'Mozilla/5.0'],
    ];
    const responseHeaders: [string, string][] = [
      ['set-cookie', `__Host-sid=${session}; Path=/; Secure; HttpOnly; SameSite=Lax`],
      ['location', `https://app.example.com/done#access_token=${JWT}&token_type=Bearer`],
      ['link', `<https://cdn.example.com/a.js?sig=S1gnatureXyz>; rel=preload`],
      ['content-type', 'application/json'],
    ];
    const trailers: [string, string][] = [
      ['grpc-status', '0'],
      ['x-debug-token', GH],
    ];
    const out = JSON.stringify([
      redactUrl(requestUrl).url,
      redactHeaders(requestHeaders).headers,
      redactHeaders(responseHeaders).headers,
      redactHeaders(trailers).headers,
    ]);
    for (const secret of secrets) {
      expect(out).not.toContain(secret);
      expect(out).not.toContain(encodeURIComponent(secret));
    }
    // What isn't secret is still there.
    for (const kept of [
      'af0ifjsldkj',
      'api.example.com',
      'theme=',
      'Mozilla/5.0',
      'token_type=Bearer',
      'SameSite=Lax',
      'grpc-status',
      'rel=preload',
      'Bearer [redacted]',
    ]) {
      expect(out).toContain(kept);
    }
  });

  it('collects a JWT as distinctive, though it looks a little like a host name', () => {
    expect(distinctive(JWT)).toBe(true);
  });
});

describe('fixes from review', () => {
  it.each([
    ['session_id', 'query'],
    ['sessionId', 'json'],
    ['X-Session-Id', 'header'],
    ['ASP.NET_SessionId', 'header'],
    ['PHPSESSID', 'query'],
    ['sess_id', 'form'],
    ['x-amz-server-side-encryption-customer-key', 'header'],
    ['x-goog-encryption-key', 'header'],
    ['x-functions-key', 'header'],
    ['DD-APPLICATION-KEY', 'header'],
    ['api_keys', 'json'],
    ['apiKeys', 'json'],
    ['access-keys', 'header'],
  ] as const)('%s in %s is a secret', (name, where) => {
    expect(secretName(name, where)).toBeDefined();
  });

  it.each([
    ['secretary', 'json'],
    ['keys', 'json'],
    ['monkeys', 'json'],
    ['sort_keys', 'json'],
    ['secretariat_address', 'json'],
    ['password_changed', 'json'],
    ['password_updated', 'json'],
    ['X-Auth-Request-Email', 'header'],
  ] as const)('%s in %s is not a secret', (name, where) => {
    expect(secretName(name, where)).toBeUndefined();
  });

  it('takes the most sensitive family a name has', () => {
    expect(secretName('X-Session-Token', 'header')).toBe('token');
    expect(secretName('auth_pin', 'json')).toBe('password');
    expect(secretName('session_secret', 'json')).toBe('secret');
  });

  it('keeps a ; inside a query or fragment value with the value', () => {
    expect(redactUrl('/x?token=abc;def&a=1').url).toBe(`/x?token=${REDACTED}&a=1`);
    expect(redactUrl('/x#access_token=abc;def').url).toBe(`/x#access_token=${REDACTED}`);
  });

  it('understands &amp; and &#38; between parameters', () => {
    expect(redactUrl('/x?a=1&amp;token=abc&#38;sig=def&#x26;b=2').url).toBe(
      `/x?a=1&amp;token=${REDACTED}&#38;sig=${REDACTED}&#x26;b=2`,
    );
  });

  it('reads a code after &amp;', () => {
    expect(redactUrl('/cb?state=1&amp;code=abc').url).toBe(`/cb?state=1&amp;code=${REDACTED}`);
  });

  it('keeps a balanced closing bracket in a URL in text', () => {
    const text = 'see https://a.example/?token=ab(cd) now';
    expect(applySpans(text, urlInTextSpans(text))).toBe(`see https://a.example/?token=${REDACTED} now`);
  });

  it('looks into an unencoded URL in a query value', () => {
    expect(redactUrl('https://login.example/?next=https://app.example/cb?token=abc123').url).toBe(
      `https://login.example/?next=https://app.example/cb?token=${REDACTED}`,
    );
    expect(redactUrl('/x?next=/cb?token=abc123&y=1').url).toBe(`/x?next=/cb?token=${REDACTED}&y=1`);
    expect(redactUrl('/x?next=https://bob:pw12345@host/').url).toBe(`/x?next=https://bob:${REDACTED}@host/`);
    expect(redactUrl('/x?next=/cb?page=2&y=1').url).toBe('/x?next=/cb?page=2&y=1');
  });

  it('decodes a value with a non-UTF-8 escape, and one encoded twice', () => {
    expect(redactUrl('/x?next=https%3A%2F%2Fa%2Fcaf%E9%3Ftoken%3Dabc').url).toBe(`/x?next=${REDACTED}`);
    expect(redactUrl('/x?next=https%253A%252F%252Fa%252Fb%253Ftoken%253Dabc').url).toBe(
      `/x?next=${REDACTED}`,
    );
    expect(redactUrl('/x?q=caf%E9+au+lait&n=a%2Bb').url).toBe('/x?q=caf%E9+au+lait&n=a%2Bb');
  });

  it('redacts the password in a protocol-relative URL', () => {
    expect(redactUrl('//bob:hunter22@example.com/x').url).toBe(`//bob:${REDACTED}@example.com/x`);
    expect(redactUrl('//example.com/x?a=1').url).toBe('//example.com/x?a=1');
  });

  it('follows a URL in text past 8 KB', () => {
    const long = 'https://a.example/?SAMLRequest=' + rep('Q', 9000) + '&token=abc';
    const text = `go ${long} now`;
    expect(applySpans(text, urlInTextSpans(text))).toBe(
      `go https://a.example/?SAMLRequest=${REDACTED}&token=${REDACTED} now`,
    );
    const link = `<https://x.example/n?${rep('a', 9000)}=1&sig=abc>; rel="next"`;
    expect(redactHeader('Link', link).value).toBe(link.replace('sig=abc', `sig=${REDACTED}`));
  });

  it('reads JSON escapes inside a URL, and stops at an escaped quote', () => {
    const json = '"https:\\/\\/a.example\\/k?sig=ab\\u002Bcd\\u0026x=1"';
    expect(applySpans(json, urlInTextSpans(json))).toBe(
      `"https:\\/\\/a.example\\/k?sig=${REDACTED}\\u0026x=1"`,
    );
    const quoted = '"https://a.example/?token=abc\\u0022 and more"';
    expect(applySpans(quoted, urlInTextSpans(quoted))).toBe(
      `"https://a.example/?token=${REDACTED}\\u0022 and more"`,
    );
  });

  it('maps spans back through many escapes', () => {
    const json = '"https:\\/\\/a.example\\/p?x=\\u0031&token=t\\u006Fk\\u0065n1&b=2&sig=s\\/g&c=\\u00e9"';
    expect(applySpans(json, urlInTextSpans(json))).toBe(
      `"https:\\/\\/a.example\\/p?x=\\u0031&token=${REDACTED}&b=2&sig=${REDACTED}&c=\\u00e9"`,
    );
  });

  it('finds a URL with a digit before its scheme', () => {
    const text = '12345https://example.com/?token=abc';
    expect(applySpans(text, urlInTextSpans(text))).toBe(`12345https://example.com/?token=${REDACTED}`);
  });

  it('leaves prose punctuation and brackets out of a URL in text', () => {
    const text = '(see https://a.example/?token=abc), ok. Also https://w.example/wiki/Foo_(bar)?sig=x.';
    expect(applySpans(text, urlInTextSpans(text))).toBe(
      // The final `.` follows a secret value, so it's taken as part of it.
      `(see https://a.example/?token=${REDACTED}), ok. Also https://w.example/wiki/Foo_(bar)?sig=${REDACTED}`,
    );
  });

  it('redacts Refresh with fractional delays and quotes', () => {
    expect(redactHeader('Refresh', '0.5; url=/cb?token=abc').value).toBe(`0.5; url=/cb?token=${REDACTED}`);
    expect(redactHeader('Refresh', "0;URL='/cb?token=abc'").value).toBe(`0;URL='/cb?token=${REDACTED}'`);
    expect(redactHeader('Refresh', 'url=/cb?token=abc').value).toBe(`url=/cb?token=${REDACTED}`);
    expect(redactHeader('Refresh', '5').value).toBe('5');
  });

  it('redacts URL-valued proxy headers and Proxy-Authentication-Info', () => {
    expect(redactHeader('X-Original-URL', '/cb?code=abc&token=def').value).toBe(
      `/cb?code=${REDACTED}&token=${REDACTED}`,
    );
    expect(redactHeader('Proxy-Authentication-Info', 'nextnonce="abc"').value).toBe(REDACTED);
  });

  it('keeps dotted lowercase WebSocket protocols', () => {
    expect(redactHeader('Sec-WebSocket-Protocol', 'com.example.protocol.v2').value).toBe(
      'com.example.protocol.v2',
    );
  });

  it('accepts a long mixed-case bearer token with no digits, but not a word', () => {
    const token = rep('AbCdEfGh', 4);
    const text = `Bearer ${token}`;
    expect(found(text, shapeSpans(text))).toEqual([token]);
    expect(shapeSpans(`Bearer ${rep('abcdefgh', 4)}`)).toEqual([]);
  });

  it('redacts encrypted and PGP private keys', () => {
    const encrypted =
      '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABCDEF0123456789\n\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(applySpans(encrypted, shapeSpans(encrypted))).toBe(
      `-----BEGIN RSA PRIVATE KEY-----${REDACTED}-----END RSA PRIVATE KEY-----`,
    );
    const pgp =
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: x\n\nlQOYBF+abc\n=XyZ1\n-----END PGP PRIVATE KEY BLOCK-----';
    expect(applySpans(pgp, shapeSpans(pgp))).toBe(
      `-----BEGIN PGP PRIVATE KEY BLOCK-----${REDACTED}-----END PGP PRIVATE KEY BLOCK-----`,
    );
  });

  it('finds the right span in periodic text', () => {
    const value = btoa('ab:cd');
    const text = `basic+basic+basic+${value}`;
    const spans = shapeSpans(text);
    // Which `basic` starts it is ambiguous; the span must end at the credential's end.
    expect(spans).toHaveLength(1);
    expect(spans[0]!.end).toBe(text.length);
    expect(text.slice(spans[0]!.start, spans[0]!.end).endsWith(value)).toBe(true);
  });

  it('finds a GitLab token with a dotted suffix whole', () => {
    const token = 'glpat-' + rep('aB3', 7) + '.01.' + rep('x9', 5);
    expect(found(token, shapeSpans(token))).toEqual([token]);
  });

  it('numbers markers when asked', () => {
    expect(
      applySpans(
        'a1b2c',
        [
          { start: 1, end: 2, kind: 'x' },
          { start: 3, end: 4, kind: 'x' },
        ],
        (_span, i) => `[redacted:${i + 1}]`,
      ),
    ).toBe('a[redacted:1]b[redacted:2]c');
  });
});

describe('collecting values, after review', () => {
  it('collects token-like cookies, secret-named or HttpOnly ones, and nothing else', () => {
    const sink = sinkOf();
    redactCookieHeader(
      'tz=America%2FLos_Angeles; seen=2026-11-19T10:00:00Z; res=1920x1080; v=v2.14.0-beta; dev=iPhone15%2C3; _ga=GA1.2.123456789.1700000000; theme=dark-mode; a="x;y"',
      sink,
    );
    expect(sink.values).toEqual([]);
    redactCookieHeader('pref=Zz81kLm0PqRt55Ab; csrftoken=abcdefgh12', sink);
    redactSetCookie('sid=abcdefghijklmnop12; Path=/; HttpOnly', sink);
    redactSetCookie('s=abc.def.ghi12; HttpOnly', sink);
    redactSetCookie('t=abc.def.ghi34; Path=/', sink);
    redactSetCookie('lang=en-US; Path=/', sink);
    expect(sink.values).toEqual(['Zz81kLm0PqRt55Ab', 'abcdefgh12', 'abcdefghijklmnop12', 'abc.def.ghi12']);
  });

  it('collects shapes found in URLs and special headers, once each', () => {
    const sink = sinkOf();
    redactUrl(`https://example.com/reset/${JWT}`, sink);
    redactHeader('Location', `/x/${GH}`, sink);
    redactHeader('Sec-WebSocket-Protocol', `v1, ${STRIPE}`, sink);
    expect(sink.values).toEqual([JWT, GH, STRIPE]);
  });

  it('collects a URL password once, decoded, and not an encoded value whole', () => {
    const sink = sinkOf();
    const text = 'see https://bob:Hunter%402022@example.com/?next=https%3A%2F%2Fa%2F%3Ftoken%3DZq81kLm0Pq';
    textSpans(text, sink);
    expect(sink.values).toEqual(['Hunter@2022', 'Zq81kLm0Pq']);
  });

  it('collects single-token credentials, not Digest parameters or Authentication-Info', () => {
    const sink = sinkOf();
    redactHeader('Authorization', 'Digest username="bob", response="0123456789abcdef0123"', sink);
    redactHeader('Authentication-Info', 'nextnonce="0123456789abcdefXYZ"', sink);
    redactHeader('Authorization', `Basic ${BASIC}`, sink);
    redactHeader('Authorization', GH, sink);
    expect(sink.values).toEqual([BASIC, GH]);
  });
});

describe('time on hostile headers and bearer runs', () => {
  const time = (run: () => void): number => {
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  it.each([
    ['Refresh with leading spaces', () => redactHeader('Refresh', rep(' ', 8000) + 'x')],
    ['Refresh with NBSPs', () => redactHeader('Refresh', rep(' ', 8000) + 'x')],
    ['Cookie', () => redactHeader('Cookie', rep('a=b; ', 40_000))],
    ['Set-Cookie', () => redactHeader('Set-Cookie', 'a=b' + rep('; Path=/', 40_000))],
    ['Authorization', () => redactHeader('Authorization', 'Bearer ' + rep(' x', 40_000))],
    ['bearer+ runs', () => textSpans(rep('bearer+', 30_000))],
    ['basic+ runs', () => textSpans(rep('basic+', 30_000))],
  ])('%s takes well under a second', (_what, run) => {
    run();
    expect(time(run)).toBeLessThan(500);
  });
});

describe('fixes from the second review', () => {
  it('redacts punctuation that ends a secret value', () => {
    const text = 'login at https://a.example/?password=hunter2!! now';
    expect(applySpans(text, urlInTextSpans(text))).toBe(
      `login at https://a.example/?password=${REDACTED} now`,
    );
    const prose = 'see https://a.example/x?page=2, then';
    expect(applySpans(prose, urlInTextSpans(prose))).toBe(prose);
  });

  it('redacts lowercase hex tokens in Sec-WebSocket-Protocol but keeps dotted names', () => {
    expect(redactHeader('Sec-WebSocket-Protocol', 'chat, a1b2c3d4e5f6a7b8c9d0e1f2').value).toBe(
      `chat, ${REDACTED}`,
    );
    expect(redactHeader('Sec-WebSocket-Protocol', 'graphql-transport-ws').value).toBe('graphql-transport-ws');
  });

  it('redacts a PGP key with armor headers, but not prose naming a key', () => {
    const pgp =
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: OpenPGP.js v4.10.10\nComment: https://openpgpjs.org\n\nxcLYBF+abc\n=XyZ1\n-----END PGP PRIVATE KEY BLOCK-----';
    expect(applySpans(pgp, shapeSpans(pgp))).toBe(
      `-----BEGIN PGP PRIVATE KEY BLOCK-----${REDACTED}-----END PGP PRIVATE KEY BLOCK-----`,
    );
    const prose = 'Look for -----BEGIN RSA PRIVATE KEY----- in the file and delete it, then restart.';
    expect(shapeSpans(prose)).toEqual([]);
  });

  it('leaves a closing square bracket the URL did not open to the prose', () => {
    const text = 'link: [https://a.example/?token=abc] and [https://b.example/a[1]?sig=x]';
    expect(applySpans(text, urlInTextSpans(text))).toBe(
      `link: [https://a.example/?token=${REDACTED}] and [https://b.example/a[1]?sig=${REDACTED}]`,
    );
  });

  it('keeps a balanced closing square bracket in a URL', () => {
    const text = 'see https://b.example/?sig=ab[c] now';
    expect(applySpans(text, urlInTextSpans(text))).toBe(`see https://b.example/?sig=${REDACTED} now`);
  });

  it('ends a quoted Refresh URL at its quote', () => {
    expect(redactHeader('Refresh', '0;url="/cb?token=abc"  ').value).toBe(`0;url="/cb?token=${REDACTED}"  `);
  });

  it('keeps customer and app keys, and session ID types', () => {
    expect(secretName('customer_key', 'json')).toBeUndefined();
    expect(secretName('app_key', 'json')).toBeUndefined();
    expect(secretName('session_id_type', 'json')).toBeUndefined();
  });

  it('collects a token shape inside a cookie value that is not token-like itself', () => {
    const sink = sinkOf();
    redactCookieHeader(`prefs=a/${GH}`, sink);
    expect(sink.values).toEqual([GH]);
  });

  it('redacts a header line that runs to the key limit', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nProc-Type: ' + rep('x', 20_000);
    const spans = shapeSpans(key);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.end - spans[0]!.start).toBe(16384);
  });

  it('collects JWTs and signed values from cookies', () => {
    const sink = sinkOf();
    redactCookieHeader(`jwt2=${JWT}; connect.sid=s%3AAbCdEf0123456789.GhIjKlMnOpQrStUv0123`, sink);
    expect(sink.values).toEqual([JWT, 's:AbCdEf0123456789.GhIjKlMnOpQrStUv0123']);
  });
});

describe('fixes from the final review', () => {
  it('stops a key header line at the next BEGIN line, quickly', () => {
    const text = rep('-----BEGIN PRIVATE KEY-----\nA: ', 40_000);
    const start = performance.now();
    shapeSpans(text);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('redacts a key after a long header line', () => {
    const key = `-----BEGIN PGP PRIVATE KEY BLOCK-----\nComment: https://example.com/${rep('a', 400)}\n\nxcLYBF+abc\n-----END PGP PRIVATE KEY BLOCK-----`;
    expect(applySpans(key, shapeSpans(key))).toBe(
      `-----BEGIN PGP PRIVATE KEY BLOCK-----${REDACTED}-----END PGP PRIVATE KEY BLOCK-----`,
    );
  });

  it('redacts UUID-like and hex chunks in Sec-WebSocket-Protocol, keeping short versions', () => {
    expect(redactHeader('Sec-WebSocket-Protocol', 'a1b2c3d4-e5f6a7b8-c9d0e1f2-a1b2c3d4').value).toBe(
      REDACTED,
    );
    expect(redactHeader('Sec-WebSocket-Protocol', '123e4567-e89b-12d3-a456-426614174000').value).toBe(
      REDACTED,
    );
    expect(redactHeader('Sec-WebSocket-Protocol', 'com.example.chat.ws13.v2').value).toBe(
      'com.example.chat.ws13.v2',
    );
  });

  it('finds shapes that only match once JSON escapes are undone', () => {
    const json = '"https:\\/\\/hooks.slack.com\\/services\\/T000\\/B000\\/XXXXXXXXXXXXXXXX"';
    expect(textSpans(json).length).toBeGreaterThan(0);
    expect(applySpans(json, textSpans(json))).not.toContain('XXXXXXXXXXXXXXXX');
  });

  it("doesn't collect a long dotted host name from a cookie", () => {
    const sink = sinkOf();
    redactCookieHeader('h=Very.Long.Host.Name.Example.Internal.Corp1', sink);
    expect(sink.values).toEqual([]);
  });
});
