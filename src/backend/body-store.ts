import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { BodySide } from '../shared/api';

/** What was stored for one body, once it has finished arriving. */
export interface StoredBody {
  /** Bytes that arrived. */
  size: number;
  /** Bytes kept. Less than `size` if the body passed the store's limit. */
  stored: number;
  /** True if the stream ended early, e.g. the connection dropped. */
  incomplete: boolean;
}

/** Receives a body chunk by chunk as it streams through the proxy. */
export interface BodyWriter {
  write(chunk: Uint8Array): void;
  /** Finishes the body. `complete` is false if the stream was cut off. */
  end(complete: boolean): Promise<StoredBody>;
}

/**
 * Where captured bodies live. Kept apart from the exchange list because bodies
 * can be huge, and so they can be stored somewhere other than memory.
 */
export interface BodyStore {
  /** Starts storing a body, replacing any earlier one for the same exchange and side. */
  open(exchangeId: string, side: BodySide): BodyWriter;
  /** Stores a whole body at once. */
  put(exchangeId: string, side: BodySide, body: Uint8Array): Promise<StoredBody>;
  /** A stream of a finished body, or undefined if there isn't one (yet). */
  read(exchangeId: string, side: BodySide): Readable | undefined;
  /** Whether a body is still arriving. */
  isReceiving(exchangeId: string, side: BodySide): boolean;
  delete(exchangeId: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Entry =
  { where: 'memory'; data: Buffer; info: StoredBody } | { where: 'disk'; file: string; info: StoredBody };

export interface HybridBodyStoreOptions {
  /** Bodies up to this size stay in memory; larger ones go to a file. */
  memoryLimit?: number;
  /** Bytes kept per body; anything past this is counted but not stored. */
  maxBodySize?: number;
}

/**
 * Keeps small bodies in memory and streams larger ones to files in `dir`, so a
 * large body never has to be held in memory whole. The folder is emptied on
 * open and removed on close: captured traffic doesn't outlive the session.
 */
export class HybridBodyStore implements BodyStore {
  private readonly entries = new Map<string, Entry>();
  /** Bodies still arriving, so they can be finished before delete or clear. */
  private readonly writers = new Map<string, HybridWriter>();
  /** Bumped on clear, so writers from before it don't add stale entries. */
  private generation = 0;
  private readonly memoryLimit: number;
  readonly maxBodySize: number;

  private constructor(
    private readonly dir: string,
    options: HybridBodyStoreOptions,
  ) {
    this.memoryLimit = options.memoryLimit ?? 64 * 1024;
    this.maxBodySize = options.maxBodySize ?? 512 * 1024 * 1024;
  }

  static async open(dir: string, options: HybridBodyStoreOptions = {}): Promise<HybridBodyStore> {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return new HybridBodyStore(dir, options);
  }

  private key(exchangeId: string, side: BodySide): string {
    if (!SAFE_ID.test(exchangeId)) throw new Error('Invalid exchange id');
    return `${exchangeId}.${side}`;
  }

  open(exchangeId: string, side: BodySide): BodyWriter {
    const key = this.key(exchangeId, side);
    this.writers.get(key)?.abandon();
    void this.removeEntry(key);
    const generation = this.generation;
    const writer = new HybridWriter(path.join(this.dir, key), this.memoryLimit, this.maxBodySize, (entry) => {
      if (this.writers.get(key) === writer) this.writers.delete(key);
      if (entry && generation === this.generation) this.entries.set(key, entry);
    });
    this.writers.set(key, writer);
    return writer;
  }

  async put(exchangeId: string, side: BodySide, body: Uint8Array): Promise<StoredBody> {
    const writer = this.open(exchangeId, side);
    writer.write(body);
    return writer.end(true);
  }

  read(exchangeId: string, side: BodySide): Readable | undefined {
    const entry = this.entries.get(this.key(exchangeId, side));
    if (!entry) return undefined;
    return entry.where === 'memory' ? Readable.from([entry.data]) : createReadStream(entry.file);
  }

  isReceiving(exchangeId: string, side: BodySide): boolean {
    return this.writers.has(this.key(exchangeId, side));
  }

  /** Where a body is kept. For tests. */
  location(exchangeId: string, side: BodySide): 'memory' | 'disk' | undefined {
    return this.entries.get(this.key(exchangeId, side))?.where;
  }

  private async removeEntry(key: string): Promise<void> {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (entry?.where === 'disk') await rm(entry.file, { force: true });
  }

  async delete(exchangeId: string): Promise<void> {
    await Promise.all(
      (['request', 'response'] as const).map(async (side) => {
        const key = this.key(exchangeId, side);
        await this.writers.get(key)?.abandon();
        this.writers.delete(key);
        await this.removeEntry(key);
      }),
    );
  }

  async clear(): Promise<void> {
    this.generation++;
    await Promise.allSettled([...this.writers.values()].map((w) => w.abandon()));
    this.writers.clear();
    this.entries.clear();
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  async close(): Promise<void> {
    this.generation++;
    await Promise.allSettled([...this.writers.values()].map((w) => w.abandon()));
    this.writers.clear();
    this.entries.clear();
    await rm(this.dir, { recursive: true, force: true });
  }
}

/**
 * Collects chunks in memory up to `memoryLimit`, then moves to a file and
 * streams the rest there. Stops storing (but keeps counting) past `maxBodySize`.
 */
class HybridWriter implements BodyWriter {
  private chunks: Buffer[] = [];
  private size = 0;
  private stored = 0;
  private stream: WriteStream | undefined;
  private failed: Error | undefined;
  private done = false;
  private result: Promise<StoredBody> | undefined;

  constructor(
    private readonly file: string,
    private readonly memoryLimit: number,
    private readonly maxBodySize: number,
    private readonly onFinish: (entry: Entry | undefined) => void,
  ) {}

  write(chunk: Uint8Array): void {
    if (this.done || chunk.length === 0) return;
    this.size += chunk.length;
    const room = this.maxBodySize - this.stored;
    if (room <= 0) return;
    const part = Buffer.from(chunk.buffer, chunk.byteOffset, Math.min(chunk.length, room));
    this.stored += part.length;

    if (this.stream) {
      this.stream.write(part);
      return;
    }
    this.chunks.push(Buffer.from(part)); // Copy: the caller may reuse its buffer.
    if (this.stored > this.memoryLimit) {
      // Too big for memory: move what we have to a file and stream the rest.
      this.stream = createWriteStream(this.file, { mode: 0o600 });
      this.stream.on('error', (error) => (this.failed = error));
      for (const buffered of this.chunks) this.stream.write(buffered);
      this.chunks = [];
    }
  }

  end(complete: boolean): Promise<StoredBody> {
    this.result ??= this.finish(complete);
    return this.result;
  }

  /** Drops the body, e.g. when its exchange is deleted mid-stream. */
  async abandon(): Promise<void> {
    if (this.done) {
      await this.result?.catch(() => undefined);
      return;
    }
    this.done = true;
    this.chunks = [];
    if (this.stream) {
      await new Promise<void>((resolve) => this.stream!.end(resolve));
      await rm(this.file, { force: true });
    }
    this.result = Promise.resolve({ size: this.size, stored: 0, incomplete: true });
    this.onFinish(undefined);
  }

  private async finish(complete: boolean): Promise<StoredBody> {
    this.done = true;
    const info: StoredBody = { size: this.size, stored: this.stored, incomplete: !complete };
    if (!this.stream) {
      this.onFinish({ where: 'memory', data: Buffer.concat(this.chunks), info });
      this.chunks = [];
      return info;
    }
    await new Promise<void>((resolve) => this.stream!.end(resolve));
    if (this.failed) {
      await rm(this.file, { force: true });
      this.onFinish(undefined);
      throw this.failed;
    }
    this.onFinish({ where: 'disk', file: this.file, info });
    return info;
  }
}
