import { existsSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FormatRequest, FormatResponse, Language } from './format-worker.mjs';

/** Larger bodies aren't formatted: the result would be slow to show anyway. */
export const MAX_FORMAT_INPUT = 2 * 1024 * 1024;

/** The built worker next to this file, or the TypeScript source when running tests. */
function workerFile(): string {
  const built = path.join(__dirname, 'format-worker.js');
  return existsSync(built) ? built : path.join(__dirname, 'format-worker.mts');
}

interface Pending {
  resolve(text: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs formatting in a worker thread. A job that takes too long stops the
 * worker (and fails any other waiting jobs); the next job starts a new one.
 */
export class Formatter {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private readonly timeoutMs = 10_000) {}

  format(language: Language, text: string): Promise<string> {
    if (text.length > MAX_FORMAT_INPUT) return Promise.reject(new Error('too large to format (over 2 MB)'));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.restart(new Error('formatting took too long')), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, language, text } satisfies FormatRequest);
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.restart(new Error('formatter closed'));
    await worker?.terminate();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(workerFile());
    worker.unref();
    worker.on('message', (message: FormatResponse) => {
      const job = this.pending.get(message.id);
      if (!job) return;
      this.pending.delete(message.id);
      clearTimeout(job.timer);
      if ('error' in message) job.reject(new Error(message.error));
      else job.resolve(message.text);
    });
    worker.on('error', (error) => this.restart(error));
    worker.on('exit', () => {
      if (this.worker === worker) this.restart(new Error('formatter stopped'));
    });
    this.worker = worker;
    return worker;
  }

  /** Fails every waiting job and drops the worker; the next job starts a new one. */
  private restart(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    this.pending.clear();
    void worker?.terminate();
  }
}
