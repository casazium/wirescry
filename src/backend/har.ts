/**
 * HAR (HTTP Archive 1.2) export and import: turning captured exchanges into a HAR file,
 * and a HAR file (from Wirescry, or a browser's developer tools) into exchanges.
 * Format: http://www.softwareishard.com/blog/har-12-spec/
 *
 * Pure conversion only; reading bodies and writing files is in backend.ts.
 */
import { grpcResultOf, isGrpcContentType } from '../shared/grpc';
import type {
  BodyContent,
  ExchangeDetail,
  ExchangeSource,
  ExchangeSummary,
  Header,
  WebSocketMessages,
} from '../shared/api';
import { describePartialFailure, type ExchangeFailure, type FailureKind } from '../shared/failure';
import { formFields } from '../shared/form-fields';

/** The largest HAR file Wirescry imports. */
export const MAX_HAR_IMPORT_BYTES = 256 * 1024 * 1024;
/** Bytes of each body written to a HAR file; longer ones are cut, and marked so. */
export const MAX_HAR_BODY_BYTES = 50 * 1024 * 1024;
const MAX_HEADERS = 500;
const MAX_HEADER_LENGTH = 64 * 1024;
const MAX_URL_LENGTH = 64 * 1024;
const METHOD = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,32}$/;

// ---------------------------------------------------------------- export

export interface HarExportItem {
  detail: ExchangeDetail;
  requestBody: BodyContent | null;
  responseBody: BodyContent | null;
  /** For a WebSocket: its messages. */
  messages?: WebSocketMessages;
  /** Anything else to say about this entry, e.g. a body that was still arriving. */
  notes?: string[];
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A body as HAR text: UTF-8 text as is, anything else as base64. */
function harText(content: BodyContent): { text: string; encoding?: 'base64' } {
  const bytes = Buffer.from(content.base64, 'base64');
  try {
    const text = utf8.decode(bytes);
    // Text with NULs is binary in disguise; keep it exact as base64.
    if (!text.includes('\u0000')) return { text };
  } catch {
    // Not UTF-8: base64 below.
  }
  return { text: content.base64, encoding: 'base64' };
}

const headerValue = (headers: Header[] | undefined, name: string): string | undefined =>
  headers?.find(([n]) => n.toLowerCase() === name)?.[1];

const harHeaders = (headers: Header[] | undefined): Array<{ name: string; value: string }> =>
  (headers ?? []).map(([name, value]) => ({ name, value }));

/** HAR's httpVersion from Mockttp's ("1.1", "2.0"); "" for one that isn't known, as browsers write. */
const harHttpVersion = (version: string): string =>
  version === '' ? '' : version.startsWith('2') ? 'HTTP/2.0' : `HTTP/${version}`;

/** Whether a Content-Type is an HTML form's default, whose fields HAR lists as postData.params. */
const isFormEncoded = (type: string | undefined): boolean =>
  type?.split(';')[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded';

function queryString(url: string): Array<{ name: string; value: string }> {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

const span = (from: number | undefined, to: number | undefined): number =>
  from !== undefined && to !== undefined && to >= from ? Math.round((to - from) * 1000) / 1000 : -1;

/** One HAR entry. Wirescry-only facts go in fields starting with "_", as the format allows. */
/** Said of a response exported while it was still arriving: what's in the file is only its start. */
const STILL_ARRIVING = 'The response was still arriving when this was exported.';

export function harEntry(item: HarExportItem): Record<string, unknown> {
  const { detail, requestBody, responseBody, messages } = item;
  const { summary, timing } = detail;
  const requestType = headerValue(detail.requestHeaders, 'content-type');
  const responseType = headerValue(detail.responseHeaders, 'content-type') ?? summary.contentType ?? '';
  const notes: string[] = [];
  const cut: string[] = [];
  const undecoded: string[] = [];

  let postData: Record<string, unknown> | undefined;
  if (requestBody && detail.requestBody && detail.requestBody.size > 0) {
    const body = harText(requestBody);
    // postData has no encoding field in HAR 1.2; mark base64 the way browsers do.
    postData = {
      mimeType: requestType ?? '',
      text: body.text,
      ...(body.encoding ? { _encoding: body.encoding } : {}),
      // A form's fields, decoded, as browsers' HAR files list them. Tools that read params
      // rather than text otherwise see an empty form, e.g. an OAuth token request.
      ...(isFormEncoded(requestType) && !body.encoding
        ? { params: formFields(body.text).map(({ name, value }) => ({ name, value })) }
        : {}),
    };
    if (requestBody.truncated || detail.requestBody.stored < detail.requestBody.size)
      cut.push('request body');
    if (requestBody.decodeError) undecoded.push('request body');
  }

  let content: Record<string, unknown> = { size: 0, mimeType: responseType };
  if (responseBody) {
    const body = harText(responseBody);
    const kept = responseBody.decodedSize ?? Buffer.from(responseBody.base64, 'base64').length;
    const wasCut =
      responseBody.truncated ||
      (detail.responseBody !== undefined && detail.responseBody.stored < detail.responseBody.size);
    // Only part of a body was kept: its full decoded size is known only when it wasn't encoded.
    const size = wasCut && !responseBody.encoding ? Math.max(kept, responseBody.size) : kept;
    content = {
      size,
      mimeType: responseType,
      text: body.text,
      ...(body.encoding ? { encoding: body.encoding } : {}),
      ...(responseBody.encoding && !wasCut && !responseBody.decodeError
        ? { compression: Math.max(0, kept - responseBody.size) }
        : {}),
    };
    if (wasCut) cut.push('response body');
    if (responseBody.decodeError) undecoded.push('response body');
  }
  if (detail.requestBody?.incomplete) notes.push('The request body ended early: the connection closed.');
  if (detail.responseBody?.incomplete) notes.push('The response body ended early: the connection closed.');

  const send = span(timing.startTimestamp, timing.bodyReceivedTimestamp);
  const wait = span(timing.bodyReceivedTimestamp, timing.headersSentTimestamp);
  const receive = span(timing.headersSentTimestamp, timing.responseSentTimestamp);

  const entry: Record<string, unknown> = {
    startedDateTime: new Date(summary.startedAt).toISOString(),
    time: summary.durationMs ?? 0,
    request: {
      method: summary.method,
      url: summary.url,
      httpVersion: harHttpVersion(summary.httpVersion),
      cookies: [],
      headers: harHeaders(detail.requestHeaders),
      // HAR has no place for trailers; Wirescry adds its own field, as Chrome does for WebSockets.
      ...(detail.requestTrailers?.length ? { _trailers: harHeaders(detail.requestTrailers) } : {}),
      queryString: queryString(summary.url),
      ...(postData ? { postData } : {}),
      headersSize: -1,
      bodySize: detail.requestBody?.size ?? 0,
    },
    response: {
      status: summary.status ?? 0,
      statusText: summary.statusMessage ?? '',
      httpVersion: harHttpVersion(summary.httpVersion),
      cookies: [],
      headers: harHeaders(detail.responseHeaders),
      ...(detail.responseTrailers?.length ? { _trailers: harHeaders(detail.responseTrailers) } : {}),
      content,
      redirectURL: headerValue(detail.responseHeaders, 'location') ?? '',
      headersSize: -1,
      bodySize: summary.responding
        ? -1
        : (summary.responseSize ?? detail.responseBody?.size ?? (summary.status ? 0 : -1)),
    },
    cache: {},
    timings: {
      blocked: -1,
      dns: -1,
      connect: -1,
      ssl: -1,
      send: Math.max(0, send),
      wait: Math.max(0, wait),
      receive: Math.max(0, receive),
    },
  };
  // A response still arriving is exported as cut off, so it doesn't come back as finished.
  const failure: ExchangeFailure | undefined =
    summary.failure ??
    (summary.responding
      ? { ...describePartialFailure('INCOMPLETE', summary.host), message: STILL_ARRIVING }
      : undefined);
  if (failure) {
    // _error is the browsers' field (a message); _wirescryFailure keeps Wirescry's details.
    entry._error = failure.message;
    entry._wirescryFailure = failure;
  }
  if (summary.handledBy) entry._wirescryRule = summary.handledBy.label;
  // The device it came from (e.g. an Android phone), when not this computer.
  if (summary.source) entry._wirescrySource = { ...summary.source };
  if (cut.length > 0) notes.unshift(`Wirescry kept only part of the ${cut.join(' and ')}.`);
  if (undecoded.length > 0) {
    // The text is the raw, still-encoded bytes: say so, as readers would take it as decoded.
    entry._wirescryUndecoded = undecoded;
    notes.push(
      `The ${undecoded.join(' and ')} couldn't be decoded, so it is written as received (still encoded).`,
    );
  }
  if (summary.websocket && messages) {
    entry._resourceType = 'websocket';
    let cutMessages = 0;
    entry._webSocketMessages = messages.messages.map((m) => {
      const bytes = Buffer.from(m.base64, 'base64');
      if (bytes.length < m.size) cutMessages += 1;
      let data = m.base64;
      if (!m.isBinary) {
        try {
          data = utf8.decode(bytes);
        } catch {
          // Keep base64.
        }
      }
      return {
        type: m.fromClient ? 'send' : 'receive',
        time: (summary.startedAt + m.time) / 1000,
        opcode: m.isBinary ? 2 : 1,
        data,
      };
    });
    if (messages.dropped > 0) {
      entry._wirescryDroppedMessages = messages.dropped;
      notes.push(`The first ${messages.dropped} WebSocket messages weren't kept, to save memory.`);
    }
    if (cutMessages > 0) notes.push(`${cutMessages} WebSocket messages were cut to their first 64 KB.`);
  }
  notes.push(...(item.notes ?? []));
  if (notes.length > 0) entry.comment = notes.join(' ');
  return entry;
}

/** The HAR file around the entries, as text before and after them. */
export function harFrame(version: string): { head: string; tail: string } {
  const creator = JSON.stringify({ name: 'Wirescry', version });
  return { head: `{"log":{"version":"1.2","creator":${creator},"pages":[],"entries":[\n`, tail: '\n]}}\n' };
}

// ---------------------------------------------------------------- import

/** A WebSocket message read from a HAR file. */
export interface ImportedMessage {
  fromClient: boolean;
  isBinary: boolean;
  /** Milliseconds since the connection started. */
  time: number;
  content: Buffer;
}

/** An exchange read from a HAR file, ready for the store. Bodies are decoded already. */
export interface ImportedExchange {
  summary: Omit<ExchangeSummary, 'id'>;
  requestHeaders: Header[];
  responseHeaders?: Header[];
  requestTrailers?: Header[];
  responseTrailers?: Header[];
  timing: ExchangeDetail['timing'];
  requestBody?: Buffer;
  responseBody?: Buffer;
  messages?: ImportedMessage[];
}

export interface HarImport {
  exchanges: ImportedExchange[];
  /** Entries left out, and why (the first few). */
  skipped: number;
  problems: string[];
}

/** WebSocket messages read per connection; the rest are left out. */
const MAX_IMPORTED_MESSAGES = 50_000;
/**
 * An entry bigger than this isn't read: parsing it could take more memory than the
 * backend has. (A 50 MB body is about 67 MB of base64.)
 */
const MAX_ENTRY_CHARS = 150 * 1024 * 1024;
const MAX_ENTRY_CONTAINERS = 1_000_000;
/** After this many unreadable entries, the rest are counted without being read. */
const MAX_BAD_ENTRIES = 100_000;
/** No timing in a HAR file is longer than this (about four months), so nothing overflows. */
const MAX_MS = 1e10;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,128}$/;

/** URLs browsers record that aren't network requests (data:, blob:, extensions). Left out quietly. */
class NotNetwork extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Trailers from Wirescry's own `_trailers` field. Another tool's file may use the name for
 * something else, so trailers that don't read as headers are left out, not the whole entry.
 */
function trailersOf(value: unknown, where: string): Header[] | undefined {
  try {
    const trailers = headersOf(value, where);
    return trailers.length > 0 ? trailers : undefined;
  } catch {
    return undefined;
  }
}

function headersOf(value: unknown, where: string): Header[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${where} headers aren't a list`);
  if (value.length > MAX_HEADERS) throw new Error(`${where} has over ${MAX_HEADERS} headers`);
  return value.map((h) => {
    if (!isObject(h) || typeof h.name !== 'string' || typeof h.value !== 'string') {
      throw new Error(`${where} has a header without a name and value`);
    }
    if (h.name.length > MAX_HEADER_LENGTH || h.value.length > MAX_HEADER_LENGTH) {
      throw new Error(`${where} has a header over 64 KB`);
    }
    return [h.name, h.value] as Header;
  });
}

/** Bytes from base64, standard or URL-safe. */
function fromBase64(text: string, what: string): Buffer {
  if (!/^[A-Za-z0-9+/=\s_-]*$/.test(text)) throw new Error(`${what} marked base64 isn't base64`);
  return Buffer.from(text, 'base64');
}

/** Body bytes from HAR text, which is base64 when `encoding` says so. */
function bodyOf(text: unknown, encoding: unknown): Buffer | undefined {
  if (typeof text !== 'string' || text === '') return undefined;
  return encoding === 'base64' ? fromBase64(text, 'a body') : Buffer.from(text, 'utf8');
}

/** A request body: postData's text, or a form rebuilt from its params when there is no text. */
function requestBodyOf(postData: Record<string, unknown> | undefined): Buffer | undefined {
  if (!postData) return undefined;
  const body = bodyOf(postData.text, postData._encoding ?? postData.encoding);
  if (body || !Array.isArray(postData.params) || postData.params.length === 0) return body;
  const form = new URLSearchParams();
  for (const param of postData.params) {
    if (isObject(param) && typeof param.name === 'string')
      form.append(param.name, typeof param.value === 'string' ? param.value : '');
  }
  const text = form.toString();
  return text ? Buffer.from(text, 'utf8') : undefined;
}

/** A duration in milliseconds: 0 for anything missing, negative (HAR's -1) or absurd. */
const ms = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, MAX_MS) : 0;

/**
 * Mockttp's httpVersion ("1.1", "2.0") from HAR's ("HTTP/1.1", "h2", "HTTP/2.0", …): the first of
 * `values` that says. "" when none does: browsers write "", "unknown" or nothing at all, and
 * guessing HTTP/1.1 would show a version nobody recorded.
 */
function httpVersionOf(...values: unknown[]): string {
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (/^(h2|http\/2)/.test(text)) return '2.0';
    if (/^(h3|http\/3)/.test(text)) return '3.0';
    if (text === 'http/1.0') return '1.0';
    if (text === 'http/1.1') return '1.1';
  }
  return '';
}

const FAILURE_KINDS: FailureKind[] = [
  'dns',
  'refused',
  'tls',
  'timeout',
  'reset',
  'unreachable',
  'client-closed',
  'rule',
  'blocked',
  'other',
];

/** A failure from Wirescry's own field, or a browser's `_error` message. */
function failureOf(wirescry: unknown, error: unknown): ExchangeFailure | undefined {
  const text = (value: unknown, max: number): string | undefined =>
    typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined;
  if (
    isObject(wirescry) &&
    FAILURE_KINDS.includes(wirescry.kind as FailureKind) &&
    text(wirescry.message, 500)
  ) {
    return {
      kind: wirescry.kind as FailureKind,
      code: text(wirescry.code, 64) ?? 'IMPORTED',
      message: text(wirescry.message, 500)!,
      ...(text(wirescry.detail, 2000) ? { detail: text(wirescry.detail, 2000) } : {}),
      ...(wirescry.partial === true ? { partial: true } : {}),
    };
  }
  const message = text(error, 500);
  return message ? { kind: 'other', code: 'IMPORTED', message } : undefined;
}

/** The media type from a Content-Type, e.g. `application/json`; undefined if it isn't one. */
function mediaType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const type = value.slice(0, 300).split(';')[0]!.trim().toLowerCase();
  return MEDIA_TYPE.test(type) ? type : undefined;
}

/** WebSocket messages in Chrome's `_webSocketMessages` form: {type, time (seconds), opcode, data}. */
function messagesOf(value: unknown, startedAt: number): ImportedMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const messages: ImportedMessage[] = [];
  for (const m of value) {
    if (messages.length >= MAX_IMPORTED_MESSAGES) break;
    if (!isObject(m) || (m.type !== 'send' && m.type !== 'receive') || typeof m.data !== 'string') continue;
    if (m.opcode !== 1 && m.opcode !== 2) continue; // Control frames (close, ping, pong).
    const isBinary = m.opcode === 2;
    const time = typeof m.time === 'number' && Number.isFinite(m.time) ? m.time * 1000 - startedAt : 0;
    let content: Buffer;
    try {
      content = isBinary ? fromBase64(m.data, 'a WebSocket message') : Buffer.from(m.data, 'utf8');
    } catch {
      continue; // One bad message doesn't spoil the rest.
    }
    messages.push({
      fromClient: m.type === 'send',
      isBinary,
      time: Math.min(Math.max(0, time), MAX_MS),
      content,
    });
  }
  return messages;
}

function exchangeOf(entry: unknown): ImportedExchange {
  if (!isObject(entry) || !isObject(entry.request) || !isObject(entry.response)) {
    throw new Error('not an entry with a request and response');
  }
  const { request, response } = entry;
  if (typeof request.url !== 'string' || request.url.length > MAX_URL_LENGTH) throw new Error('no valid URL');
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new Error(`invalid URL ${request.url.slice(0, 80)}`);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    if (['data:', 'blob:', 'about:', 'chrome-extension:', 'moz-extension:'].includes(url.protocol))
      throw new NotNetwork();
    throw new Error(`unsupported URL ${url.protocol.slice(0, 40)}`);
  }
  if (typeof request.method !== 'string' || !METHOD.test(request.method)) throw new Error('no valid method');
  const startedAt = typeof entry.startedDateTime === 'string' ? Date.parse(entry.startedDateTime) : NaN;
  if (!Number.isFinite(startedAt)) throw new Error('no valid start time');

  const requestHeaders = headersOf(request.headers, 'the request');
  const responseHeaders = headersOf(response.headers, 'the response');
  const requestTrailers = trailersOf(request._trailers, 'the request trailers');
  const responseTrailers = trailersOf(response._trailers, 'the response trailers');
  const requestBody = requestBodyOf(isObject(request.postData) ? request.postData : undefined);
  const content = isObject(response.content) ? response.content : {};
  const responseBody = bodyOf(content.text, content.encoding);

  const status =
    typeof response.status === 'number' && response.status >= 100 && response.status <= 999
      ? response.status
      : undefined;
  const timings = isObject(entry.timings) ? entry.timings : {};
  // Waiting, DNS and connecting come before sending; ssl is part of connect already.
  const before = ms(timings.blocked) + ms(timings.dns) + ms(timings.connect);
  const send = before + ms(timings.send);
  const wait = send + ms(timings.wait);
  const received = wait + ms(timings.receive);
  const time = ms(entry.time);
  const websocket = url.protocol === 'ws:' || url.protocol === 'wss:' || entry._resourceType === 'websocket';
  const messages = websocket ? messagesOf(entry._webSocketMessages, startedAt) : undefined;
  const contentType =
    mediaType(content.mimeType) ??
    mediaType(responseHeaders.find(([n]) => n.toLowerCase() === 'content-type')?.[1]);
  const grpc =
    isGrpcContentType(mediaType(requestHeaders.find(([n]) => n.toLowerCase() === 'content-type')?.[1])) ||
    isGrpcContentType(contentType);
  const grpcResult =
    grpc && status !== undefined ? grpcResultOf(responseHeaders, responseTrailers) : undefined;
  // Browsers write status 0 for requests that were canceled, blocked or never answered.
  const failure =
    failureOf(entry._wirescryFailure, entry._error) ??
    (status === undefined && !websocket
      ? { kind: 'other' as const, code: 'IMPORTED', message: 'No response in the HAR file' }
      : undefined);
  // On the wire if the file says (compressed), else the size of what's there.
  const wireSize =
    typeof response.bodySize === 'number' && response.bodySize >= 0
      ? response.bodySize
      : typeof content.size === 'number' && content.size >= 0
        ? content.size
        : responseBody?.length;

  return {
    summary: {
      method: request.method.toUpperCase(),
      protocol: url.protocol.replace(/:$/, '').replace(/^ws/, 'http'),
      httpVersion: httpVersionOf(request.httpVersion, response.httpVersion),
      host: url.host,
      path: url.pathname + url.search,
      url: url.href,
      startedAt,
      ...(status !== undefined
        ? {
            status,
            statusMessage: typeof response.statusText === 'string' ? response.statusText.slice(0, 200) : '',
          }
        : {}),
      durationMs: Math.max(time, received),
      ...(contentType ? { contentType } : {}),
      ...(status !== undefined && wireSize !== undefined ? { responseSize: Math.min(wireSize, MAX_MS) } : {}),
      ...(failure ? { failure } : {}),
      ...(websocket ? { websocket: true, messageCount: messages?.length ?? 0 } : {}),
      ...(sourceOf(entry._wirescrySource) ?? {}),
      ...(grpc ? { grpc: true as const } : {}),
      ...(grpcResult ? { grpcStatus: grpcResult.status } : {}),
      ...(grpcResult?.message !== undefined ? { grpcMessage: grpcResult.message } : {}),
    },
    requestHeaders,
    ...(status !== undefined ? { responseHeaders } : {}),
    ...(requestTrailers ? { requestTrailers } : {}),
    ...(status !== undefined && responseTrailers ? { responseTrailers } : {}),
    timing: {
      startTimestamp: 0,
      bodyReceivedTimestamp: send,
      headersSentTimestamp: wait,
      responseSentTimestamp: Math.max(time, received),
    },
    ...(requestBody ? { requestBody } : {}),
    ...(responseBody ? { responseBody } : {}),
    ...(messages && messages.length > 0 ? { messages } : {}),
  };
}

// HAR files can be hundreds of megabytes. Parsing one whole builds every entry at once,
// which can take gigabytes and stall the proxy. So this walks the text and parses one
// entry at a time, pausing now and then to let other work run.

class NotJson extends Error {}

const SCALAR_END = /[\s,}\]]/g;

/** Walks JSON text without building it, to find values and where they end. */
class JsonWalker {
  private i = 0;
  /** Objects and arrays in the last value read. */
  containers = 0;
  constructor(private readonly s: string) {}

  /** The next significant character, without moving past it. */
  peek(): string | undefined {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) return s[this.i];
      this.i++;
    }
    return undefined;
  }

  take(char: string): void {
    if (this.peek() !== char) throw new NotJson();
    this.i++;
  }

  /** Moves past `char` if it's next. */
  takeIf(char: string): boolean {
    if (this.peek() !== char) return false;
    this.i++;
    return true;
  }

  private skipString(): void {
    const s = this.s;
    let from = this.i + 1;
    for (;;) {
      const quote = s.indexOf('"', from);
      if (quote < 0) throw new NotJson();
      let slashes = 0;
      while (s.charCodeAt(quote - 1 - slashes) === 0x5c) slashes++;
      from = quote + 1;
      if (slashes % 2 === 0) break;
    }
    this.i = from;
  }

  /** A string key. */
  key(): string {
    if (this.peek() !== '"') throw new NotJson();
    const start = this.i;
    this.skipString();
    return JSON.parse(this.s.slice(start, this.i)) as string;
  }

  /** The text of the next value, moving past it. Checked for nesting only; JSON.parse checks the rest. */
  value(): string {
    const s = this.s;
    const first = this.peek();
    const start = this.i;
    this.containers = 0;
    if (first === undefined) throw new NotJson();
    if (first === '"') {
      this.skipString();
    } else if (first === '{' || first === '[') {
      let depth = 0;
      while (this.i < s.length) {
        const c = s.charCodeAt(this.i);
        if (c === 0x22) {
          this.skipString();
          continue;
        }
        if (c === 0x7b || c === 0x5b) {
          depth++;
          this.containers++;
        } else if (c === 0x7d || c === 0x5d) depth--;
        this.i++;
        if (depth === 0) break;
      }
      if (depth !== 0) throw new NotJson();
    } else {
      SCALAR_END.lastIndex = this.i;
      this.i = SCALAR_END.exec(s)?.index ?? s.length;
    }
    return s.slice(start, this.i);
  }

  /** Calls `each` for each key of an object, which must read or skip its value. */
  async object(each: (key: string) => Promise<void> | void): Promise<void> {
    this.take('{');
    if (this.takeIf('}')) return;
    do {
      const key = this.key();
      this.take(':');
      await each(key);
    } while (this.takeIf(','));
    this.take('}');
  }

  end(): void {
    if (this.peek() !== undefined) throw new NotJson();
  }
}

const pause = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Reads a HAR file's text, at most `maxEntries` exchanges. Throws if it isn't HAR at all;
 * skips (and counts) bad entries.
 */
export async function parseHar(text: string, maxEntries: number): Promise<HarImport> {
  const result: HarImport = { exchanges: [], skipped: 0, problems: [] };
  // A byte order mark some editors add is fine.
  const walker = new JsonWalker(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  let found = false;
  let more = 0;

  const entries = async (): Promise<void> => {
    walker.take('[');
    if (walker.takeIf(']')) return;
    let index = 0;
    let since = performance.now();
    do {
      const raw = walker.value();
      const tooLarge = raw.length > MAX_ENTRY_CHARS || walker.containers > MAX_ENTRY_CONTAINERS;
      index += 1;
      // Let other work run every ~20 ms.
      if (performance.now() - since > 20) {
        await pause();
        since = performance.now();
      }
      if (result.exchanges.length >= maxEntries) {
        more += 1;
        continue;
      }
      if (result.skipped >= MAX_BAD_ENTRIES) {
        // A file of mostly junk: stop reading entries closely, just count the rest.
        if (result.skipped === MAX_BAD_ENTRIES)
          result.problems.push(
            `After ${MAX_BAD_ENTRIES.toLocaleString()} unreadable entries, the rest were skipped.`,
          );
        result.skipped += 1;
        continue;
      }
      try {
        if (tooLarge) throw new Error('too large to read');
        result.exchanges.push(exchangeOf(JSON.parse(raw)));
      } catch (error) {
        if (error instanceof NotNetwork) continue;
        result.skipped += 1;
        const why = error instanceof SyntaxError ? "it isn't valid JSON" : (error as Error).message;
        if (result.problems.length < 5) result.problems.push(`Entry ${index}: ${why}.`);
      }
    } while (walker.takeIf(','));
    walker.take(']');
  };

  try {
    const first = walker.peek();
    if (first !== '{') {
      if (first === '[') throw new Error("That file isn't a HAR file: it has no log.entries.");
      throw new NotJson();
    }
    await walker.object(async (key) => {
      if (key !== 'log' || found || walker.peek() !== '{') return void walker.value();
      await walker.object(async (logKey) => {
        if (logKey !== 'entries' || found || walker.peek() !== '[') return void walker.value();
        found = true;
        await entries();
      });
    });
    walker.end();
  } catch (error) {
    if (error instanceof NotJson || error instanceof SyntaxError)
      throw new Error("That file isn't valid JSON, so it isn't a HAR file.", { cause: error });
    throw error;
  }
  if (!found) throw new Error("That file isn't a HAR file: it has no log.entries.");
  if (more > 0) {
    result.skipped += more;
    result.problems.push(`Only the first ${maxEntries.toLocaleString()} entries were imported.`);
  }
  return result;
}

/** A `_wirescrySource` written by Wirescry's export, checked: an imported file can hold anything. */
function sourceOf(value: unknown): { source: ExchangeSource } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, id, label } = value as Record<string, unknown>;
  if (kind !== 'android' || typeof id !== 'string' || typeof label !== 'string') return undefined;
  if (!id || id.length > 200 || !label || label.length > 100) return undefined;
  return { source: { kind, id, label } };
}
