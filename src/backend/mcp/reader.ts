/**
 * What the MCP server's tools can read: captured traffic, masked. Every method returns plain
 * objects built field by field from an allowlist, with each string that can hold a secret masked
 * by the mask worker (the shared rules and the session's known values: see masker.ts). Nothing
 * unmasked is reachable from here, and nothing here changes anything.
 */
import type {
  BodySide,
  ExchangeDetail,
  ExchangeSummary,
  Header,
  SseEventsView,
  WebSocketMessages,
} from '../../shared/api';
import { compileQuery, MAX_QUERY_LENGTH, tokenize } from '../../shared/query';
import { isEventStream, type SseItem } from '../../shared/sse';
import type { MaskField } from '../mask-body';
import type { FieldsAnswer } from '../masker';
import { collectResult, ResultError } from './plugin-result';

type Json = Record<string, unknown>;

/** What the backend gives the reader: raw reads, and the masking it must put them through. */
export interface ReaderBackend {
  /** Every exchange, oldest first. */
  summaries(): ExchangeSummary[];
  detail(id: string): ExchangeDetail | undefined;
  /** Fields masked as an agent's job, with the session's values (and `own`'s). */
  maskFields(fields: MaskField[], own: Json): Promise<FieldsAnswer>;
  /** An exchange's own URL, headers and trailers, as the worker learns them. */
  part(detail: ExchangeDetail): Json;
  /** A body, read capped and masked as an agent's job (getBody with `mask`); null if none. */
  body(detail: ExchangeDetail, side: BodySide): Promise<import('../../shared/api').BodyContent | null>;
  /** A page of a WebSocket's stored messages, as getWebSocketMessages gives them. */
  wsPage(id: string, after: number, limit: number): WebSocketMessages;
  /** A page masked as an agent's job, with the agent's stream key. */
  maskMessages(detail: ExchangeDetail, page: WebSocketMessages, fresh: boolean): Promise<WebSocketMessages>;
  /** An event stream's kept items after `after`, as getSseEvents reads them. */
  sseRead(id: string, after: number): Promise<SseEventsView | null>;
  maskEvents(detail: ExchangeDetail, view: SseEventsView, fresh: boolean): Promise<SseEventsView>;
  /** Changes when the mask worker restarts, losing what streams had learned. */
  generation(): number;
}

/** Why something can't be given: shown to the agent as the tool's error. */
export class ReadError extends Error {}

/** The mask worker no longer has what a stream taught it (restarted, or let it go for others). */
export class StreamLost extends Error {
  constructor() {
    super('The stream’s learned values were lost.');
  }
}

/** A field term compared with = or != whose value has a wildcard. */
const WILDCARD_TERM = /^[a-z]+!?=.*[*?]/i;

export const MAX_LIST = 200;
export const MAX_CHARS = 100_000;
export const MAX_MESSAGES = 200;
/** Messages or items taught at once when catching a stream up. */
const TEACH_PAGE = 500;

/** An exchange as an agent sees it. Only these fields, each masked where it can hold a secret. */
export interface AgentSummary {
  id: string;
  method: string;
  url: string;
  host: string;
  path: string;
  protocol: string;
  httpVersion: string;
  startedAt: string;
  status?: number;
  statusText?: string;
  contentType?: string;
  responseSize?: number;
  durationMs?: number;
  receiving?: true;
  failure?: { kind: string; code: string; message: string; detail?: string };
  websocket?: { messages: number; closeCode?: number; closeReason?: string };
  eventStream?: true;
  grpc?: { status?: number; message?: string };
  handledByRule?: string;
  imported?: true;
  composed?: true;
  fromDevice?: true;
}

export interface AgentDetail extends AgentSummary {
  requestHeaders: Header[];
  responseHeaders?: Header[];
  requestTrailers?: Header[];
  responseTrailers?: Header[];
  query: Header[];
  requestBody?: { size: number; kept: number };
  responseBody?: { size: number; kept: number };
  timing?: Record<string, number>;
}

/** The fields of a summary to mask, in a fixed order, and how to put them back. */
function summaryFields(s: ExchangeSummary): { fields: MaskField[]; build(masked: string[]): AgentSummary } {
  const fields: MaskField[] = [
    { kind: 'url', value: s.url },
    { kind: 'url', value: s.path },
    { kind: 'host', value: s.host },
    // Not a secret by any rule, but the client chose it: a known value is hidden there too.
    { kind: 'host', value: s.method },
  ];
  const at = (field: MaskField | undefined): number | undefined => {
    if (!field) return undefined;
    fields.push(field);
    return fields.length - 1;
  };
  const text = (value: string | undefined): number | undefined =>
    value === undefined ? undefined : at({ kind: 'text', value });
  const statusText = text(s.statusMessage);
  const contentType =
    s.contentType === undefined
      ? undefined
      : at({ kind: 'header', name: 'content-type', value: s.contentType });
  const failureCode = text(s.failure?.code);
  const failureMessage = text(s.failure?.message);
  const failureDetail = text(s.failure?.detail);
  const closeReason = text(s.closeReason);
  const grpcMessage = text(s.grpcMessage);
  const rule = text(s.handledBy?.label);
  return {
    fields,
    build(m) {
      const get = (i: number | undefined): string | undefined => (i === undefined ? undefined : m[i]);
      return {
        id: s.id,
        method: m[3]!,
        url: m[0]!,
        path: m[1]!,
        host: m[2]!,
        protocol: s.protocol,
        httpVersion: s.httpVersion,
        startedAt: new Date(s.startedAt).toISOString(),
        ...(s.status !== undefined ? { status: s.status } : {}),
        ...(statusText !== undefined ? { statusText: get(statusText)! } : {}),
        ...(contentType !== undefined ? { contentType: get(contentType)! } : {}),
        ...(s.responseSize !== undefined ? { responseSize: s.responseSize } : {}),
        ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
        ...(s.responding ? { receiving: true as const } : {}),
        ...(s.failure
          ? {
              failure: {
                kind: s.failure.kind,
                code: get(failureCode)!,
                message: get(failureMessage)!,
                ...(failureDetail !== undefined ? { detail: get(failureDetail)! } : {}),
              },
            }
          : {}),
        ...(s.websocket
          ? {
              websocket: {
                messages: s.messageCount ?? 0,
                ...(s.closeCode !== undefined ? { closeCode: s.closeCode } : {}),
                ...(closeReason !== undefined ? { closeReason: get(closeReason)! } : {}),
              },
            }
          : {}),
        ...(isEventStream(s.contentType) ? { eventStream: true as const } : {}),
        ...(s.grpc
          ? {
              grpc: {
                ...(s.grpcStatus !== undefined ? { status: s.grpcStatus } : {}),
                ...(grpcMessage !== undefined ? { message: get(grpcMessage)! } : {}),
              },
            }
          : {}),
        ...(rule !== undefined ? { handledByRule: get(rule)! } : {}),
        ...(s.imported ? { imported: true as const } : {}),
        ...(s.composed ? { composed: true as const } : {}),
        ...(s.source ? { fromDevice: true as const } : {}),
      };
    },
  };
}

/** The masked strings, or an error saying they couldn't be checked: never the originals. */
async function masked(
  backend: ReaderBackend,
  fields: MaskField[],
  own: Json,
  full?: { full: boolean },
): Promise<string[]> {
  if (fields.length === 0) return [];
  let answer: FieldsAnswer;
  try {
    answer = await backend.maskFields(fields, own);
  } catch {
    throw new ReadError('Couldn’t check this for secrets. Try again.');
  }
  if ('failed' in answer) throw new ReadError(`${answer.failed} Try again.`);
  if (answer.fields.length !== fields.length || answer.fields.some((f) => typeof f !== 'string')) {
    throw new ReadError('Couldn’t check this for secrets. Try again.');
  }
  if (full && answer.full === true) full.full = true;
  return answer.fields;
}

/** Summaries masked, in one worker job. */
async function maskSummaries(
  backend: ReaderBackend,
  list: ExchangeSummary[],
  full?: { full: boolean },
): Promise<AgentSummary[]> {
  const parts = list.map(summaryFields);
  const all = parts.flatMap((p) => p.fields);
  const out = await masked(backend, all, {}, full);
  let at = 0;
  return parts.map((p) => {
    const mine = out.slice(at, at + p.fields.length);
    at += p.fields.length;
    return p.build(mine);
  });
}

/** Summaries masked in batches, so a long list never makes one huge job. */
const LIST_BATCH = 500;

export interface ListResult {
  exchanges: AgentSummary[];
  /** Pass back to get the next page. */
  nextCursor?: string;
  total: number;
  /** Set when some values seen earlier may not be hidden: Wirescry's list of them is full. */
  note?: string;
}

/** The longest plugin error that's masked. Cutting one first could split a secret from its name. */
export const MAX_ERROR_CHARS = 64_000;
/** How much of a plugin's error an agent gets. */
const MAX_ERROR_SHOWN = 2_000;

export const FULL_NOTE = 'Some values seen earlier may not be hidden: Wirescry’s list of them is full.';

export class Reader {
  /** For each agent stream key, the last index taught and the worker generation it was taught in. */
  private readonly taught = new Map<string, { index: number; generation: number }>();
  /** Masked bodies, so paging through one masks it once. */
  private readonly bodies = new Map<string, Promise<MaskedBodyText>>();

  constructor(private readonly backend: ReaderBackend) {}

  /**
   * A plugin tool's result, masked string by string (plugin-result.ts), with the session's known
   * values. Throws ReadError if it isn't plain JSON, is too large, or couldn't be masked.
   */
  async pluginResult(result: unknown): Promise<{ value: unknown; full: boolean }> {
    let collected: ReturnType<typeof collectResult>;
    try {
      collected = collectResult(result);
    } catch (error) {
      if (error instanceof ResultError) throw new ReadError(error.message);
      throw error;
    }
    const full = { full: false };
    const fields = await masked(this.backend, collected.fields, {}, full);
    let value: unknown;
    try {
      value = collected.build(fields);
    } catch (error) {
      if (error instanceof ResultError) throw new ReadError(error.message);
      throw error;
    }
    if (JSON.stringify(value).length > MAX_CHARS) {
      throw new ReadError('The result is too large. Ask for less at a time.');
    }
    return { value, full: full.full };
  }

  /** A plugin tool's error message, masked as text, then cut; a general message if that fails. */
  async pluginError(message: string): Promise<string> {
    if (typeof message !== 'string' || message.length > MAX_ERROR_CHARS) return 'The tool failed.';
    try {
      const full = { full: false };
      const [whole] = await masked(this.backend, [{ kind: 'text', value: message }], {}, full);
      const text = whole!.slice(0, MAX_ERROR_SHOWN);
      return full.full ? `${text} ${FULL_NOTE}` : text;
    } catch {
      return 'The tool failed.';
    }
  }

  /** Whether `id` names a captured exchange. */
  knows(id: string): boolean {
    return typeof id === 'string' && this.backend.detail(id) !== undefined;
  }

  /** Exchanges, newest first, that match `query` as masked. */
  async list(query: string | undefined, limit: number, cursor: string | undefined): Promise<ListResult> {
    const q = (query ?? '').trim();
    if (q.length > MAX_QUERY_LENGTH)
      throw new ReadError(`The query is longer than ${MAX_QUERY_LENGTH} characters.`);
    // A wildcard in an = or != term (`url=*a*a*b`) becomes a pattern that can take minutes on one
    // long URL, on the proxy's own thread. ~ terms and plain words take * and ? as they are.
    if (tokenize(q).some((token) => WILDCARD_TERM.test(token.replace(/^-/, '')))) {
      throw new ReadError(
        'Wildcards (* and ?) can’t be used with = or != here: use ~ to match part of a value, as in path~/users.',
      );
    }
    const compiled = q ? compileQuery(q) : undefined;
    if (compiled && compiled.errors.length > 0) throw new ReadError(compiled.errors.join(' '));
    if (compiled?.needsDetail) {
      throw new ReadError(
        'Header and body terms can’t be used here: searching real values could confirm a hidden secret. Use the summary terms (method, status, host, path, url, type, size, time, protocol, rule, failure, grpc) and plain words.',
      );
    }
    const all = this.backend.summaries().slice().reverse();
    let start = 0;
    if (cursor !== undefined && cursor !== '') {
      const at = all.findIndex((s) => s.id === cursor);
      if (at === -1)
        throw new ReadError('That cursor is no longer valid: the list changed. Start again without one.');
      start = at + 1;
    }
    const n = Math.max(1, Math.min(MAX_LIST, Math.floor(limit)));
    const full = { full: false };
    const note = (): { note?: string } => (full.full ? { note: FULL_NOTE } : {});
    if (!compiled) {
      const page = all.slice(start, start + n);
      const exchanges = await maskSummaries(this.backend, page, full);
      const next = start + n < all.length ? page.at(-1)?.id : undefined;
      return { exchanges, total: all.length, ...(next ? { nextCursor: next } : {}), ...note() };
    }
    // Matched over what the agent would see: masked.
    const found: AgentSummary[] = [];
    let i = start;
    let more = false;
    while (i < all.length) {
      const batch = all.slice(i, i + LIST_BATCH);
      const shown = await maskSummaries(this.backend, batch, full);
      for (let j = 0; j < shown.length; j++) {
        if (!compiled.matches(asSummary(batch[j]!, shown[j]!))) continue;
        if (found.length === n) {
          more = true;
          break;
        }
        found.push(shown[j]!);
      }
      if (more) break;
      i += batch.length;
    }
    return {
      exchanges: found,
      total: all.length,
      ...(more && found.length > 0 ? { nextCursor: found.at(-1)!.id } : {}),
      ...note(),
    };
  }

  /** One exchange's details, headers and all, masked. */
  async get(id: string): Promise<AgentDetail> {
    const detail = this.exchange(id);
    const { fields, build } = summaryFields(detail.summary);
    const lists: Array<Header[] | undefined> = [
      detail.requestHeaders,
      detail.responseHeaders,
      detail.requestTrailers,
      detail.responseTrailers,
    ];
    const starts: number[] = [];
    for (const list of lists) {
      starts.push(fields.length);
      for (const [name, value] of list ?? []) {
        fields.push({ kind: 'header', name, value });
        // The name too: a known value can turn up as one.
        fields.push({ kind: 'host', value: name });
      }
    }
    const out = await masked(this.backend, fields, this.backend.part(detail));
    const headers = (k: number): Header[] | undefined =>
      lists[k]?.map((_, j): Header => [out[starts[k]! + 2 * j + 1]!, out[starts[k]! + 2 * j]!]);
    const summary = build(out);
    let query: Header[] = [];
    try {
      query = [...new URL(summary.url).searchParams];
    } catch {
      // Not a URL that parses: no query to show.
    }
    return {
      ...summary,
      requestHeaders: headers(0) ?? [],
      ...(detail.responseHeaders ? { responseHeaders: headers(1) } : {}),
      ...(detail.requestTrailers ? { requestTrailers: headers(2) } : {}),
      ...(detail.responseTrailers ? { responseTrailers: headers(3) } : {}),
      query,
      ...(detail.requestBody
        ? { requestBody: { size: detail.requestBody.size, kept: detail.requestBody.stored } }
        : {}),
      ...(detail.responseBody
        ? { responseBody: { size: detail.responseBody.size, kept: detail.responseBody.stored } }
        : {}),
      ...(detail.timing ? { timing: numbersOf(detail.timing) } : {}),
    };
  }

  /** Part of a body's masked text. */
  async body(id: string, side: BodySide, offset: number, maxChars: number): Promise<BodySlice> {
    const detail = this.exchange(id);
    const info = side === 'request' ? detail.requestBody : detail.responseBody;
    const key = `${id}:${side}:${info?.size ?? 0}`;
    let pending = this.bodies.get(key);
    if (!pending) {
      pending = this.maskBody(detail, side);
      this.bodies.set(key, pending);
      // A few at a time: they can be megabytes each.
      while (this.bodies.size > 4) this.bodies.delete(this.bodies.keys().next().value!);
      pending.catch(() => this.bodies.delete(key));
    }
    const body = await pending;
    if (body.kind !== 'text') return body;
    const from = Math.max(0, Math.floor(offset));
    const n = Math.max(1, Math.min(MAX_CHARS, Math.floor(maxChars)));
    const text = body.text.slice(from, from + n);
    return {
      kind: 'text',
      contentType: body.contentType,
      size: body.size,
      totalChars: body.text.length,
      offset: from,
      text,
      ...(from + text.length < body.text.length ? { more: true as const } : {}),
      ...(body.cut ? { cut: true as const } : {}),
    };
  }

  /** WebSocket messages after `after`, masked, text only. */
  async messages(id: string, after: number, limit: number): Promise<AgentMessages> {
    const detail = this.exchange(id);
    if (!detail.summary.websocket) throw new ReadError('That exchange isn’t a WebSocket.');
    const n = Math.max(1, Math.min(MAX_MESSAGES, Math.floor(limit)));
    const from = Math.max(-1, Math.floor(after));
    const key = `ws:${id}`;
    const page = this.backend.wsPage(id, from, n);
    const shown = await this.afresh(key, async () => {
      await this.catchUp(key, from, async (taughtTo, fresh) => {
        const chunk = this.backend.wsPage(id, taughtTo, TEACH_PAGE);
        const upTo = chunk.messages.filter((m) => m.index <= from);
        if (upTo.length === 0) return undefined;
        await this.backend.maskMessages(detail, { ...chunk, messages: upTo }, fresh);
        return upTo.at(-1)!.index;
      });
      const generation = this.backend.generation();
      const masked = await this.backend.maskMessages(detail, page, from < 0 && !this.taught.has(key));
      const last = page.messages.at(-1)?.index;
      if (last !== undefined) this.remember(key, { index: last, generation });
      return masked;
    });
    return {
      total: page.total,
      dropped: page.dropped,
      messages: shown.messages.map((m, i) => ({
        index: m.index,
        fromClient: m.fromClient,
        time: m.time,
        size: m.size,
        ...(m.masked && 'hidden' in m.masked
          ? { hidden: m.masked.hidden }
          : m.isBinary || !m.masked || m.masked.text === undefined
            ? { binary: true as const }
            : { text: m.masked.text }),
        // From the stored bytes: a hidden message's masked copy has none.
        ...(Buffer.from(page.messages[i]?.base64 ?? '', 'base64').length < m.size
          ? { cut: true as const }
          : {}),
      })),
    };
  }

  /** An event stream's kept items after `after`, masked. */
  async events(id: string, after: number): Promise<AgentEvents> {
    const detail = this.exchange(id);
    if (!isEventStream(detail.summary.contentType))
      throw new ReadError('That exchange isn’t an event stream.');
    const from = Math.max(0, Math.floor(after));
    const first = await this.backend.sseRead(id, from);
    if (!first) throw new ReadError('That event stream can’t be read.');
    const key = `sse:${id}:${first.serial}`;
    const shown = await this.afresh(key, async () => {
      await this.catchUp(key, from, async (taughtTo, fresh) => {
        const kept = await this.backend.sseRead(id, Math.max(0, taughtTo));
        if (!kept || kept.serial !== first.serial) return undefined;
        const upTo = kept.items.filter((item) => item.index <= from).slice(0, TEACH_PAGE);
        if (upTo.length === 0) return undefined;
        await this.backend.maskEvents(detail, { ...kept, items: upTo }, fresh);
        return upTo.at(-1)!.index;
      });
      const generation = this.backend.generation();
      const masked = await this.backend.maskEvents(detail, first, from === 0 && !this.taught.has(key));
      const last = first.items.at(-1)?.index;
      if (last !== undefined) this.remember(key, { index: last, generation });
      return masked;
    });
    return {
      total: shown.total,
      receiving: shown.receiving,
      items: shown.items.map(itemOf),
      ...(shown.problem ? { note: shown.problem } : {}),
      ...(shown.full ? { full: true as const } : {}),
    };
  }

  /**
   * Teaches a stream everything before `upTo` the agent hasn't been shown, a page at a time, so a
   * value found in its first message is hidden in its thousandth: from the start again if the
   * worker restarted since.
   */
  private async catchUp(
    key: string,
    upTo: number,
    teach: (from: number, fresh: boolean) => Promise<number | undefined>,
  ): Promise<void> {
    if (upTo < 0) return;
    let state = this.taught.get(key);
    if (state && state.generation !== this.backend.generation()) state = undefined;
    let at = state?.index ?? -1;
    while (at < upTo) {
      // Before the job: a restart during it means what it taught is gone.
      const generation = this.backend.generation();
      const last = await teach(at, at === -1);
      if (last === undefined || last <= at) break;
      at = last;
      this.remember(key, { index: at, generation });
    }
  }

  /** Records how far a stream was taught: for the 100 streams read most recently. */
  private remember(key: string, state: { index: number; generation: number }): void {
    this.taught.delete(key);
    this.taught.set(key, state);
    while (this.taught.size > 100) this.taught.delete(this.taught.keys().next().value!);
  }

  /**
   * Runs `read`, and if the worker lost the stream partway, forgets what it was taught and runs it
   * once more, teaching it from the start. Lost twice: an error, never what wasn't checked.
   */
  private async afresh<T>(key: string, read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await read();
      } catch (error) {
        if (!(error instanceof StreamLost)) throw error;
        this.taught.delete(key);
      }
    }
    throw new ReadError('Couldn’t check this stream for secrets: Wirescry is busy. Try again.');
  }

  private async maskBody(detail: ExchangeDetail, side: BodySide): Promise<MaskedBodyText> {
    let content;
    try {
      content = await this.backend.body(detail, side);
    } catch (error) {
      if (error instanceof ReadError) throw error;
      throw new ReadError('Couldn’t read that body.');
    }
    if (!content) return { kind: 'none' };
    const m = content.masked;
    if (!m) throw new ReadError('Couldn’t check that body for secrets.');
    if ('hidden' in m) return { kind: 'hidden', reason: m.hidden, size: content.size };
    if (m.text === undefined)
      return {
        kind: 'binary',
        size: content.size,
        ...(content.contentType ? { contentType: content.contentType } : {}),
      };
    return {
      kind: 'text',
      text: m.text.replace(/^\uFEFF/, ''),
      size: content.size,
      cut: content.truncated,
      ...(content.contentType ? { contentType: content.contentType } : {}),
    };
  }

  private exchange(id: string): ExchangeDetail {
    const detail = typeof id === 'string' ? this.backend.detail(id) : undefined;
    if (!detail) throw new ReadError('No such exchange: it may have been cleared, or the id is wrong.');
    return detail;
  }
}

type MaskedBodyText =
  | { kind: 'none' }
  | { kind: 'hidden'; reason: string; size: number }
  | { kind: 'binary'; size: number; contentType?: string }
  | { kind: 'text'; text: string; size: number; cut: boolean; contentType?: string };

export type BodySlice =
  | Exclude<MaskedBodyText, { kind: 'text' }>
  | {
      kind: 'text';
      contentType?: string;
      /** Bytes on the wire. */
      size: number;
      totalChars: number;
      offset: number;
      text: string;
      more?: true;
      /** Wirescry kept only the start of this body. */
      cut?: true;
    };

export interface AgentMessages {
  total: number;
  dropped: number;
  messages: Array<{
    index: number;
    fromClient: boolean;
    time: number;
    size: number;
    text?: string;
    binary?: true;
    hidden?: string;
    cut?: true;
  }>;
}

export interface AgentEvents {
  total: number;
  receiving: boolean;
  items: Array<Record<string, unknown>>;
  note?: string;
  full?: true;
}

function itemOf(item: SseItem): Record<string, unknown> {
  if (item.kind === 'comment') return { index: item.index, comment: item.text };
  if (item.kind === 'retry') return { index: item.index, retryMs: item.ms };
  return {
    index: item.index,
    type: item.type,
    data: item.data,
    ...(item.id !== undefined ? { id: item.id } : {}),
    ...(item.cut ? { cut: true } : {}),
  };
}

function numbersOf(timing: object): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(timing)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

/** A summary carrying the masked strings, for the query to match what the agent would see. */
function asSummary(raw: ExchangeSummary, shown: AgentSummary): ExchangeSummary {
  return {
    id: raw.id,
    method: raw.method,
    protocol: raw.protocol,
    httpVersion: raw.httpVersion,
    host: shown.host,
    path: shown.path,
    url: shown.url,
    startedAt: raw.startedAt,
    ...(raw.status !== undefined ? { status: raw.status } : {}),
    ...(shown.statusText !== undefined ? { statusMessage: shown.statusText } : {}),
    ...(shown.contentType !== undefined ? { contentType: shown.contentType } : {}),
    ...(raw.responseSize !== undefined ? { responseSize: raw.responseSize } : {}),
    ...(raw.durationMs !== undefined ? { durationMs: raw.durationMs } : {}),
    ...(raw.failure && shown.failure
      ? {
          failure: {
            kind: raw.failure.kind,
            code: shown.failure.code,
            message: shown.failure.message,
            ...(shown.failure.detail !== undefined ? { detail: shown.failure.detail } : {}),
          } as ExchangeSummary['failure'],
        }
      : {}),
    ...(raw.websocket ? { websocket: true } : {}),
    ...(raw.grpc ? { grpc: true as const } : {}),
    ...(raw.grpcStatus !== undefined ? { grpcStatus: raw.grpcStatus } : {}),
    ...(raw.grpcDeadlineExceeded ? { grpcDeadlineExceeded: true as const } : {}),
    ...(shown.handledByRule !== undefined
      ? { handledBy: { ...raw.handledBy!, label: shown.handledByRule } }
      : {}),
  };
}
