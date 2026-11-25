/**
 * Redacting a HAR entry for export: secrets in its URL, headers, trailers, bodies, WebSocket
 * messages and messages of its own, found by src/shared/redact.ts and src/shared/redact-body.ts.
 *
 * The redacted entry is built afresh from the fields named here, never by editing a copy: a
 * field this file doesn't know (one a later export adds) is left out, not written in clear.
 *
 * Runs in a worker thread (redact-worker.mts), so its imports carry `.ts` and are pure: Node
 * loads them from source in tests.
 */
import { formFields } from '../shared/form-fields.ts';
import { isFormEncoded, queryString } from '../shared/har-fields.ts';
import {
  applySpans,
  mergeSpans,
  recordsOf,
  redactHeaders,
  redactUrl,
  type Redaction,
} from '../shared/redact.ts';
import { isTextual, KnownValues, looksCompressed, redactBody, secretInBytes } from '../shared/redact-body.ts';

type Json = Record<string, unknown>;
type Header = [string, string];

/** What `harEntry` knows that the entry's JSON doesn't say (src/backend/har.ts, HarEntryMeta). */
export interface EntryMeta {
  cut: { request: boolean; response: boolean };
  base64Frames: number[];
  /** Text messages cut to their first 64 KB. */
  cutFrames?: number[];
}

/** A redaction made in one part of an entry: never the value. */
export interface EntryRecord extends Redaction {
  in: string;
}

/** Something left unchecked in one part of an entry. */
export interface NotScannedRecord {
  in: string;
  notScanned: string;
  count: number;
}

export interface RedactedEntry {
  entry: Json;
  /** Places redacted, in all. */
  values: number;
  /** Bodies or messages not checked: not text. */
  notScanned: number;
  /** Bodies or messages left out: they couldn't be redacted, or held a known value in binary. */
  leftOut: number;
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

/** A HAR header list as name/value pairs; anything else as none. */
function headersOf(value: unknown): Header[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((h): h is Json => isObject(h) && typeof h.name === 'string' && typeof h.value === 'string')
    .map((h) => [h.name as string, h.value as string]);
}

const toHar = (headers: Header[]): Array<{ name: string; value: string }> =>
  headers.map(([name, value]) => ({ name, value }));

const headerValue = (headers: Header[], name: string): string | undefined =>
  headers.find(([n]) => n.toLowerCase() === name)?.[1];

/** Collects the values an entry's URL, headers and trailers hold, before any entry is redacted. */
export function collectKnown(entry: Json, known: KnownValues): void {
  const request = isObject(entry.request) ? entry.request : {};
  const response = isObject(entry.response) ? entry.response : {};
  const url = str(request.url);
  if (url) redactUrl(url, known);
  for (const value of [request.headers, request._trailers, response.headers, response._trailers]) {
    redactHeaders(headersOf(value), known);
  }
}

/** The lightweight part of an entry `collectKnown` reads, to send to a worker cheaply. */
export function knownPart(entry: Json): Json {
  const request = isObject(entry.request) ? entry.request : {};
  const response = isObject(entry.response) ? entry.response : {};
  return {
    request: { url: request.url, headers: request.headers, _trailers: request._trailers },
    response: { headers: response.headers, _trailers: response._trailers },
  };
}

// ---------------------------------------------------------------- text from bytes

/** How a body's bytes were turned into text, to turn them back. */
export type Encoding = 'latin1' | 'utf16le' | 'utf16be';

/**
 * Whether bytes look like UTF-16 without a BOM: NULs in most of one byte position (the high byte
 * of each character) and few in the other. A stray NUL in UTF-8 or Latin-1 text, or a binary part
 * in a multipart upload, isn't that.
 */
function looksUtf16(bytes: Buffer): 'utf16le' | 'utf16be' | undefined {
  const pairs = Math.floor(bytes.length / 2);
  if (pairs < 2) return undefined;
  let even = 0;
  let odd = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0) even++;
    if (bytes[i + 1] === 0) odd++;
  }
  if (odd >= pairs * 0.9 && even <= pairs * 0.1) return 'utf16le';
  if (even >= pairs * 0.9 && odd <= pairs * 0.1) return 'utf16be';
  return undefined;
}

/**
 * Text of a body written as base64, if it can be had byte for byte: UTF-16 by its BOM, its
 * charset, or how its NULs fall; otherwise Latin-1, which maps every byte to one character and
 * back (NULs and all).
 */
export function textOfBytes(
  bytes: Buffer,
  mediaType: string,
): { text: string; encoding: Encoding } | undefined {
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(mediaType)?.[1]?.toLowerCase();
  const bomLE = bytes[0] === 0xff && bytes[1] === 0xfe;
  const bomBE = bytes[0] === 0xfe && bytes[1] === 0xff;
  const order: Encoding | undefined = bomLE
    ? 'utf16le'
    : bomBE
      ? 'utf16be'
      : charset === 'utf-16be'
        ? 'utf16be'
        : charset === 'utf-16le'
          ? 'utf16le'
          : looksUtf16(bytes);
  // Said to be UTF-16, in an order the bytes don't show: not text Wirescry can read surely.
  if (!order && charset?.startsWith('utf-16')) return undefined;
  if (!order) {
    // Many NULs, but not in a pattern UTF-16 shows: not checked, rather than read as Latin-1, where
    // an ASCII secret in UTF-16 would be `p\0a\0s\0s` and match nothing.
    let nuls = 0;
    for (const byte of bytes) if (byte === 0) nuls++;
    if (nuls > bytes.length * 0.2) return undefined;
    return { text: bytes.toString('latin1'), encoding: 'latin1' };
  }
  // Said to be UTF-16 but isn't, whole: not text Wirescry can put back byte for byte.
  if (bytes.length % 2 !== 0) return undefined;
  const le = order === 'utf16le' ? bytes : Buffer.from(bytes).swap16();
  try {
    // The BOM kept as a character, so it's written back.
    const text = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(le);
    return { text, encoding: order };
  } catch {
    return undefined;
  }
}

function bytesOfText(text: string, encoding: Encoding): Buffer {
  if (encoding === 'latin1') return Buffer.from(text, 'latin1');
  const le = Buffer.from(text, 'utf16le');
  return encoding === 'utf16le' ? le : le.swap16();
}

// ---------------------------------------------------------------- the entry

interface Body {
  /** The new text, or undefined to leave it out. */
  text: string | undefined;
  records: EntryRecord[];
  notScanned?: NotScannedRecord;
  leftOut: boolean;
}

/**
 * A body's text redacted. `base64` says it's written as base64; `undecoded`, that it's still
 * encoded (compressed) and can't be read; `cut`, that only its start was kept.
 */
function redactBodyText(
  where: string,
  text: string,
  mediaType: string,
  options: { base64: boolean; undecoded: boolean; cut: boolean },
  known: KnownValues,
): Body {
  const records: EntryRecord[] = [];
  const add = (redactions: Redaction[]): void => {
    for (const r of redactions) records.push({ in: where, ...r });
  };
  if (options.undecoded) {
    // Still compressed, so it can't be checked, yet anyone can decompress it: left out.
    return { text: undefined, records, leftOut: true };
  }
  if (!options.base64) {
    const result = redactBody(text, mediaType, known, { cut: options.cut });
    add(result.records);
    const redacted = applySpans(text, result.spans);
    return {
      text: redacted,
      records,
      ...(result.notScanned ? { notScanned: { in: where, notScanned: result.notScanned, count: 1 } } : {}),
      leftOut: false,
    };
  }
  const bytes = Buffer.from(text, 'base64');
  const notChecked = { in: where, notScanned: 'binary', count: 1 };
  // Compressed without saying so: anyone can decompress it, and nothing in it can be checked.
  if (looksCompressed(bytes)) return { text: undefined, records, notScanned: notChecked, leftOut: true };
  const asText = isTextual(mediaType) ? textOfBytes(bytes, mediaType) : undefined;
  if (!asText) {
    // Not text, or text it can't read: not checked by its type's rules, but left out if its bytes
    // show a secret.
    if (secretInBytes(bytes, known, { cut: options.cut })) {
      return { text: undefined, records, notScanned: notChecked, leftOut: true };
    }
    return { text, records, notScanned: notChecked, leftOut: false };
  }
  const result = redactBody(asText.text, mediaType, known, { cut: options.cut });
  // Read as UTF-16 or Latin-1, what's left is checked again byte for byte: as anyone decoding the
  // file differently would see it (ASCII after a BOM, UTF-32, ASCII among other text).
  const unit = asText.encoding === 'latin1' ? 1 : 2;
  const skip = result.spans.map((s): [number, number] => [s.start * unit, s.end * unit]);
  if (secretInBytes(bytes, known, { skip, cut: options.cut, type: mediaType }))
    return { text: undefined, records, leftOut: true };
  add(result.records);
  const redacted = applySpans(asText.text, result.spans);
  return {
    text: redacted === asText.text ? text : bytesOfText(redacted, asText.encoding).toString('base64'),
    records,
    ...(result.notScanned ? { notScanned: { in: where, notScanned: result.notScanned, count: 1 } } : {}),
    leftOut: false,
  };
}

/**
 * An entry redacted, built afresh from the fields named here. Throws if its URL or headers can't
 * be redacted (the caller leaves the entry out); a body or message that can't be is left out.
 */
export function redactHarEntry(entry: Json, meta: EntryMeta, known: KnownValues): RedactedEntry {
  const records: EntryRecord[] = [];
  const notScanned: NotScannedRecord[] = [];
  const notes: string[] = [];
  let leftOut = 0;
  const add = (where: string, redactions: Redaction[]): void => {
    for (const r of redactions) records.push({ in: where, ...r });
  };
  const sweep = (where: string, value: unknown): string | undefined => {
    const text = str(value);
    if (text === undefined || text === '') return text;
    try {
      const result = redactBody(text, 'text/plain', known);
      add(where, result.records);
      const swept = applySpans(text, result.spans);
      return applySpans(swept, [...known.scan(swept, true), ...known.anywhere(swept)]);
    } catch {
      return undefined;
    }
  };

  /** Known values in a short field, on their own or joined to other text (`id-<token>`). */
  const knownIn = (text: string) => [...known.scan(text, true), ...known.anywhere(text)];
  const hide = (text: string): string => applySpans(text, knownIn(text));
  const hideOptional = (text: string | undefined): string | undefined =>
    text === undefined ? undefined : hide(text);
  /** A value found anywhere in the export, hidden here too: the rules alone miss a repeat. */
  const scan = (where: string, text: string): string => {
    const spans = knownIn(text);
    if (spans.length > 0) add(where, recordsOf(mergeSpans(spans)));
    return applySpans(text, spans);
  };

  const request = isObject(entry.request) ? entry.request : {};
  const response = isObject(entry.response) ? entry.response : {};
  const undecoded = Array.isArray(entry._wirescryUndecoded) ? (entry._wirescryUndecoded as unknown[]) : [];

  // The URL and headers first: they must be redacted, or the entry isn't written at all.
  const url = redactUrl(str(request.url) ?? '', known);
  add('request.url', url.records);
  const scanHeaders = (where: string, headers: Header[]): Header[] =>
    headers.map(([name, value]) => [scan(where, name), scan(where, value)]);
  const side = (from: Json, name: string) => {
    const headers = redactHeaders(headersOf(from.headers), known);
    add(`${name}.headers`, headers.records);
    const trailers =
      from._trailers === undefined ? undefined : redactHeaders(headersOf(from._trailers), known);
    if (trailers) add(`${name}.trailers`, trailers.records);
    return { headers: headers.headers, trailers: trailers?.headers };
  };
  const requestHeaders = side(request, 'request');
  const responseHeaders = side(response, 'response');

  // A body's media type, from the redacted Content-Type (the raw one could hold anything).
  const mediaType = (headers: Header[], given: unknown): string =>
    headerValue(headers, 'content-type') ?? sweep('mimeType', given) ?? '';

  // The request body.
  let postData: Json | undefined;
  if (isObject(request.postData)) {
    const given = request.postData;
    const type = mediaType(requestHeaders.headers, given.mimeType);
    const base64 = given._encoding === 'base64';
    let body: Body;
    try {
      body = redactBodyText(
        'request.postData',
        str(given.text) ?? '',
        type,
        { base64, undecoded: undecoded.includes('request body'), cut: meta.cut.request },
        known,
      );
    } catch {
      body = { text: undefined, records: [], leftOut: true };
    }
    records.push(...body.records);
    if (body.notScanned) notScanned.push(body.notScanned);
    if (body.text === undefined) {
      leftOut += 1;
      notes.push("The request body was left out: it couldn't be redacted.");
      postData = { mimeType: type, text: '' };
    } else {
      postData = {
        mimeType: type,
        text: body.text,
        ...(base64 ? { _encoding: 'base64' } : {}),
        // Rebuilt from the redacted text, never copied.
        ...(isFormEncoded(type) && !base64
          ? { params: formFields(body.text).map(({ name, value }) => ({ name, value })) }
          : {}),
      };
    }
  }

  // The response body.
  const givenContent = isObject(response.content) ? response.content : {};
  const responseType = mediaType(responseHeaders.headers, givenContent.mimeType);
  const content: Json = { size: num(givenContent.size) ?? 0, mimeType: responseType };
  let responseText: string | undefined;
  let unreadable = false;
  try {
    responseText = str(givenContent.text);
  } catch {
    unreadable = true;
  }
  if (responseText !== undefined || unreadable) {
    const base64 = givenContent.encoding === 'base64';
    let body: Body;
    try {
      if (responseText === undefined) throw new Error('unreadable');
      body = redactBodyText(
        'response.content',
        responseText,
        responseType,
        { base64, undecoded: undecoded.includes('response body'), cut: meta.cut.response },
        known,
      );
    } catch {
      body = { text: undefined, records: [], leftOut: true };
    }
    records.push(...body.records);
    if (body.notScanned) notScanned.push(body.notScanned);
    if (body.text === undefined) {
      leftOut += 1;
      notes.push("The response body was left out: it couldn't be redacted.");
    } else {
      content.text = body.text;
      if (base64) content.encoding = 'base64';
    }
  }
  if (typeof givenContent.compression === 'number') content.compression = givenContent.compression;

  // WebSocket messages.
  let messages: Json[] | undefined;
  if (Array.isArray(entry._webSocketMessages)) {
    const base64Frames = new Set(meta.base64Frames);
    const cutFrames = new Set(meta.cutFrames ?? []);
    let framesNotScanned = 0;
    let framesLeftOut = 0;
    messages = [];
    entry._webSocketMessages.forEach((message: unknown, index) => {
      if (!isObject(message)) return;
      const opcode = num(message.opcode);
      const data = str(message.data) ?? '';
      const kept = { type: hideOptional(str(message.type)), time: num(message.time), opcode };
      try {
        if (opcode === 1) {
          const body = redactBodyText(
            'webSocketMessages',
            data,
            'text/plain',
            // Cut to its first 64 KB: a secret's value may run to the end.
            { base64: base64Frames.has(index), undecoded: false, cut: cutFrames.has(index) },
            known,
          );
          records.push(...body.records);
          if (body.notScanned) framesNotScanned += 1;
          if (body.leftOut) framesLeftOut += 1;
          messages!.push({ ...kept, data: body.text ?? '' });
        } else {
          // Binary: not checked by text's rules, and left out as a binary body is.
          framesNotScanned += 1;
          const body = redactBodyText(
            'webSocketMessages',
            data,
            'application/octet-stream',
            { base64: true, undecoded: false, cut: cutFrames.has(index) },
            known,
          );
          if (body.leftOut) framesLeftOut += 1;
          messages!.push({ ...kept, data: body.text ?? '' });
        }
      } catch {
        framesLeftOut += 1;
        messages!.push({ ...kept, data: '' });
      }
    });
    if (framesNotScanned > 0)
      notScanned.push({ in: 'webSocketMessages', notScanned: 'binary', count: framesNotScanned });
    if (framesLeftOut > 0) {
      leftOut += framesLeftOut;
      notes.push(
        framesLeftOut === 1
          ? "1 WebSocket message was left out: it couldn't be redacted."
          : `${framesLeftOut} WebSocket messages were left out: they couldn't be redacted.`,
      );
    }
  }

  // Last, so a value this entry's bodies taught is hidden in its URL and headers too.
  const redactedUrl = scan('request.url', url.url);
  const givenMethod = str(request.method);
  const method = givenMethod === undefined ? undefined : scan('request.method', givenMethod);
  const finalHeaders = (name: string, from: ReturnType<typeof side>) => ({
    headers: scanHeaders(`${name}.headers`, from.headers),
    trailers: from.trailers && scanHeaders(`${name}.trailers`, from.trailers),
  });
  const requestFinal = finalHeaders('request', requestHeaders);
  const responseFinal = finalHeaders('response', responseHeaders);
  // Read from the Content-Type before the bodies taught anything.
  if (postData) postData.mimeType = hide(str(postData.mimeType) ?? '');
  content.mimeType = hide(responseType);

  // Wirescry's own messages, which can quote a URL or an error.
  const givenFailure = isObject(entry._wirescryFailure) ? entry._wirescryFailure : undefined;
  const failure = givenFailure
    ? {
        kind: hideOptional(str(givenFailure.kind)),
        code: sweep('failure', givenFailure.code),
        message: sweep('failure', givenFailure.message),
        ...(givenFailure.detail !== undefined ? { detail: sweep('failure', givenFailure.detail) } : {}),
        ...(typeof givenFailure.partial === 'boolean' ? { partial: givenFailure.partial } : {}),
      }
    : undefined;
  const comment = [sweep('comment', entry.comment), ...notes].filter((c) => c).join(' ');

  // Records joined by where and what, and the not-scanned notes.
  const joined: EntryRecord[] = [];
  for (const given of records) {
    // A name can hold the secret itself (`X-Auth-<token>`).
    const record = given.name === undefined ? given : { ...given, name: hide(given.name) };
    const same = joined.find((r) => r.in === record.in && r.name === record.name && r.kind === record.kind);
    if (same) same.count += record.count;
    else joined.push({ ...record });
  }
  const values = joined.reduce((sum, r) => sum + r.count, 0);

  const redactedRequest: Json = {
    method,
    url: redactedUrl,
    httpVersion: hideOptional(str(request.httpVersion)),
    cookies: [],
    headers: toHar(requestFinal.headers),
    ...(requestFinal.trailers ? { _trailers: toHar(requestFinal.trailers) } : {}),
    queryString: queryString(redactedUrl),
    ...(postData ? { postData } : {}),
    headersSize: num(request.headersSize) ?? -1,
    bodySize: num(request.bodySize) ?? -1,
  };
  const redactedResponse: Json = {
    status: num(response.status) ?? 0,
    statusText: sweep('response.statusText', response.statusText) ?? '',
    httpVersion: hideOptional(str(response.httpVersion)),
    cookies: [],
    headers: toHar(responseFinal.headers),
    ...(responseFinal.trailers ? { _trailers: toHar(responseFinal.trailers) } : {}),
    content,
    redirectURL: headerValue(responseFinal.headers, 'location') ?? '',
    headersSize: num(response.headersSize) ?? -1,
    bodySize: num(response.bodySize) ?? -1,
  };
  const timings = isObject(entry.timings) ? entry.timings : {};
  const out: Json = {
    startedDateTime: hideOptional(str(entry.startedDateTime)),
    time: num(entry.time) ?? 0,
    request: redactedRequest,
    response: redactedResponse,
    cache: {},
    timings: Object.fromEntries(
      ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive'].map((k) => [k, num(timings[k]) ?? -1]),
    ),
  };
  if (entry._error !== undefined) out._error = sweep('error', entry._error);
  if (failure) out._wirescryFailure = failure;
  if (entry._wirescryRule !== undefined) out._wirescryRule = sweep('rule', entry._wirescryRule);
  // A device's label and Wirescry's own ID for it: kept, less any known value in them.
  if (isObject(entry._wirescrySource)) {
    const { kind, id, label } = entry._wirescrySource;
    out._wirescrySource = {
      kind: hideOptional(str(kind)),
      id: hideOptional(str(id)),
      label: hideOptional(str(label)),
    };
  }
  // Bodies still encoded are left out (see redactBodyText), so none is written as received.
  if (messages) {
    out._resourceType = 'websocket';
    out._webSocketMessages = messages;
  }
  if (typeof entry._wirescryDroppedMessages === 'number')
    out._wirescryDroppedMessages = entry._wirescryDroppedMessages;
  if (comment) out.comment = comment;
  if (joined.length > 0 || notScanned.length > 0) out._wirescryRedactions = [...joined, ...notScanned];
  return { entry: out, values, notScanned: notScanned.reduce((sum, r) => sum + r.count, 0), leftOut };
}
