import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BodySide } from '../shared/api';

/**
 * Where captured bodies live. Kept apart from the exchange list because bodies
 * can be huge, and so they can be stored somewhere other than memory.
 */
export interface BodyStore {
  put(exchangeId: string, side: BodySide, body: Buffer): Promise<void>;
  get(exchangeId: string, side: BodySide): Promise<Buffer | undefined>;
  delete(exchangeId: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Keeps small bodies in memory and writes larger ones to files in `dir`.
 * The folder is emptied on open and removed on close: captured traffic doesn't
 * outlive the session.
 */
export class HybridBodyStore implements BodyStore {
  private readonly memory = new Map<string, Buffer>();
  private readonly onDisk = new Set<string>();
  /** Writes still in progress, so a read straight after a write waits for it. */
  private readonly pending = new Map<string, Promise<void>>();

  private constructor(
    private readonly dir: string,
    private readonly memoryLimit: number,
  ) {}

  static async open(dir: string, options: { memoryLimit?: number } = {}): Promise<HybridBodyStore> {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return new HybridBodyStore(dir, options.memoryLimit ?? 64 * 1024);
  }

  private key(exchangeId: string, side: BodySide): string {
    if (!SAFE_ID.test(exchangeId)) throw new Error('Invalid exchange id');
    return `${exchangeId}.${side}`;
  }

  async put(exchangeId: string, side: BodySide, body: Buffer): Promise<void> {
    const key = this.key(exchangeId, side);
    if (body.length <= this.memoryLimit) {
      this.memory.set(key, body);
      return;
    }
    const write = writeFile(path.join(this.dir, key), body, { mode: 0o600 }).then(() => {
      this.onDisk.add(key);
    });
    this.pending.set(key, write);
    try {
      await write;
    } finally {
      if (this.pending.get(key) === write) this.pending.delete(key);
    }
  }

  async get(exchangeId: string, side: BodySide): Promise<Buffer | undefined> {
    const key = this.key(exchangeId, side);
    await this.pending.get(key)?.catch(() => undefined);
    const inMemory = this.memory.get(key);
    if (inMemory) return inMemory;
    if (!this.onDisk.has(key)) return undefined;
    return readFile(path.join(this.dir, key));
  }

  async delete(exchangeId: string): Promise<void> {
    await Promise.all(
      (['request', 'response'] as const).map(async (side) => {
        const key = this.key(exchangeId, side);
        await this.pending.get(key)?.catch(() => undefined);
        this.memory.delete(key);
        if (this.onDisk.delete(key)) await rm(path.join(this.dir, key), { force: true });
      }),
    );
  }

  async clear(): Promise<void> {
    await Promise.allSettled(this.pending.values());
    this.memory.clear();
    this.onDisk.clear();
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.pending.values());
    this.memory.clear();
    this.onDisk.clear();
    await rm(this.dir, { recursive: true, force: true });
  }
}
