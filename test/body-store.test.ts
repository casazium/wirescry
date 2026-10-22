import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HybridBodyStore } from '../src/backend/body-store';

describe('HybridBodyStore', () => {
  let root: string;
  let dir: string;
  let store: HybridBodyStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'leverframe-bodies-test-'));
    dir = path.join(root, 'bodies');
    store = await HybridBodyStore.open(dir, { memoryLimit: 10 });
  });

  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('keeps small bodies in memory and writes large ones to disk', async () => {
    await store.put('small', 'request', Buffer.from('tiny'));
    await store.put('large', 'response', Buffer.from('this is more than ten bytes'));
    expect(await readdir(dir)).toEqual(['large.response']);
    // Windows doesn't use Unix permission bits.
    if (process.platform !== 'win32') {
      expect((await stat(path.join(dir, 'large.response'))).mode & 0o077).toBe(0);
    }
    expect((await store.get('small', 'request'))?.toString()).toBe('tiny');
    expect((await store.get('large', 'response'))?.toString()).toBe('this is more than ten bytes');
    expect(await store.get('large', 'request')).toBeUndefined();
  });

  it('can read a body while it is still being written', async () => {
    const write = store.put('id', 'response', Buffer.alloc(1024 * 1024, 1));
    const read = await store.get('id', 'response');
    await write;
    expect(read?.length).toBe(1024 * 1024);
  });

  it('deletes and clears bodies, and removes its folder on close', async () => {
    await store.put('a', 'response', Buffer.from('a body that goes to disk'));
    await store.put('b', 'response', Buffer.from('another body for the disk'));
    await store.delete('a');
    expect(await store.get('a', 'response')).toBeUndefined();
    expect(await readdir(dir)).toEqual(['b.response']);
    await store.clear();
    expect(await readdir(dir)).toEqual([]);
    expect(await store.get('b', 'response')).toBeUndefined();
    await store.close();
    await expect(stat(dir)).rejects.toThrow();
  });

  it('empties leftovers from an earlier run when opened', async () => {
    await store.put('old', 'response', Buffer.from('left over from last time'));
    const reopened = await HybridBodyStore.open(dir);
    expect(await readdir(dir)).toEqual([]);
    await reopened.close();
  });

  it('rejects ids that could escape its folder', async () => {
    await expect(store.put('../evil', 'request', Buffer.from('x'))).rejects.toThrow('Invalid exchange id');
    await expect(store.get('a/b', 'request')).rejects.toThrow('Invalid exchange id');
  });
});
