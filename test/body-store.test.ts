import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HybridBodyStore } from '../src/backend/body-store';

async function readAll(stream: Readable | undefined): Promise<string | undefined> {
  if (!stream) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString();
}

describe('HybridBodyStore', () => {
  let root: string;
  let dir: string;
  let store: HybridBodyStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'leverframe-bodies-test-'));
    dir = path.join(root, 'bodies');
    store = await HybridBodyStore.open(dir, { memoryLimit: 10, maxBodySize: 40 });
  });

  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('keeps small bodies in memory and streams larger ones to disk', async () => {
    await store.put('small', 'request', Buffer.from('tiny'));
    const writer = store.open('large', 'response');
    writer.write(Buffer.from('this is more '));
    writer.write(Buffer.from('than ten bytes'));
    expect(store.isReceiving('large', 'response')).toBe(true);
    expect(store.read('large', 'response')).toBeUndefined();
    expect(await writer.end(true)).toEqual({ size: 27, stored: 27, incomplete: false });

    expect(store.location('small', 'request')).toBe('memory');
    expect(store.location('large', 'response')).toBe('disk');
    expect(await readdir(dir)).toEqual(['large.response']);
    if (process.platform !== 'win32') {
      expect((await stat(path.join(dir, 'large.response'))).mode & 0o077).toBe(0);
    }
    expect(await readAll(store.read('small', 'request'))).toBe('tiny');
    expect(await readAll(store.read('large', 'response'))).toBe('this is more than ten bytes');
    expect(store.read('large', 'request')).toBeUndefined();
  });

  it('keeps only the first maxBodySize bytes but counts them all', async () => {
    const writer = store.open('big', 'response');
    for (let i = 0; i < 10; i++) writer.write(Buffer.from('0123456789'));
    expect(await writer.end(true)).toEqual({ size: 100, stored: 40, incomplete: false });
    expect(await readAll(store.read('big', 'response'))).toBe('0123456789'.repeat(4));
  });

  it('marks a body that was cut off', async () => {
    const writer = store.open('cut', 'response');
    writer.write(Buffer.from('partial'));
    expect(await writer.end(false)).toMatchObject({ size: 7, incomplete: true });
    expect(await readAll(store.read('cut', 'response'))).toBe('partial');
  });

  it('copies chunks, so the caller can reuse its buffer', async () => {
    const buffer = Buffer.from('abc');
    const writer = store.open('copy', 'request');
    writer.write(buffer);
    buffer.write('xyz');
    await writer.end(true);
    expect(await readAll(store.read('copy', 'request'))).toBe('abc');
  });

  it('drops a body that is deleted while still arriving', async () => {
    const writer = store.open('gone', 'response');
    writer.write(Buffer.from('more than ten bytes of data'));
    await store.delete('gone');
    await writer.end(true);
    expect(store.read('gone', 'response')).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  it("doesn't keep bodies that finish after a clear", async () => {
    const writer = store.open('old', 'response');
    writer.write(Buffer.from('tiny'));
    await store.clear();
    await writer.end(true);
    expect(store.read('old', 'response')).toBeUndefined();
  });

  it('deletes and clears bodies, and removes its folder on close', async () => {
    await store.put('a', 'response', Buffer.from('a body that goes to disk'));
    await store.put('b', 'response', Buffer.from('another body for the disk'));
    await store.delete('a');
    expect(store.read('a', 'response')).toBeUndefined();
    expect(await readdir(dir)).toEqual(['b.response']);
    await store.clear();
    expect(await readdir(dir)).toEqual([]);
    await store.close();
    await expect(stat(dir)).rejects.toThrow();
  });

  it('empties leftovers from an earlier run when opened', async () => {
    await store.put('old', 'response', Buffer.from('left over from last time'));
    const reopened = await HybridBodyStore.open(dir);
    expect(await readdir(dir)).toEqual([]);
    await reopened.close();
  });

  it('rejects ids that could escape its folder', () => {
    expect(() => store.open('../evil', 'request')).toThrow('Invalid exchange id');
    expect(() => store.read('a/b', 'request')).toThrow('Invalid exchange id');
  });
});
