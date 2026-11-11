import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, open as openFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { BodyRange, BodySide } from '../shared/api';

/** A range as the store knows it: whether the bytes were decoded is the exchange's business. */
export type StoredRange = Omit<BodyRange, 'decoded'>;

/** The most a range read returns at once. */
export const MAX_BODY_RANGE = 1024 * 1024;

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
  /** Bytes stored so far: fewer than written once the body passes the store's limit. */
  readonly stored: number;
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
  /**
   * Up to `maxBytes` (at most MAX_BODY_RANGE) of a body's stored bytes from `start`, whether it has
   * finished or is still arriving. Undefined if there's no body, or it was removed meanwhile.
   */
  readRange(
    exchangeId: string,
    side: BodySide,
    start: number,
    maxBytes: number,
  ): Promise<StoredRange | undefined>;
  delete(exchangeId: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Entry = ({ where: 'memory'; data: Buffer } | { where: 'disk'; file: string }) & {
  info: StoredBody;
  serial: number;
};

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
  /** Numbers each body, so a reader can tell a replaced one, and each has a file of its own. */
  private serial = 0;
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
    const serial = ++this.serial;
    // A file of its own: removing the body this replaces can't remove this one's file.
    const file = path.join(this.dir, `${key}.${serial}`);
    const writer = new HybridWriter(file, serial, this.memoryLimit, this.maxBodySize, (entry) => {
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

  async readRange(
    exchangeId: string,
    side: BodySide,
    start: number,
    maxBytes: number,
  ): Promise<StoredRange | undefined> {
    if (!Number.isSafeInteger(start) || start < 0) throw new Error('start must be a whole number, 0 or more');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error('maxBytes must be a whole number, 1 or more');
    const max = Math.min(maxBytes, MAX_BODY_RANGE);
    const key = this.key(exchangeId, side);
    const writer = this.writers.get(key);
    if (writer) return writer.readRange(start, max);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const { info } = entry;
    const end = Math.min(info.stored, start + max);
    let bytes: Uint8Array | undefined;
    try {
      bytes =
        start >= end
          ? new Uint8Array(0)
          : entry.where === 'memory'
            ? new Uint8Array(entry.data.subarray(start, end))
            : await readFileRange(entry.file, start, end - start);
    } catch (error) {
      // Removed while reading (Windows says so with EPERM or EBUSY rather than ENOENT): nothing.
      if (this.entries.get(key) !== entry) return undefined;
      throw error;
    }
    // Deleted, cleared or replaced meanwhile: what was read may be from a removed file.
    if (!bytes || this.entries.get(key) !== entry) return undefined;
    return {
      bytes,
      stored: info.stored,
      size: info.size,
      receiving: false,
      incomplete: info.incomplete,
      serial: entry.serial,
    };
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
    // Retried: on Windows, a file a reader still has open can't be removed at once.
    await rm(this.dir, { recursive: true, force: true, maxRetries: 5 });
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  async close(): Promise<void> {
    this.generation++;
    await Promise.allSettled([...this.writers.values()].map((w) => w.abandon()));
    this.writers.clear();
    this.entries.clear();
    await rm(this.dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

/**
 * Collects chunks in memory up to `memoryLimit`, then moves to a file and
 * streams the rest there. Stops storing (but keeps counting) past `maxBodySize`.
 */
class HybridWriter implements BodyWriter {
  private chunks: Buffer[] = [];
  /** Bytes the file has, written and flushed. */
  private flushed = 0;
  /** Bytes handed to the file but not flushed yet, oldest first: readers get them from here. */
  private pending: { offset: number; data: Buffer }[] = [];
  /** Bytes handed to the file. */
  private queued = 0;
  private abandoned = false;
  private size = 0;
  private storedBytes = 0;
  private stream: WriteStream | undefined;
  private failed: Error | undefined;
  private done = false;
  private result: Promise<StoredBody> | undefined;

  constructor(
    private readonly file: string,
    private readonly serial: number,
    private readonly memoryLimit: number,
    private readonly maxBodySize: number,
    private readonly onFinish: (entry: Entry | undefined) => void,
  ) {}

  get stored(): number {
    return this.storedBytes;
  }

  write(chunk: Uint8Array): void {
    if (this.done || chunk.length === 0) return;
    this.size += chunk.length;
    const room = this.maxBodySize - this.storedBytes;
    if (room <= 0) return;
    // A copy: the caller may reuse its buffer, and a reader may need it before it reaches the file.
    const part = Buffer.from(chunk.subarray(0, Math.min(chunk.length, room)));
    this.storedBytes += part.length;

    if (this.stream) {
      this.toFile(part);
      return;
    }
    this.chunks.push(part);
    if (this.storedBytes > this.memoryLimit) {
      // Too big for memory: move what we have to a file and stream the rest.
      this.stream = createWriteStream(this.file, { mode: 0o600 });
      this.stream.on('error', (error) => (this.failed = error));
      for (const buffered of this.chunks) this.toFile(buffered);
      this.chunks = [];
    }
  }

  /** Writes to the file, keeping the bytes for readers until they're flushed. */
  private toFile(data: Buffer): void {
    // The file can't be written: the body will be dropped, so don't hold on to it either.
    if (this.failed) return;
    const offset = this.queued;
    this.queued += data.length;
    this.pending.push({ offset, data });
    this.stream!.write(data, (error) => {
      if (error) {
        this.failed ??= error;
        this.pending = [];
        return;
      }
      // Writes finish in order.
      this.flushed = offset + data.length;
      while (
        this.pending.length > 0 &&
        this.pending[0]!.offset + this.pending[0]!.data.length <= this.flushed
      ) {
        this.pending.shift();
      }
    });
  }

  /** Stored bytes from `start` while the body arrives: the file's, then those not flushed yet. */
  async readRange(start: number, max: number): Promise<StoredRange | undefined> {
    const stored = this.storedBytes;
    const end = Math.min(stored, start + max);
    const meta = { stored, size: this.size, receiving: true, incomplete: false, serial: this.serial };
    if (start >= end) return { bytes: new Uint8Array(0), ...meta };
    if (!this.stream) {
      return { bytes: new Uint8Array(Buffer.concat(this.chunks).subarray(start, end)), ...meta };
    }
    // What's flushed now, and the rest still held: the two cover every byte stored so far.
    const flushed = this.flushed;
    const pending = [...this.pending];
    const parts: Buffer[] = [];
    if (start < flushed) {
      let fromFile: Uint8Array | undefined;
      try {
        fromFile = await readFileRange(this.file, start, Math.min(flushed, end) - start);
      } catch (error) {
        if (this.abandoned || this.failed) return undefined;
        throw error;
      }
      if (!fromFile) return undefined;
      parts.push(Buffer.from(fromFile.buffer, fromFile.byteOffset, fromFile.length));
    }
    for (const { offset, data } of pending) {
      const from = Math.max(start, flushed, offset);
      const to = Math.min(end, offset + data.length);
      if (from < to) parts.push(data.subarray(from - offset, to - offset));
    }
    // Dropped while reading (deleted or cleared): what was read may be from a removed file.
    if (this.abandoned || this.failed) return undefined;
    return { bytes: new Uint8Array(Buffer.concat(parts)), ...meta };
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
    this.abandoned = true;
    this.chunks = [];
    this.pending = [];
    if (this.stream) {
      await new Promise<void>((resolve) => this.stream!.end(resolve));
      await rm(this.file, { force: true });
    }
    this.result = Promise.resolve({ size: this.size, stored: 0, incomplete: true });
    this.onFinish(undefined);
  }

  private async finish(complete: boolean): Promise<StoredBody> {
    this.done = true;
    const info: StoredBody = { size: this.size, stored: this.storedBytes, incomplete: !complete };
    if (!this.stream) {
      this.onFinish({ where: 'memory', data: Buffer.concat(this.chunks), info, serial: this.serial });
      this.chunks = [];
      return info;
    }
    await new Promise<void>((resolve) => this.stream!.end(resolve));
    if (this.failed) {
      await rm(this.file, { force: true });
      this.onFinish(undefined);
      throw this.failed;
    }
    this.onFinish({ where: 'disk', file: this.file, info, serial: this.serial });
    return info;
  }
}

/** `length` bytes of a file from `start`; undefined if the file is gone (removed meanwhile). */
async function readFileRange(file: string, start: number, length: number): Promise<Uint8Array | undefined> {
  let handle;
  try {
    handle = await openFile(file, 'r');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}
