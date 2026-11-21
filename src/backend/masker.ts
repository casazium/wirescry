/**
 * Masks bodies for the window while View › Hide Secrets is on, in a worker thread
 * (mask-worker.mts): masking a large body takes seconds, and the proxy runs in the backend's own
 * thread.
 *
 * The worker learns the session's known values (every exchange's URL, headers and trailers) once
 * the first body is asked for, then each exchange as it changes, before the next body. One body
 * is masked at a time; asking for another exchange's body drops what's waiting for older ones.
 *
 * It fails closed: a worker that crashes, fails or runs out of time answers `hidden`, never the
 * body as it was.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { MaskJob, MaskRequest, MaskResponse } from './mask-worker.mjs';

type Json = Record<string, unknown>;

/** The built worker next to this file, or the TypeScript source when running tests. */
function workerFile(): string {
  const built = path.join(__dirname, 'mask-worker.js');
  return existsSync(built) ? built : path.join(__dirname, 'mask-worker.mts');
}

/** Where the session's exchanges come from. */
export interface MaskSource {
  /** Every exchange's URL, headers and trailers, as HAR entries' parts. */
  all(): Json[];
  /** One exchange's, if it's still there. */
  part(id: string): Json | undefined;
}

export type MaskBody = Omit<Extract<MaskJob, { op: 'mask' }>, 'op'>;
/** The worker's answer, without its id. */
type Reply = MaskResponse extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;
/** A job for the worker other than teaching it. */
type WorkJob = Exclude<MaskJob, { op: 'teach' }>;
type Answered<K extends string> = Omit<Extract<MaskResponse, Record<K, unknown>>, 'id' | 'ok'>;
/** A body masked, or why it can't be shown. */
export type MaskAnswer = Answered<'masked'> | { failed: string };
/** A page of WebSocket messages masked, or why it can't be shown. */
export type MessagesAnswer = Answered<'messages'> | { failed: string };
/** Fields masked, or why they can't be shown. */
export type FieldsAnswer = Answered<'fields'> | { failed: string };
/** Groups starting with this are an agent's (MCP): never superseded. */
export const AGENT_GROUP = 'mcp:';
/** A page of Server-Sent Events items masked, or why it can't be shown. */
export type EventsAnswer = Answered<'items'> | { failed: string };

/** Why a body isn't shown when checking it went wrong. */
export const MASK_FAILED = 'Couldn’t check this body for secrets.';
export const MASK_TOO_SLOW = 'Checking this body for secrets took too long.';

/** A job dropped because the window asked for another exchange's bodies. */
export class Superseded extends Error {
  constructor() {
    super('Another request was shown instead.');
  }
}

/** Why a worker stopped: crashed, failed, out of time, or closed. */
class WorkerGone extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

/** A job's time: 20 s, plus 3 s for each MB of text in it. Waiting doesn't count. */
export function maskTimeLimitMs(job: MaskBody | WorkJob): number {
  let chars = 0;
  if ('fields' in job) for (const f of job.fields) chars += f.value.length;
  else if ('messages' in job) for (const m of job.messages) chars += m.bytes.length;
  else if ('items' in job) {
    for (const item of job.items) {
      if (item.kind === 'event') chars += item.data.length + item.type.length + (item.id?.length ?? 0);
      else if (item.kind === 'comment') chars += item.text.length;
    }
  } else chars = job.body.bytes.length + (job.request?.bytes.length ?? 0) + (job.formatted?.length ?? 0);
  return 20_000 + Math.ceil(chars / 1e6) * 3_000;
}

/** Time to teach a worker one chunk of exchanges (in memory, so quick). */
const TEACH_TIME_LIMIT_MS = 60_000;
/** Exchanges taught in one message. */
const TEACH_CHUNK = 1_000;
/** The most recent exchanges whose waiting jobs are kept: the selected one and the one before. */
const KEPT_GROUPS = 2;

interface Waiting {
  group: string;
  job: WorkJob;
  resolve(answer: Reply | { failed: string }): void;
  reject(error: Error): void;
}

interface Pending {
  resolve(response: MaskResponse): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export class Masker {
  private worker: Worker | undefined;
  /** Set once a body is asked for: until then nothing is taught or tracked. */
  private started = false;
  /** The worker must be taught every exchange before its next job. */
  private needsAll = true;
  /** Exchanges changed since the worker was last taught. */
  private readonly dirty = new Set<string>();
  private readonly queue: Waiting[] = [];
  private running = false;
  private readonly recent: string[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private workers = 0;

  constructor(
    private readonly source: MaskSource,
    private readonly file = workerFile(),
    private readonly limits: { timeLimitMs?: (job: WorkJob) => number; teachChunk?: number } = {},
  ) {}

  /** An exchange was added or changed: its values are taught before the next job. */
  touched(id: string): void {
    if (this.started && !this.needsAll) this.dirty.add(id);
  }

  /** Forgets the session's values (Clear): the next job's worker learns what's left. */
  reset(): void {
    this.stop(new WorkerGone('the list was cleared'));
  }

  /**
   * A body masked. Resolves `failed` if it can't be checked; rejects with Superseded if the window
   * asked for two other exchanges' bodies before its turn came.
   */
  async mask(group: string, job: MaskBody): Promise<MaskAnswer> {
    return this.answer(await this.enqueue(group, { op: 'mask', ...job }), 'masked');
  }

  /** A page of a WebSocket's messages masked, in order; as `mask` otherwise. */
  /** An exchange's summary and header fields masked, in order; as `mask` otherwise. */
  async maskFields(
    group: string,
    job: Omit<Extract<MaskJob, { op: 'fields' }>, 'op'>,
  ): Promise<FieldsAnswer> {
    return this.answer(await this.enqueue(group, { op: 'fields', ...job }), 'fields');
  }

  async maskMessages(
    group: string,
    job: Omit<Extract<MaskJob, { op: 'messages' }>, 'op'>,
  ): Promise<MessagesAnswer> {
    return this.answer(await this.enqueue(group, { op: 'messages', ...job }), 'messages');
  }

  /** A page of a Server-Sent Events stream's items masked, in order; as `mask` otherwise. */
  async maskEvents(
    group: string,
    job: Omit<Extract<MaskJob, { op: 'events' }>, 'op'>,
  ): Promise<EventsAnswer> {
    return this.answer(await this.enqueue(group, { op: 'events', ...job }), 'items');
  }

  /** The worker's answer of the kind asked for; any other is a fault: the worker is stopped. */
  private answer<K extends 'masked' | 'messages' | 'items' | 'fields'>(
    response: Reply | { failed: string },
    key: K,
  ): Answered<K> | { failed: string } {
    if ('failed' in response) return response;
    if (!response.ok || !(key in response)) {
      this.stop(new WorkerGone(response.ok ? 'the worker answered out of turn' : response.error));
      return { failed: MASK_FAILED };
    }
    const { ok: _ok, ...answer } = response;
    void _ok;
    return answer as unknown as Answered<K>;
  }

  private enqueue(group: string, job: WorkJob): Promise<Reply | { failed: string }> {
    if (this.closed) return Promise.reject(new Error('Wirescry is stopping.'));
    this.started = true;
    // An agent's jobs (MCP) wait their turn: the window's choices don't drop them, nor they the window's.
    if (!group.startsWith(AGENT_GROUP)) {
      const at = this.recent.indexOf(group);
      if (at !== -1) this.recent.splice(at, 1);
      this.recent.unshift(group);
      this.recent.length = Math.min(this.recent.length, KEPT_GROUPS);
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const waiting = this.queue[i]!;
      if (!waiting.group.startsWith(AGENT_GROUP) && !this.recent.includes(waiting.group)) {
        this.queue.splice(i, 1);
        waiting.reject(new Superseded());
      }
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ group, job, resolve, reject });
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiting of this.queue.splice(0)) waiting.reject(new Error('Wirescry is stopping.'));
    const worker = this.worker;
    this.stop(new WorkerGone('Wirescry is stopping'));
    await worker?.terminate();
  }

  private pump(): void {
    if (this.running || this.closed) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = true;
    void this.run(next.job)
      .then(next.resolve, next.reject)
      .finally(() => {
        this.running = false;
        this.pump();
      });
  }

  private async run(job: WorkJob): Promise<Reply | { failed: string }> {
    let worker: Worker;
    try {
      worker = await this.taught();
    } catch {
      return { failed: MASK_FAILED };
    }
    const timeLimit = (this.limits.timeLimitMs ?? maskTimeLimitMs)(job);
    let response: MaskResponse;
    try {
      response = await this.send(worker, job, timeLimit);
    } catch (error) {
      return { failed: error instanceof WorkerGone && error.timedOut ? MASK_TOO_SLOW : MASK_FAILED };
    }
    const { id: _id, ...answer } = response;
    void _id;
    return answer;
  }

  /** The worker, started if need be, taught every exchange or those changed since. */
  private async taught(): Promise<Worker> {
    if (this.closed) throw new WorkerGone('Wirescry is stopping');
    const worker = this.worker ?? this.start();
    let parts: Json[];
    if (this.needsAll) {
      this.needsAll = false;
      this.dirty.clear();
      parts = this.source.all();
    } else {
      parts = [];
      for (const id of this.dirty) {
        const part = this.source.part(id);
        if (part) parts.push(part);
      }
      this.dirty.clear();
    }
    const chunk = this.limits.teachChunk ?? TEACH_CHUNK;
    for (let i = 0; i < parts.length; i += chunk) {
      const response = await this.send(
        worker,
        { op: 'teach', parts: parts.slice(i, i + chunk) },
        TEACH_TIME_LIMIT_MS,
      );
      if (!response.ok || !('taught' in response)) {
        this.stop(new WorkerGone(response.ok ? 'the worker answered out of turn' : response.error));
        throw new WorkerGone('the worker couldn’t be taught');
      }
    }
    return worker;
  }

  private send(worker: Worker, job: MaskJob, timeLimitMs: number): Promise<MaskResponse> {
    if (this.worker !== worker) return Promise.reject(new WorkerGone('the mask worker stopped'));
    const id = this.nextId++;
    return new Promise<MaskResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.stop(new WorkerGone('masking took too long', true)), timeLimitMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ ...job, id } satisfies MaskRequest);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new WorkerGone((error as Error).message));
      }
    });
  }

  /** How many workers have started: a stream's learned values are lost when this changes. */
  get generation(): number {
    return this.workers;
  }

  private start(): Worker {
    this.workers += 1;
    const worker = new Worker(this.file);
    worker.unref();
    worker.on('message', (message: MaskResponse) => {
      if (this.worker !== worker) return;
      const job = this.pending.get(message.id);
      if (!job) return;
      this.pending.delete(message.id);
      clearTimeout(job.timer);
      job.resolve(message);
    });
    const gone = (why: string): void => {
      if (this.worker === worker) this.stop(new WorkerGone(why));
    };
    worker.on('error', (error) => gone(error.message));
    worker.on('messageerror', (error) => gone(error.message));
    worker.on('exit', () => gone('the mask worker stopped'));
    this.worker = worker;
    this.needsAll = true;
    return worker;
  }

  /** Fails what's in the worker and drops it; the next job starts a new one, taught afresh. */
  private stop(error: WorkerGone): void {
    const worker = this.worker;
    // The next worker is taught everything (see start).
    this.worker = undefined;
    this.dirty.clear();
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    this.pending.clear();
    void worker?.terminate();
  }
}
