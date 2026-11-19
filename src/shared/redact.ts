/**
 * Redaction: finding secrets in captured traffic so they don't leave Wirescry by accident
 * (in a shared HAR file, a screen share, or an agent's tool output).
 *
 * This part covers names (headers, query and form fields, JSON keys), headers, cookies, URLs
 * and token shapes in text. It is pure: strings in, strings and spans out, so the backend, the
 * window and an MCP server can all use it. Headers, cookies and URLs are redacted reliably;
 * text is best-effort, since no list of token shapes is complete.
 *
 * Every pattern is anchored at the start of a run of token characters and bounded in length,
 * so scanning is linear in the text's length even for text built to be slow: captured traffic
 * is written by whoever runs the server.
 */
import type { Header } from './api';

/** What a redacted value is replaced with. It keeps none of the value's characters. */
export const REDACTED = '[redacted]';

/** Where a name was found. Some names are secrets only in some places. */
export type NameContext = 'header' | 'query' | 'form' | 'json';

/**
 * The family of a secret name, which decides how its values are treated:
 * - `password`: passwords, PINs, one-time and card codes; every value, numbers too.
 * - `secret`: secrets and API keys; every value, numbers too.
 * - `token`: tokens, credentials, signatures, CSRF tokens; strings only in JSON.
 * - `session`: sessions and cookies; strings only in JSON.
 * - `code`: OAuth codes and verifiers, in queries and forms only.
 */
export type SecretFamily = 'password' | 'secret' | 'token' | 'session' | 'code';

/** Adds `more` to `spans` one by one: spreading a long list into push overflows the stack. */
function pushAll(spans: Span[], more: readonly Span[]): void {
  for (const span of more) spans.push(span);
}

/** A part of a string to redact. */
export interface Span {
  start: number;
  end: number;
  /** What was found: a token shape (e.g. "JSON Web Token"), or "name" for a secret name. */
  kind: string;
  /** The secret name the value was under, if found by name. */
  name?: string;
  /** What to put in its place, if not {@link REDACTED}. */
  replacement?: string;
}

/** What was redacted, for a record such as HAR's `_wirescryRedactions`. Never the value. */
export interface Redaction {
  /** A header, query or form field name the value was under. */
  name?: string;
  /** A token shape, when found by shape. */
  kind?: string;
  count: number;
}

/**
 * Collects values that were redacted, so the same value can be found elsewhere. The same value
 * can arrive more than once (a token in a URL inside a URL), so `add` must not mind repeats.
 */
export interface ValueSink {
  add(value: string): void;
}

// ---------------------------------------------------------------- names

const WORDS: ReadonlyMap<string, SecretFamily> = new Map<string, SecretFamily>([
  ...['password', 'passwd', 'pass', 'pwd', 'pw', 'passphrase', 'passcode', 'pin', 'otp', 'cvv', 'cvc'].map(
    (w) => [w, 'password'] as const,
  ),
  ...['secret', 'apikey'].map((w) => [w, 'secret'] as const),
  ...[
    'token',
    'auth',
    'authorization',
    'credential',
    'credentials',
    'signature',
    'sig',
    'csrf',
    'xsrf',
    'jwt',
    'bearer',
    'assertion',
    'saml',
    'samlresponse',
    'samlrequest',
  ].map((w) => [w, 'token'] as const),
  ...['session', 'sessionid', 'cookie'].map((w) => [w, 'session'] as const),
]);

/** Run-together words containing these are secrets: `accesstoken`, `clientsecret`, `jsessionid`. */
const CONTAINED: ReadonlyArray<readonly [string, SecretFamily]> = [
  ['password', 'password'],
  ['passwd', 'password'],
  ['secret', 'secret'],
  ['apikey', 'secret'],
  ['privatekey', 'secret'],
  ['accesskey', 'secret'],
  ['sessionid', 'session'],
  ['sessid', 'session'],
  ['token', 'token'],
  ['csrf', 'token'],
  ['xsrf', 'token'],
];

/** With the word `key`, these make a secret: `api-key`, `accessKey`, `privateKey`. */
const KEY_QUALIFIERS = new Set([
  'api',
  'access',
  'private',
  'secret',
  'client',
  'account',
  'subscription',
  'master',
  'license',
  'signing',
  'encryption',
  'functions',
  'application',
  'admin',
]);

/** In a query or form only: OAuth's authorization code and PKCE verifier. */
const CODE_NAMES = new Set(['code', 'code verifier', 'device code', 'verification code']);

/** A name whose last word is one of these describes a secret rather than holding one. */
const LAST_WORD_EXCEPTIONS = new Set([
  'count',
  'counts',
  'limit',
  'limits',
  'type',
  'usage',
  'tokens',
  'hint',
  'url',
  'uri',
  'endpoint',
  'method',
  'mode',
  'name',
  'id',
  'at',
  'expires',
  'expiry',
  'policy',
  'consent',
  'enabled',
  'required',
  'through',
  'less',
  'changed',
  'updated',
  'email',
]);

/** A run-together last word ending in one of these is an exception too: `passwordless`. */
const RUN_TOGETHER_ENDINGS = [
  'less',
  'count',
  'counts',
  'limit',
  'type',
  'usage',
  'hint',
  'url',
  'uri',
  'endpoint',
  'policy',
  'consent',
  'expires',
  'expiry',
  'name',
];

/** Headers whose names match a rule but whose values name headers or say yes or no. */
const HEADER_EXCEPTIONS = new Set([
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-request-headers',
]);

/**
 * A name's words, lowercased: split at every character that isn't a letter or digit, at
 * lower-to-upper changes (`accessToken`) and before the last capital of a run of capitals
 * followed by a lowercase letter (`X-CSRFToken` → x, csrf, token).
 */
export function nameWords(name: string): string[] {
  return name
    .slice(0, 256)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase());
}

/** Families from the most to the least sensitive; a name with several takes the first. */
const FAMILY_RANK: readonly SecretFamily[] = ['password', 'secret', 'token', 'session', 'code'];

const stronger = (a: SecretFamily | undefined, b: SecretFamily): SecretFamily =>
  a === undefined || FAMILY_RANK.indexOf(b) < FAMILY_RANK.indexOf(a) ? b : a;

/** The family of a secret name, or undefined if the name isn't a secret's. */
export function secretName(name: string, where: NameContext): SecretFamily | undefined {
  if (where === 'header' && HEADER_EXCEPTIONS.has(name.toLowerCase())) return undefined;
  const words = nameWords(name);
  if (words.length === 0) return undefined;
  if (where === 'query' || where === 'form') {
    if (CODE_NAMES.has(words.join(' '))) return 'code';
  }
  // Token counts and tokenizers are about tokens, not tokens themselves.
  if (words.some((w) => w === 'tokens' || w.startsWith('tokeniz'))) return undefined;
  const last = words[words.length - 1]!;
  // A session's ID is the session (`session_id`, `X-Session-Id`, `ASP.NET_SessionId`), but not
  // `session_id_type`.
  const beforeLast = words[words.length - 2];
  if (last === 'id' && (beforeLast === 'session' || beforeLast === 'sess')) return 'session';
  if (LAST_WORD_EXCEPTIONS.has(last)) return undefined;
  let found: SecretFamily | undefined;
  for (const word of words) {
    const family = WORDS.get(word);
    if (family) {
      found = stronger(found, family);
      continue;
    }
    if (word === 'key' && words.some((w) => KEY_QUALIFIERS.has(w))) {
      found = stronger(found, 'secret');
      continue;
    }
    // `secretary` and `secretariat` aren't secrets.
    if (word.startsWith('secretar')) continue;
    for (const [part, partFamily] of CONTAINED) {
      if (word.includes(part) && !(word === last && RUN_TOGETHER_ENDINGS.some((e) => word.endsWith(e)))) {
        found = stronger(found, partFamily);
        break;
      }
    }
  }
  return found;
}

/** Whether a value under a name of this family is a credential worth finding elsewhere. */
const STRONG_FAMILIES: ReadonlySet<SecretFamily> = new Set(['password', 'secret', 'token']);

/**
 * Whether a redacted value is distinctive enough to look for elsewhere: 16+ characters, or 8+
 * with letters and digits; never all digits, one lowercase word, or a URL or host name.
 */
export function distinctive(value: string): boolean {
  if (value.length < 8 || value.length > 4096) return false;
  if (/^\d+$/.test(value) || /^[a-z]+$/.test(value)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || /^(?:[a-z0-9-]{1,63}\.){1,10}[a-z]{2,24}$/i.test(value))
    return false;
  return value.length >= 16 || (/[A-Za-z]/.test(value) && /\d/.test(value));
}

// ---------------------------------------------------------------- spans

/**
 * The string with the spans replaced. Overlapping spans are joined. `marker` can be a function
 * of the span and its index, for numbered markers.
 */
export function applySpans(
  text: string,
  spans: readonly Span[],
  marker: string | ((span: Span, index: number) => string) = REDACTED,
): string {
  if (spans.length === 0) return text;
  const merged = mergeSpans(spans);
  let out = '';
  let at = 0;
  merged.forEach((span, index) => {
    out +=
      text.slice(at, span.start) +
      (span.replacement ?? (typeof marker === 'string' ? marker : marker(span, index)));
    at = span.end;
  });
  return out + text.slice(at);
}

/** Spans sorted by start, with overlapping ones joined (the first's kind and replacement kept). */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.start < last.end) {
      if (span.end > last.end) {
        last.end = span.end;
        // A joined span is no longer what a special replacement was made for.
        delete last.replacement;
      }
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

/** Counts spans into records, by name or kind. */
export function recordsOf(spans: readonly Span[]): Redaction[] {
  const counts = new Map<string, Redaction>();
  for (const span of mergeSpans(spans)) {
    const key = span.name !== undefined ? `n:${span.name}` : `k:${span.kind}`;
    const record = counts.get(key);
    if (record) record.count += 1;
    else
      counts.set(
        key,
        span.name !== undefined ? { name: span.name, count: 1 } : { kind: span.kind, count: 1 },
      );
  }
  return [...counts.values()];
}

/** Adds records into a list, joining those with the same name or kind. */
export function addRecords(into: Redaction[], records: readonly Redaction[]): void {
  for (const record of records) {
    const same = into.find((r) => r.name === record.name && r.kind === record.kind);
    if (same) same.count += record.count;
    else into.push({ ...record });
  }
}

// ---------------------------------------------------------------- token shapes

/**
 * Before a token: the start, a character that can't be part of one, or a percent escape
 * (`Bearer%20eyJ…`, `%3DeyJ…`).
 */
const B = '(?<=^|[^A-Za-z0-9_-]|%[0-9A-Fa-f]{2})';
/** After a token: the end, or a character that can't be part of one. */
const E = '(?![A-Za-z0-9_-])';

interface Shape {
  kind: string;
  pattern: RegExp;
  /** Which group to redact; 0 is the whole match. */
  group?: number;
  /** A further check on the redacted part. */
  check?: (value: string) => boolean;
}

const hasDigit = (value: string): boolean => /\d/.test(value);

/** A bearer token: has a digit, or is long and mixed-case (not a word). */
const bearerLike = (value: string): boolean =>
  hasDigit(value) || (value.length >= 32 && /[a-z]/.test(value) && /[A-Z]/.test(value));

/** Whether base64 decodes to printable `user:password`. */
function isBasicCredentials(value: string): boolean {
  let decoded: string;
  try {
    decoded = atob(value.length % 4 === 0 ? value : value + '='.repeat(4 - (value.length % 4)));
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  // eslint-disable-next-line no-control-regex -- printable ASCII and Latin-1 only
  return colon > 0 && colon < decoded.length - 1 && !/[\x00-\x1f\x7f-\x9f]/.test(decoded);
}

const SHAPES: readonly Shape[] = [
  {
    kind: 'JSON Web Token',
    pattern: new RegExp(
      `${B}eyJ[A-Za-z0-9_-]{8,2048}\\.eyJ[A-Za-z0-9_-]{8,65536}\\.[A-Za-z0-9_-]{0,2048}${E}`,
      'g',
    ),
  },
  {
    kind: 'JSON Web Encryption',
    pattern: new RegExp(
      `${B}eyJ[A-Za-z0-9_-]{8,2048}\\.[A-Za-z0-9_-]{0,4096}\\.[A-Za-z0-9_-]{8,256}\\.[A-Za-z0-9_-]{8,1048576}\\.[A-Za-z0-9_-]{8,256}${E}`,
      'g',
    ),
  },
  {
    kind: 'Bearer token',
    pattern: new RegExp(
      // No check of what follows: a longer run is redacted to the bound, and checking would
      // backtrack over the whole bound at every `bearer+` in hostile text.
      `${B}bearer(?:[ \\t]{1,8}|%20|\\+)([A-Za-z0-9._~+/-]{20,4096}={0,2})`,
      'gid',
    ),
    group: 1,
    check: bearerLike,
  },
  {
    kind: 'Basic credentials',
    pattern: new RegExp(`${B}basic(?:[ \\t]{1,8}|%20|\\+)([A-Za-z0-9+/]{4,4096}={0,2})`, 'gid'),
    group: 1,
    check: isBasicCredentials,
  },
  {
    kind: 'GitHub token',
    // GitHub allows up to 255 characters; installation tokens from April 2026 are `ghs_APPID_`
    // and a JWT (about 520 characters, with dots), per GitHub's changelog of April 24, 2026.
    pattern: new RegExp(`${B}gh[pousr]_[A-Za-z0-9._-]{30,1024}${E}`, 'g'),
  },
  { kind: 'GitHub token', pattern: new RegExp(`${B}github_pat_[A-Za-z0-9_]{22,255}${E}`, 'g') },
  { kind: 'GitLab token', pattern: new RegExp(`${B}glpat-[A-Za-z0-9._-]{20,255}${E}`, 'g') },
  { kind: 'AWS access key ID', pattern: new RegExp(`${B}(?:AKIA|ASIA)[A-Z0-9]{16}${E}`, 'g') },
  { kind: 'Google API key', pattern: new RegExp(`${B}AIza[A-Za-z0-9_-]{35}${E}`, 'g') },
  { kind: 'Google OAuth token', pattern: new RegExp(`${B}ya29\\.[A-Za-z0-9_-]{20,2048}${E}`, 'g') },
  { kind: 'Google OAuth client secret', pattern: new RegExp(`${B}GOCSPX-[A-Za-z0-9_-]{20,255}${E}`, 'g') },
  { kind: 'Slack token', pattern: new RegExp(`${B}(?:xoxe\\.)?xox[a-z]-[A-Za-z0-9-]{10,255}${E}`, 'g') },
  { kind: 'Slack token', pattern: new RegExp(`${B}(?:xoxe\\.)?xapp-[A-Za-z0-9-]{10,255}${E}`, 'g') },
  {
    kind: 'Slack webhook',
    pattern: /hooks\.slack\.com\/(?:services|workflows|triggers)\/([A-Za-z0-9_/-]{10,255})/dg,
    group: 1,
  },
  { kind: 'Stripe key', pattern: new RegExp(`${B}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}${E}`, 'g') },
  { kind: 'Stripe webhook secret', pattern: new RegExp(`${B}whsec_[A-Za-z0-9+/=]{16,255}${E}`, 'g') },
  {
    kind: 'API key',
    pattern: new RegExp(`${B}sk-(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{16,1024}${E}`, 'g'),
  },
  { kind: 'API key', pattern: new RegExp(`${B}sk-[A-Za-z0-9]{32,255}${E}`, 'g'), check: hasDigit },
  { kind: 'npm token', pattern: new RegExp(`${B}npm_[A-Za-z0-9]{36}${E}`, 'g') },
  { kind: 'Hugging Face token', pattern: new RegExp(`${B}hf_[A-Za-z0-9]{30,64}${E}`, 'g') },
  {
    kind: 'SendGrid key',
    pattern: new RegExp(`${B}SG\\.[A-Za-z0-9_-]{16,64}\\.[A-Za-z0-9_-]{16,128}${E}`, 'g'),
  },
  { kind: 'Shopify token', pattern: new RegExp(`${B}shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}${E}`, 'g') },
];

/** A private key's BEGIN line (PEM, or PGP's armor). */
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const MAX_KEY_BODY = 16384;

/** The width of a line break at `i`, real (`\n`, `\r\n`) or written out as in JSON; 0 if none. */
function lineBreak(text: string, i: number): number {
  for (const brk of ['\r\n', '\n', '\\r\\n', '\\n']) if (text.startsWith(brk, i)) return brk.length;
  return 0;
}

/** An armor header line's start: `Proc-Type: `, `Version: `, `Comment: `. */
const KEY_HEADER = /[A-Za-z][A-Za-z0-9-]{0,40}: /y;
/** What a key's body is made of: base64 and whitespace (line breaks are checked apart). */
const KEY_BODY = /[A-Za-z0-9+/=\s]/;

/**
 * Spans of private keys' bodies, up to 16 KB each. The BEGIN line must end the line, so prose
 * that names one isn't taken for a key. Then any header lines (`Proc-Type: 4,ENCRYPTED`, PGP's
 * `Version:` and `Comment:`), then base64 to the END line or the first character that can't be
 * part of a key. The BEGIN and END lines stay, so a reader can tell a key was there. Found in
 * code rather than one regex, which overflows its stack on a long body.
 */
function privateKeySpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(PRIVATE_KEY)) {
    const start = match.index + match[0].length;
    const limit = Math.min(text.length, start + MAX_KEY_BODY);
    let end = start + lineBreak(text, start);
    if (end === start) continue;
    // Header lines, each to its line break, but never past `-----`: otherwise each BEGIN would
    // scan on through the ones after it.
    for (;;) {
      KEY_HEADER.lastIndex = end;
      if (!KEY_HEADER.test(text)) break;
      let lineEnd = KEY_HEADER.lastIndex;
      while (lineEnd < limit && lineBreak(text, lineEnd) === 0 && !text.startsWith('-----', lineEnd))
        lineEnd++;
      const brk = lineBreak(text, lineEnd);
      end = lineEnd + brk;
      if (brk === 0) break;
    }
    while (end < limit && !text.startsWith('-----', end)) {
      const brk = lineBreak(text, end);
      if (brk > 0) end += brk;
      else if (KEY_BODY.test(text[end]!)) end++;
      else break;
    }
    spans.push({ start, end: Math.min(end, limit), kind: 'Private key' });
  }
  return spans;
}

/** Spans of token shapes in text. Each value found goes to `sink`, if distinctive. */
export function shapeSpans(text: string, sink?: ValueSink): Span[] {
  const spans: Span[] = privateKeySpans(text);
  for (const shape of SHAPES) {
    for (const match of text.matchAll(shape.pattern)) {
      const group = shape.group ?? 0;
      const value = match[group];
      if (value === undefined || value === '') continue;
      if (shape.check && !shape.check(value)) continue;
      const start = group === 0 ? match.index : match.indices![group]![0];
      spans.push({ start, end: start + value.length, kind: shape.kind });
      if (sink) addValue(sink, value.trim());
    }
  }
  return spans;
}

// ---------------------------------------------------------------- URLs

/**
 * Decodes percent escapes (and `+` as a space, for forms and queries). Escapes that aren't UTF-8
 * are decoded byte for byte as Latin-1, so one odd escape doesn't hide the rest.
 */
export function percentDecode(text: string, plusIsSpace = true): string {
  const spaced = plusIsSpace ? text.replace(/\+/g, ' ') : text;
  return spaced.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
  });
}

/** The most levels of URLs inside URLs looked into. */
const MAX_URL_DEPTH = 3;

/**
 * Whether a value, decoded once, holds something secret: a token shape, or a URL with secrets
 * (`?next=https%3A%2F%2F…%3Ftoken%3D…`). Then the whole value is redacted.
 */
function decodedHoldsSecret(value: string, depth: number, sink?: ValueSink): boolean {
  if (depth >= MAX_URL_DEPTH || !/%[0-9A-Fa-f]{2}|\+/.test(value)) return false;
  const decoded = percentDecode(value);
  // Too short to hold a token shape, and no URL in it: not worth scanning.
  if (decoded === value || (decoded.length < 16 && !/[=:/]/.test(decoded))) return false;
  return (
    shapeSpans(decoded, sink).length > 0 ||
    urlSpans(decoded, depth + 1, sink).length > 0 ||
    // Encoded twice: `https%253A%252F%252F…`.
    decodedHoldsSecret(decoded, depth + 1, sink)
  );
}

/**
 * Spans of `name=value` pairs with secret names in a query, fragment or matrix parameters.
 * `from` and `to` bound the part of `url` to look in; `separators` split the pairs.
 */
function parameterSpans(
  url: string,
  from: number,
  to: number,
  separators: RegExp,
  depth: number,
  sink?: ValueSink,
): Span[] {
  const spans: Span[] = [];
  let at = from;
  while (at < to) {
    separators.lastIndex = at;
    const next = separators.exec(url);
    const end = next && next.index < to ? next.index : to;
    const inPair = url.slice(at, end).indexOf('=');
    const eq = inPair < 0 ? -1 : at + inPair;
    if (eq >= 0) {
      // HTML writes `&` as `&amp;` (or `&#38;`): the pair starts after the entity's end.
      const entity = /^(?:amp|#38|#x26);/i.exec(url.slice(at, Math.min(eq, at + 6)));
      const rawName = url.slice(at + (entity ? entity[0].length : 0), eq);
      const name = percentDecode(rawName);
      const value = url.slice(eq + 1, end);
      // An empty value gives an empty span, which is dropped.
      const family = secretName(name, 'query');
      if (family) {
        spans.push({ start: eq + 1, end, kind: 'name', name });
        const decoded = percentDecode(value);
        if (STRONG_FAMILIES.has(family) && distinctive(decoded)) sink?.add(decoded);
      } else if (decodedHoldsSecret(value, depth, sink)) {
        spans.push({ start: eq + 1, end, kind: 'encoded', name });
      } else if (depth < MAX_URL_DEPTH && /[?#@;]/.test(value) && /=|:\/\//.test(value)) {
        // A URL inside, not encoded: `?next=https://app.example/cb?token=…`.
        for (const span of urlSpans(value, depth + 1, sink)) {
          spans.push({ ...span, start: eq + 1 + span.start, end: eq + 1 + span.end });
        }
      }
    }
    at = end + 1;
  }
  return spans;
}

/**
 * Spans to redact in a URL, absolute or not (`/path?query`): a password in `user:password@`,
 * query and fragment parameters with secret names, matrix parameters (`;jsessionid=…`), values
 * that hold a secret once decoded, and token shapes anywhere. Everything else stays as it was.
 */
export function urlSpans(url: string, depth = 0, sink?: ValueSink, shapes = true): Span[] {
  const spans: Span[] = [];
  const hash = url.indexOf('#');
  const beforeHash = hash < 0 ? url.length : hash;
  const question = url.indexOf('?');
  const queryAt = question >= 0 && question < beforeHash ? question : -1;
  const pathEnd = queryAt >= 0 ? queryAt : beforeHash;

  // user:password@ in the authority, found without scanning the whole URL. A URL starting with
  // `//` has an authority too.
  const scheme = url.startsWith('//') ? -1 : url.indexOf('://');
  let pathStart = 0;
  if (url.startsWith('//') || (scheme >= 0 && scheme < 64 && scheme < pathEnd)) {
    const authorityStart = scheme + 3;
    let authorityEnd = pathEnd;
    const slash = url.indexOf('/', authorityStart);
    if (slash >= 0 && slash < authorityEnd) authorityEnd = slash;
    pathStart = authorityEnd;
    const at = url.lastIndexOf('@', authorityEnd - 1);
    if (at >= authorityStart) {
      const colon = url.indexOf(':', authorityStart);
      if (colon >= 0 && colon < at) {
        spans.push({ start: colon + 1, end: at, kind: 'URL password' });
        const password = percentDecode(url.slice(colon + 1, at), false);
        if (distinctive(password)) sink?.add(password);
      }
    }
  }

  // Matrix parameters in the path's segments: /segment;name=value;name=value/…
  let semi = url.indexOf(';', pathStart);
  while (semi >= 0 && semi < pathEnd) {
    const slash = url.indexOf('/', semi);
    const end = slash >= 0 && slash < pathEnd ? slash : pathEnd;
    pushAll(spans, parameterSpans(url, semi + 1, end, /;/g, depth, sink));
    semi = url.indexOf(';', end);
  }

  // Queries and fragments split at `&` only: a `;` can be part of a value.
  if (queryAt >= 0) pushAll(spans, parameterSpans(url, queryAt + 1, beforeHash, /&/g, depth, sink));
  if (hash >= 0) pushAll(spans, parameterSpans(url, hash + 1, url.length, /&/g, depth, sink));
  if (shapes) pushAll(spans, shapeSpans(url, sink));
  return spans;
}

/** A URL with its secrets redacted, and what was redacted. */
export function redactUrl(url: string, sink?: ValueSink): { url: string; records: Redaction[] } {
  const spans = urlSpans(url, 0, sink);
  return { url: applySpans(url, spans), records: recordsOf(spans) };
}

/** Characters that end a URL found in text. */
const URL_END = /[\s"'<>`\\^{}|]|&quot;/g;
const ENDS_URL = /[\s"'<>`\\^{}|]/;
/** Punctuation a URL in prose doesn't end with: `(see https://…).` */
const PROSE_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);

/**
 * Where a URL found in prose ends: before trailing punctuation, and before closing brackets
 * the URL didn't open (`(see https://…/a_(b)), ok`). One pass, so it's linear.
 */
function proseEnd(raw: string): number {
  let parens = 0;
  let squares = 0;
  for (const c of raw) {
    if (c === '(') parens++;
    else if (c === ')') parens--;
    else if (c === '[') squares++;
    else if (c === ']') squares--;
  }
  let end = raw.length;
  while (end > 0) {
    const c = raw[end - 1]!;
    if (PROSE_PUNCTUATION.has(c)) end--;
    else if (c === ')' && parens < 0) {
      parens++;
      end--;
    } else if (c === ']' && squares < 0) {
      squares++;
      end--;
    } else break;
  }
  return end;
}

/** The character a JSON escape at `i` stands for, and its width; undefined if it isn't one. */
function jsonEscape(text: string, i: number): { char: string; width: number } | undefined {
  if (text[i] !== '\\') return undefined;
  if (text[i + 1] === '/') return { char: '/', width: 2 };
  const hex = /^\\u([0-9A-Fa-f]{4})/.exec(text.slice(i, i + 6));
  return hex ? { char: String.fromCharCode(parseInt(hex[1]!, 16)), width: 6 } : undefined;
}

/**
 * Spans of URLs found in text (`scheme://…`), with the URL rules applied. JSON's escapes
 * (`\/`, `\u0026` and the like) are undone before the rules run, and the spans mapped back.
 * HTML's `&amp;` is understood by the parameter rules.
 */
export function urlInTextSpans(text: string, sink?: ValueSink): Span[] {
  const spans: Span[] = [];
  for (const mark of [':\\/\\/', '://']) {
    let at = text.indexOf(mark);
    while (at >= 0) {
      // The scheme: letters before the mark, at most 32, starting with a letter.
      let start = at;
      while (start > 0 && at - start < 32 && /[A-Za-z0-9+.-]/.test(text[start - 1]!)) start--;
      while (start < at && !/[A-Za-z]/.test(text[start]!)) start++;
      if (start === at) {
        at = text.indexOf(mark, at + mark.length);
        continue;
      }
      // The end. The search goes on from where the last URL ended, so text is read once.
      const from = at + mark.length;
      let end = text.length;
      URL_END.lastIndex = from;
      for (let m = URL_END.exec(text); m; m = URL_END.exec(text)) {
        const escape = m[0] === '\\' ? jsonEscape(text, m.index) : undefined;
        // An escaped character inside the URL, unless it's one that ends a URL (`\u0022`).
        if (escape && !ENDS_URL.test(escape.char)) {
          URL_END.lastIndex = m.index + escape.width;
          continue;
        }
        end = m.index;
        break;
      }
      const whole = text.slice(start, end);
      const raw = whole.slice(0, proseEnd(whole));
      // Punctuation right after a value is likelier part of it (`password=hunter2!!`) than prose.
      const tail = /^[.,;:!?]*/.exec(whole.slice(raw.length))![0].length;
      const { decoded, offsets } = unescapeForUrl(raw);
      // Shapes are looked for only if undoing escapes changed the URL: otherwise textSpans finds
      // them in the text itself.
      for (const span of urlSpans(decoded, 0, sink, raw !== decoded)) {
        const atEnd = span.end === decoded.length;
        spans.push({
          ...span,
          start: start + offsets[span.start]!,
          end: start + offsets[span.end]! + (atEnd ? tail : 0),
        });
      }
      at = text.indexOf(mark, Math.max(end, at + mark.length));
    }
  }
  return spans;
}

/** JSON's escapes undone, with each decoded index's offset in the raw text. */
function unescapeForUrl(raw: string): { decoded: string; offsets: number[] } {
  let decoded = '';
  const offsets: number[] = [];
  let i = 0;
  while (i < raw.length) {
    const escape = jsonEscape(raw, i);
    offsets.push(i);
    decoded += escape ? escape.char : raw[i]!;
    i += escape ? escape.width : 1;
  }
  offsets.push(raw.length);
  return { decoded, offsets };
}

/** Spans in plain text: token shapes and URLs. */
export function textSpans(text: string, sink?: ValueSink): Span[] {
  const spans = shapeSpans(text, sink);
  pushAll(spans, urlInTextSpans(text, sink));
  return spans;
}

function addValue(sink: ValueSink, value: string): void {
  if (distinctive(value)) sink.add(value);
}

// ---------------------------------------------------------------- headers

/** Authorization schemes whose name is kept before the redacted credentials. */
const AUTH_SCHEMES = new Set(
  [
    'basic',
    'bearer',
    'digest',
    'negotiate',
    'ntlm',
    'token',
    'dpop',
    'aws4-hmac-sha256',
    'hoba',
    'mutual',
    'scram-sha-1',
    'scram-sha-256',
    'vapid',
    'oauth',
  ].map((s) => s.toLowerCase()),
);

/** Schemes whose credentials are one token, worth finding elsewhere. */
const TOKEN_SCHEMES = new Set(['basic', 'bearer', 'token', 'dpop']);

/**
 * `Authorization`'s value: a known scheme is kept (`Bearer [redacted]`); anything else whole.
 * Credentials that are one token go to `sink`; parameter lists such as Digest's don't.
 */
export function redactAuthorization(value: string, sink?: ValueSink): string {
  const match = /^(\s*)([A-Za-z0-9-]+)(\s+)(\S[\s\S]*)$/.exec(value);
  if (match && AUTH_SCHEMES.has(match[2]!.toLowerCase())) {
    const credentials = match[4]!.trim();
    if (sink && TOKEN_SCHEMES.has(match[2]!.toLowerCase()) && !/\s/.test(credentials))
      addValue(sink, credentials);
    return `${match[1]}${match[2]}${match[3]}${REDACTED}`;
  }
  if (sink && !/\s/.test(value.trim())) addValue(sink, value.trim());
  return value === '' ? value : REDACTED;
}

/** `Cookie`'s value: each cookie's value redacted, names kept. A piece with no `=` is all value. */
export function redactCookieHeader(value: string, sink?: ValueSink): { value: string; count: number } {
  let count = 0;
  const pieces = value.split(';').map((piece) => {
    const lead = /^\s*/.exec(piece)![0];
    const body = piece.slice(lead.length);
    if (body === '') return piece;
    const eq = body.indexOf('=');
    if (eq < 0) {
      count += 1;
      cookieValue(sink, '', body, false);
      return `${lead}${REDACTED}`;
    }
    const cookie = body.slice(eq + 1).trim();
    if (cookie === '') return piece;
    count += 1;
    cookieValue(sink, body.slice(0, eq).trim(), cookie, false);
    return `${lead}${body.slice(0, eq + 1)}${REDACTED}`;
  });
  return { value: pieces.join(';'), count };
}

/**
 * A cookie's value is collected only if it's likely a credential: its name is a secret's, it's
 * set HttpOnly, or it looks like a random token (16+ characters, two of lowercase, uppercase and
 * digits, and none of the punctuation of dates, paths, versions and the like). Not `tz` or
 * `theme`, a timestamp, or an analytics ID.
 */
function cookieValue(sink: ValueSink | undefined, name: string, value: string, httpOnly: boolean): void {
  if (!sink) return;
  const decoded = percentDecode(value.replace(/^"|"$/g, ''), false);
  if (!distinctive(decoded)) return;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/].filter((k) => k.test(decoded)).length;
  // Dots are allowed in long values: signed cookies such as `s:abc.def` and JWTs.
  // A dotted value needs a part with a digit, so long host names aren't taken.
  const tokenLike =
    decoded.length >= 16 &&
    kinds >= 2 &&
    !(decoded.length >= 32 ? /[/, ]/ : /[/:,. ]/).test(decoded) &&
    (!decoded.includes('.') || decoded.split('.').some((part) => part.length >= 8 && /\d/.test(part)));
  if (tokenLike || httpOnly || (name !== '' && secretName(name, 'form') !== undefined)) sink.add(decoded);
  else shapeSpans(decoded, sink);
}

const SET_COOKIE_ATTRIBUTES: ReadonlyMap<string, RegExp> = new Map([
  ['expires', /^[A-Za-z]{3},? \d{1,2}[ -][A-Za-z]{3}[ -]\d{2,4} \d{1,2}:\d{2}:\d{2} GMT$/],
  ['max-age', /^-?\d{1,12}$/],
  ['domain', /^\.?[A-Za-z0-9.-]{1,253}$/],
  ['path', /^\/[A-Za-z0-9\-._~!$&'()*+=:@/%]{0,1024}$/],
  ['secure', /^$/],
  ['httponly', /^$/],
  ['partitioned', /^$/],
  ['samesite', /^(?:strict|lax|none)$/i],
  ['priority', /^(?:low|medium|high)$/i],
]);

/**
 * `Set-Cookie`'s value: the cookie's value redacted and its name kept, then only known
 * attributes with values of the right form. Anything else is redacted: an unknown attribute,
 * or a second cookie folded into the line (`a=1; Path=/, b=secret`).
 */
export function redactSetCookie(value: string, sink?: ValueSink): { value: string; count: number } {
  const pieces = value.split(';');
  const httpOnly = pieces.some((piece, i) => i > 0 && piece.trim().toLowerCase() === 'httponly');
  let count = 0;
  const out = pieces.map((piece, i) => {
    const lead = /^\s*/.exec(piece)![0];
    const body = piece.slice(lead.length).trimEnd();
    if (body === '') return piece;
    const eq = body.indexOf('=');
    if (i === 0) {
      const cookie = eq < 0 ? body : body.slice(eq + 1);
      if (cookie.trim() === '') return piece;
      count += 1;
      cookieValue(sink, eq < 0 ? '' : body.slice(0, eq).trim(), cookie.trim(), httpOnly);
      return eq < 0 ? `${lead}${REDACTED}` : `${lead}${body.slice(0, eq + 1)}${REDACTED}`;
    }
    const name = (eq < 0 ? body : body.slice(0, eq)).trim().toLowerCase();
    const attribute = eq < 0 ? '' : body.slice(eq + 1).trim();
    const form = SET_COOKIE_ATTRIBUTES.get(name);
    if (form && form.test(attribute)) return piece;
    count += 1;
    return `${lead}${REDACTED}`;
  });
  return { value: out.join(';'), count };
}

/** Headers whose values are URLs. */
const URL_HEADERS = new Set([
  ':path',
  'location',
  'referer',
  'content-location',
  'x-original-url',
  'x-rewrite-url',
  'x-forwarded-uri',
  'x-original-uri',
]);

/** `Link`: each `<url>` redacted with the URL rules. */
function linkSpans(value: string, sink?: ValueSink): Span[] {
  const spans: Span[] = [];
  for (const match of value.matchAll(/<([^<>]*)>/g)) {
    const start = match.index + 1;
    for (const span of urlSpans(match[1]!, 0, sink))
      spans.push({ ...span, start: start + span.start, end: start + span.end });
  }
  return spans;
}

/** `Refresh`: `5; url=…`. */
function refreshSpans(value: string, sink?: ValueSink): Span[] {
  // One run of spaces can't be split between adjacent `\s*`, so this is linear.
  const match = /^\s*(?:[\d.]+\s*)?(?:[;,]\s*)?url\s*=\s*['"]?/i.exec(value);
  if (!match) return [];
  const start = match[0].length;
  // Up to the closing quote, if the URL was quoted.
  const quote = /['"]$/.exec(match[0])?.[0];
  const closing = quote ? value.lastIndexOf(quote) : -1;
  const end = closing >= start ? closing : value.length;
  return urlSpans(value.slice(start, end), 0, sink).map((s) => ({
    ...s,
    start: start + s.start,
    end: start + s.end,
  }));
}

/** `Sec-WebSocket-Protocol`: entries of 20+ characters that aren't plain words often carry a token. */
function protocolSpans(value: string): Span[] {
  const spans: Span[] = [];
  let at = 0;
  for (const piece of value.split(',')) {
    const trimmed = piece.trim();
    const start = at + piece.indexOf(trimmed);
    // Not a dotted lowercase name such as `com.example.protocol.v2` (whose parts are short).
    const plainName =
      /^[a-z0-9.-]+$/.test(trimmed) &&
      trimmed.split(/[.-]/).every((part) => part.length <= 16 && (part.length <= 4 || !/\d/.test(part)));
    if (trimmed.length >= 20 && !plainName) {
      spans.push({ start, end: start + trimmed.length, kind: 'WebSocket protocol token' });
    }
    at += piece.length + 1;
  }
  return spans;
}

/** One header's value redacted, and what was redacted. */
export function redactHeader(
  name: string,
  value: string,
  sink?: ValueSink,
): { value: string; records: Redaction[] } {
  const lower = name.toLowerCase();
  const byName = (count: number): Redaction[] => (count > 0 ? [{ name, count }] : []);
  if (lower === 'authorization' || lower === 'proxy-authorization') {
    const redacted = redactAuthorization(value, sink);
    return { value: redacted, records: byName(redacted === value ? 0 : 1) };
  }
  if (lower === 'authentication-info' || lower === 'proxy-authentication-info') {
    if (value.trim() === '') return { value, records: [] };
    return { value: REDACTED, records: byName(1) };
  }
  if (lower === 'cookie') {
    const { value: redacted, count } = redactCookieHeader(value, sink);
    return { value: redacted, records: byName(count) };
  }
  if (lower === 'set-cookie') {
    const { value: redacted, count } = redactSetCookie(value, sink);
    return { value: redacted, records: byName(count) };
  }
  let spans: Span[];
  if (URL_HEADERS.has(lower)) spans = urlSpans(value, 0, sink);
  else if (lower === 'link') spans = linkSpans(value, sink);
  else if (lower === 'refresh') spans = refreshSpans(value, sink);
  else if (lower === 'sec-websocket-protocol') spans = protocolSpans(value);
  else {
    const family = secretName(name, 'header');
    if (family && value.trim() !== '') {
      if (sink && STRONG_FAMILIES.has(family)) addValue(sink, value.trim());
      return { value: REDACTED, records: byName(1) };
    }
    spans = textSpans(value, sink);
  }
  if (lower === 'link' || lower === 'refresh' || lower === 'sec-websocket-protocol') {
    pushAll(spans, shapeSpans(value, sink));
  }
  return { value: applySpans(value, spans), records: recordsOf(spans) };
}

/** Headers (or trailers) with their secrets redacted, and what was redacted. */
export function redactHeaders(
  headers: readonly Header[],
  sink?: ValueSink,
): { headers: Header[]; records: Redaction[] } {
  const records: Redaction[] = [];
  const out = headers.map(([name, value]): Header => {
    const result = redactHeader(name, value, sink);
    addRecords(records, result.records);
    return [name, result.value];
  });
  return { headers: out, records };
}
