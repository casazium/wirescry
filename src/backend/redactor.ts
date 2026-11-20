/**
 * Runs HAR redaction in a worker thread (redact-worker.mts) for one export. Redacting a large body
 * takes seconds, and the proxy runs in the backend's own thread.
 *
 * Each entry has a time limit. A worker that crashes, fails or runs out of time is replaced: the
 * new one is taught the export's known values again, and the entry is tried once more. Only a
 * second failure is the caller's to handle (it tries the entry with fewer bodies, then leaves it
 * out). Nothing unredacted ever comes back from here.
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

/** An entry's time to redact: a minute, plus 3 s for each MB of text in it. */
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
  return 60_000 + Math.ceil(chars / 1e6) * 3_000;
}

export type Redacted = Extract<RedactResponse, { text: string }>;
export type RedactOutcome = Redacted | { tooLarge: true } | { dropped: true };

/** Why a worker stopped: crashed, failed, out of time, or closed. */
class WorkerGone extends Error {}

interface Pending {
  resolve(response: RedactResponse): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export class HarRedactor {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  /** What the export has collected so far, taught again to a new worker. */
  private readonly collected: Json[] = [];

  constructor(private readonly file = workerFile()) {}

  /** Teaches the worker the values in these entries' URLs and headers. */
  async collect(parts: Json[]): Promise<void> {
    this.collected.push(...parts);
    await this.send({ op: 'collect', parts });
  }

  /** An entry redacted, or that it's too large to write, or that it must be left out. */
  async redact(entry: Json, meta: EntryMeta, timeLimitMs = entryTimeLimitMs(entry)): Promise<RedactOutcome> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.send({ op: 'redact', entry, meta }, timeLimitMs);
        if (!response.ok) throw new WorkerGone(response.error);
        if ('collected' in response) throw new WorkerGone('the worker answered out of turn');
        return response;
      } catch (error) {
        if (this.closed || attempt >= 1) throw error;
        // A new worker, taught what the old one knew, and one more try.
        this.stop(error as Error);
        if (this.collected.length > 0) await this.send({ op: 'collect', parts: this.collected });
      }
    }
  }

  /** Stops the worker; anything waiting fails. */
  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.stop(new WorkerGone('redaction was stopped'));
    await worker?.terminate();
  }

  private send(request: RedactJob, timeLimitMs?: number): Promise<RedactResponse> {
    if (this.closed) return Promise.reject(new WorkerGone('redaction was stopped'));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<RedactResponse>((resolve, reject) => {
      const timer =
        timeLimitMs === undefined
          ? undefined
          : setTimeout(() => this.stop(new WorkerGone('redacting an entry took too long')), timeLimitMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...request, id } satisfies RedactRequest);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.file);
    worker.on('message', (message: RedactResponse) => {
      const job = this.pending.get(message.id);
      if (!job) return;
      this.pending.delete(message.id);
      clearTimeout(job.timer);
      job.resolve(message);
    });
    worker.on('error', (error) => this.stop(new WorkerGone(error.message)));
    worker.on('messageerror', (error) => this.stop(new WorkerGone(error.message)));
    worker.on('exit', () => {
      if (this.worker === worker) this.stop(new WorkerGone('the redaction worker stopped'));
    });
    this.worker = worker;
    return worker;
  }

  /** Fails everything waiting and drops the worker; the next request starts a new one. */
  private stop(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(error instanceof WorkerGone ? error : new WorkerGone(error.message));
    }
    this.pending.clear();
    void worker?.terminate();
  }
}
