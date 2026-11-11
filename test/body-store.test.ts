import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HybridBodyStore, MAX_BODY_RANGE } from '../src/backend/body-store';

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
    root = await mkdtemp(path.join(os.tmpdir(), 'wirescry-bodies-test-'));
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
    // Each body's file is its own, numbered: a replaced body's cleanup can't touch the new one.
    const files = await readdir(dir);
    expect(files).toEqual([expect.stringMatching(/^large\.response\.\d+$/)]);
    if (process.platform !== 'win32') {
      expect((await stat(path.join(dir, files[0]!))).mode & 0o077).toBe(0);
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
    expect(await readdir(dir)).toEqual([expect.stringMatching(/^b\.response\.\d+$/)]);
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

describe('reading part of a body, while it arrives or after', () => {
  let root: string;
  let store: HybridBodyStore;
  const text = (bytes: Uint8Array | undefined) => (bytes ? Buffer.from(bytes).toString() : undefined);
  /** Waits until the body's file holds `size` bytes. */
  const untilFlushed = async (id: string, size: number): Promise<void> => {
    await expect
      .poll(async () => {
        const files = (await readdir(path.join(root, 'bodies'))).filter((f) =>
          f.startsWith(`${id}.response.`),
        );
        return files.length === 1 ? (await stat(path.join(root, 'bodies', files[0]!))).size : -1;
      })
      .toBe(size);
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wirescry-range-test-'));
    store = await HybridBodyStore.open(path.join(root, 'bodies'), { memoryLimit: 10, maxBodySize: 64 });
  });

  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('reads a body in memory while it arrives, then once it has finished', async () => {
    const writer = store.open('m', 'response');
    writer.write(Buffer.from('hello'));
    const live = await store.readRange('m', 'response', 1, 3);
    expect(text(live!.bytes)).toBe('ell');
    expect(live).toMatchObject({ stored: 5, size: 5, receiving: true, incomplete: false });
    await writer.end(true);
    const done = await store.readRange('m', 'response', 2, 100);
    expect(text(done!.bytes)).toBe('llo');
    expect(done).toMatchObject({ stored: 5, receiving: false, serial: live!.serial });
  });

  it('can read every byte counted, across the move to a file and before it is flushed', async () => {
    const writer = store.open('d', 'response');
    let sent = '';
    for (const part of ['0123456', '789abcdef', 'ghij', 'klmnopqrstuv']) {
      writer.write(Buffer.from(part));
      sent += part;
      // Straight after the write: some of it may not have reached the file yet.
      const range = await store.readRange('d', 'response', 0, 1000);
      expect(range!.stored).toBe(writer.stored);
      expect(text(range!.bytes)).toBe(sent);
    }
    expect(text((await store.readRange('d', 'response', 20, 5))!.bytes)).toBe('klmno');
    await writer.end(true);
    expect(store.location('d', 'response')).toBe('disk');
    const done = await store.readRange('d', 'response', 30, 100);
    expect(text(done!.bytes)).toBe('uv');
    expect(done).toMatchObject({ stored: 32, receiving: false });
  });

  it('says how much arrived and how much was kept past the limit', async () => {
    const writer = store.open('big', 'response');
    writer.write(Buffer.alloc(100, 1));
    const live = await store.readRange('big', 'response', 0, 1000);
    expect(live).toMatchObject({ stored: 64, size: 100 });
    expect(live!.bytes.length).toBe(64);
    await writer.end(false);
    expect(await store.readRange('big', 'response', 0, 1000)).toMatchObject({
      stored: 64,
      size: 100,
      incomplete: true,
    });
  });

  it('gives a new serial to a body that replaces another', async () => {
    const first = store.open('r', 'response');
    first.write(Buffer.from('first body, on disk'));
    const before = await store.readRange('r', 'response', 0, 5);
    const second = store.open('r', 'response');
    second.write(Buffer.from('second body, on disk too'));
    const after = await store.readRange('r', 'response', 0, 6);
    expect(text(after!.bytes)).toBe('second');
    expect(after!.serial).not.toBe(before!.serial);
    await second.end(true);
    // The first body's cleanup ran meanwhile: the second's file is untouched.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(text((await store.readRange('r', 'response', 0, 100))!.bytes)).toBe('second body, on disk too');
  });

  it('caps a read at the most it returns at once', async () => {
    const big = await HybridBodyStore.open(path.join(root, 'big'), { memoryLimit: 1024 });
    try {
      await big.put('x', 'response', Buffer.alloc(MAX_BODY_RANGE + 10, 2));
      const range = await big.readRange('x', 'response', 0, MAX_BODY_RANGE * 4);
      expect(range!.bytes.length).toBe(MAX_BODY_RANGE);
      expect(range!.stored).toBe(MAX_BODY_RANGE + 10);
    } finally {
      await big.close();
    }
  });

  it('returns nothing past the end, and nothing for a body that was never there', async () => {
    await store.put('e', 'request', Buffer.from('abc'));
    expect((await store.readRange('e', 'request', 3, 10))!.bytes.length).toBe(0);
    expect((await store.readRange('e', 'request', 99, 10))!.bytes.length).toBe(0);
    expect(await store.readRange('e', 'response', 0, 10)).toBeUndefined();
    expect(await store.readRange('nobody', 'request', 0, 10)).toBeUndefined();
  });

  it('returns nothing once the body is deleted or cleared, even mid-stream', async () => {
    const writer = store.open('gone', 'response');
    writer.write(Buffer.from('on its way to the disk'));
    expect(await store.readRange('gone', 'response', 0, 5)).toBeDefined();
    await store.delete('gone');
    expect(await store.readRange('gone', 'response', 0, 5)).toBeUndefined();

    const other = store.open('cleared', 'response');
    other.write(Buffer.from('also on its way to disk'));
    const reading = store.readRange('cleared', 'response', 0, 100);
    await store.clear();
    // Read before the clear began, or nothing: never an error.
    const result = await reading;
    expect(result === undefined || text(result.bytes) === 'also on its way to disk').toBe(true);
    expect(await store.readRange('cleared', 'response', 0, 5)).toBeUndefined();
  });

  it('returns nothing for a body deleted while it was being read from its file', async () => {
    const writer = store.open('mid', 'response');
    writer.write(Buffer.from('a body long enough for the disk'));
    // Until it has all reached the file, so the read below goes to the file.
    await untilFlushed('mid', 31);
    const reading = store.readRange('mid', 'response', 0, 100);
    const deleting = store.delete('mid');
    expect(await reading).toBeUndefined();
    await deleting;
  });

  it('returns nothing for a body replaced while it was being read, then the new one', async () => {
    const first = store.open('swap', 'response');
    first.write(Buffer.from('the first body, on disk'));
    await untilFlushed('swap', 23);
    const before = await store.readRange('swap', 'response', 0, 3);
    const reading = store.readRange('swap', 'response', 0, 100);
    const second = store.open('swap', 'response');
    second.write(Buffer.from('second'));
    expect(await reading).toBeUndefined();
    const after = await store.readRange('swap', 'response', 0, 100);
    expect(text(after!.bytes)).toBe('second');
    expect(after!.serial).not.toBe(before!.serial);
  });

  it('returns nothing for a finished body deleted or cleared while being read from its file', async () => {
    await store.put('fin', 'response', Buffer.from('a finished body on the disk'));
    expect(store.location('fin', 'response')).toBe('disk');
    const reading = store.readRange('fin', 'response', 0, 100);
    const deleting = store.delete('fin');
    expect(await reading).toBeUndefined();
    await deleting;

    await store.put('fin2', 'response', Buffer.from('another finished body on disk'));
    const reading2 = store.readRange('fin2', 'response', 0, 100);
    const clearing = store.clear();
    expect(await reading2).toBeUndefined();
    await clearing;
  });

  it('reads a body while it is being finished', async () => {
    const writer = store.open('ending', 'response');
    writer.write(Buffer.from('nearly done, on the disk'));
    const ending = writer.end(true);
    const range = await store.readRange('ending', 'response', 0, 100);
    expect(text(range!.bytes)).toBe('nearly done, on the disk');
    await ending;
    expect(text((await store.readRange('ending', 'response', 0, 100))!.bytes)).toBe(
      'nearly done, on the disk',
    );
  });

  it('drops a body whose file can’t be written, and keeps nothing of it in memory', async () => {
    // The file it would use is taken by a folder: the next body opened is numbered 1.
    await mkdir(path.join(root, 'bodies', 'fail.response.1'));
    const writer = store.open('fail', 'response');
    writer.write(Buffer.from('more than ten bytes'));
    await expect.poll(async () => store.readRange('fail', 'response', 0, 100)).toBeUndefined();
    writer.write(Buffer.from('and more after the failure'));
    expect(await store.readRange('fail', 'response', 0, 100)).toBeUndefined();
    await expect(writer.end(true)).rejects.toThrow();
    expect(await store.readRange('fail', 'response', 0, 100)).toBeUndefined();
  });

  it('refuses offsets and lengths that aren’t whole numbers in range', async () => {
    await store.put('v', 'request', Buffer.from('abc'));
    for (const [start, max] of [
      [-1, 10],
      [0.5, 10],
      [Number.NaN, 10],
      [0, 0],
      [0, 2.5],
      [0, -3],
    ] as const) {
      await expect(store.readRange('v', 'request', start, max)).rejects.toThrow(/whole number/);
    }
    await expect(store.readRange('../x', 'request', 0, 1)).rejects.toThrow(/Invalid exchange id/);
  });
});
