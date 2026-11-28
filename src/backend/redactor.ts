/**
 * Runs HAR redaction in a worker thread (redact-worker.mts) for one export. Redacting a large body
 * takes seconds, and the proxy runs in the backend's own thread.
 *
 * Each entry has a time limit. A worker that crashes, fails or runs out of time is stopped and the
 * entry fails; the caller tries it with fewer bodies, then leaves it out. The next worker is
 * taught the export's known values before it redacts anything. Nothing unredacted ever comes back
 * from here.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { EntryMeta } from './har-redact';
import type { RedactJob, RedactRequest, RedactResponse } from './redact-worker.mjs';

type Json = Record<string, unknown>;

/** The built worker next to this file, or the TypeScript source when running tests. */
function workerFile(): string {
  const built = path.join(__dirname, 'redact-worker.js');
  return existsSync(built) ? built : path.join(__dirname, 'redact-worker.mts');
}

/**
 * An entry's time to redact: 20 s, plus 3 s for each MB of text in it. An entry that takes longer
 * is tried with fewer bodies, so a few slow ones don't use up the export's 10 minutes.
 */
export function entryTimeLimitMs(entry: Json): number {
  let chars = 0;
  const request = (entry.request ?? {}) as Json;
  const response = (entry.response ?? {}) as Json;
  const postData = (request.postData ?? {}) as Json;
  const content = (response.content ?? {}) as Json;
  if (typeof postData.text === 'string') chars += postData.text.length;
  if (typeof content.text === 'string') chars += content.text.length;
  if (Array.isArray(entry._webSocketMessages)) {
    for (const m of entry._webSocketMessages as Json[])
      if (typeof m.data === 'string') chars += m.data.length;
  }
  return 20_000 + Math.ceil(chars / 1e6) * 3_000;
}

/** Time for a worker to take an export's URLs and headers (in memory, so quick). */
const TEACH_TIME_LIMIT_MS = 60_000;

export type Redacted = Extract<RedactResponse, { text: string }>;
export type RedactOutcome = Redacted | { tooLarge: true } | { dropped: true };
/** What learning an entry found: whether the export's values are full (dropped: nothing learned). */
export type LearnOutcome = { full: boolean } | { dropped: true };

/** Why a worker stopped: crashed, failed, out of time, or closed. */
class WorkerGone extends Error {}

interface Pending {
  resolve(response: RedactResponse): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export class HarRedactor {
  private worker: Worker | undefined;
  /** The current worker, taught the export's known values; set while teaching it. */
  private taught: Promise<Worker> | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  /** What the export has collected so far, taught to every new worker before it redacts. */
  private readonly collected: Json[] = [];
  /** Values entries' bodies taught (learn), taught to every new worker after `collected`. */
  private readonly learned: string[] = [];
  /** Whether learning turned a value away: a new worker is told, so the export still says so. */
  private learnedFull = false;

  constructor(private readonly file = workerFile()) {}

  /**
   * Teaches the worker the values in these entries' URLs and headers: within one call, every
   * header before any URL (export calls it once, with every entry).
   */
  async collect(parts: Json[]): Promise<void> {
    this.collected.push(...parts);
    const worker = this.worker;
    // A new worker is taught everything collected, these parts too.
    if (!worker || !this.taught) {
      await this.ready();
      return;
    }
    await this.taught;
    if (this.worker === worker) await this.teach(worker, parts);
    else await this.ready();
  }

  /**
   * Teaches the export what an entry's bodies and messages name, by redacting it and keeping only
   * what it learned, so every entry can be redacted knowing them. Throws as `redact` does; what
   * was learned before is kept, and taught to the next worker.
   */
  async learn(entry: Json, meta: EntryMeta, timeLimitMs = entryTimeLimitMs(entry)): Promise<LearnOutcome> {
    const worker = await this.ready();
    const response = await this.send(worker, { op: 'learn', entry, meta }, timeLimitMs);
    if (!response.ok) {
      this.stop(new WorkerGone(response.error));
      throw new WorkerGone(response.error);
    }
    if ('dropped' in response) return { dropped: true };
    if (!('learned' in response)) {
      this.stop(new WorkerGone('the worker answered out of turn'));
      throw new WorkerGone('the worker answered out of turn');
    }
    this.learned.push(...response.learned);
    this.learnedFull ||= response.full;
    return { full: response.full };
  }

  /**
   * An entry redacted, or that it's too large to write, or that it must be left out. Throws if the
   * worker fails, crashes or runs out of time; the next call has a new worker, taught what the old
   * one knew. The caller tries again with less (see exportHar). `giveBack`: whether what its bodies
   * teach is kept for later entries (not needed once every entry was learned first).
   */
  async redact(
    entry: Json,
    meta: EntryMeta,
    timeLimitMs = entryTimeLimitMs(entry),
    giveBack = true,
  ): Promise<RedactOutcome> {
    const worker = await this.ready();
    const response = await this.send(worker, { op: 'redact', entry, meta, giveBack }, timeLimitMs);
    if (!response.ok) {
      this.stop(new WorkerGone(response.error));
      throw new WorkerGone(response.error);
    }
    if ('collected' in response || 'learned' in response) {
      this.stop(new WorkerGone('the worker answered out of turn'));
      throw new WorkerGone('the worker answered out of turn');
    }
    return response;
  }

  /** Stops the worker; anything waiting fails. */
  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.stop(new WorkerGone('redaction was stopped'));
    await worker?.terminate();
  }

  /** The worker, started and taught everything collected if there isn't one. */
  private ready(): Promise<Worker> {
    if (this.closed) return Promise.reject(new WorkerGone('redaction was stopped'));
    if (this.worker && this.taught) return this.taught;
    const worker = this.start();
    const taught = (async () => {
      if (this.collected.length > 0 || this.learned.length > 0 || this.learnedFull) {
        await this.teach(worker, this.collected, { values: this.learned, full: this.learnedFull });
      }
      return worker;
    })();
    this.taught = taught;
    // A failure is the caller's, and the next call starts afresh.
    taught.catch(() => {
      if (this.taught === taught) this.stop(new WorkerGone('the redaction worker couldn’t be taught'));
    });
    return taught;
  }

  private async teach(
    worker: Worker,
    parts: Json[],
    learned: { values: string[]; full: boolean } = { values: [], full: false },
  ): Promise<void> {
    const response = await this.send(
      worker,
      { op: 'collect', parts, values: learned.values, full: learned.full },
      TEACH_TIME_LIMIT_MS,
    );
    if (!response.ok) {
      this.stop(new WorkerGone(response.error));
      throw new WorkerGone(response.error);
    }
  }

  private send(worker: Worker, request: RedactJob, timeLimitMs?: number): Promise<RedactResponse> {
    if (this.closed) return Promise.reject(new WorkerGone('redaction was stopped'));
    if (this.worker !== worker) return Promise.reject(new WorkerGone('the redaction worker stopped'));
    const id = this.nextId++;
    return new Promise<RedactResponse>((resolve, reject) => {
      const timer =
        timeLimitMs === undefined
          ? undefined
          : setTimeout(() => this.stop(new WorkerGone('redacting an entry took too long')), timeLimitMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ ...request, id } satisfies RedactRequest);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new WorkerGone((error as Error).message));
      }
    });
  }

  private start(): Worker {
    const worker = new Worker(this.file);
    worker.on('message', (message: RedactResponse) => {
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
    worker.on('exit', () => gone('the redaction worker stopped'));
    this.worker = worker;
    this.taught = undefined;
    return worker;
  }

  /** Fails everything waiting and drops the worker; the next request starts a new one. */
  private stop(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    this.taught = undefined;
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(error instanceof WorkerGone ? error : new WorkerGone(error.message));
    }
    this.pending.clear();
    void worker?.terminate();
  }
}
