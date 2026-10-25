import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecureStore, ipcEncryptor, type Encryptor } from '../src/backend/secure-store';
import type { CryptoReply, CryptoRequest } from '../src/shared/ipc';

/** Reversible stand-in for safeStorage: base64 of the text with a marker. */
const fakeEncryptor = (): Encryptor => ({
  encrypt: async (text) => Buffer.from(`enc:${text}`).toString('base64'),
  decrypt: async (data) => {
    const text = Buffer.from(data, 'base64').toString();
    if (!text.startsWith('enc:')) throw new Error('not ours');
    return text.slice(4);
  },
});

describe('plugin secure store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-secure-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores values encrypted when there is a keychain', async () => {
    const store = createSecureStore(dir, fakeEncryptor());
    expect(store.encrypted).toBe(true);
    expect(await store.get()).toBeUndefined();
    await store.set({ key: 'ABC', n: 1 });
    expect(await store.get()).toEqual({ value: { key: 'ABC', n: 1 }, encrypted: true });
    // Nothing readable on disk.
    const raw = await readFile(path.join(dir, 'secure-store.json'), 'utf8');
    expect(raw).not.toContain('ABC');
    await store.clear();
    expect(await store.get()).toBeUndefined();
  });

  it('stores plain JSON, marked as such, without a keychain', async () => {
    const store = createSecureStore(dir, undefined);
    expect(store.encrypted).toBe(false);
    await store.set({ key: 'ABC' });
    expect(await store.get()).toEqual({ value: { key: 'ABC' }, encrypted: false });
  });

  it('reads a plain value as not encrypted even when a keychain appears later', async () => {
    await createSecureStore(dir, undefined).set({ forged: true });
    expect(await createSecureStore(dir, fakeEncryptor()).get()).toEqual({
      value: { forged: true },
      encrypted: false,
    });
  });

  it("returns nothing for a value it can't decrypt or parse", async () => {
    await createSecureStore(dir, fakeEncryptor()).set({ key: 'ABC' });
    // No keychain now (or a different one).
    expect(await createSecureStore(dir, undefined).get()).toBeUndefined();
    const other: Encryptor = {
      ...fakeEncryptor(),
      decrypt: async () => Promise.reject(new Error('wrong key')),
    };
    expect(await createSecureStore(dir, other).get()).toBeUndefined();
    await writeFile(path.join(dir, 'secure-store.json'), '{not json');
    expect(await createSecureStore(dir, fakeEncryptor()).get()).toBeUndefined();
  });

  it('refuses values JSON cannot hold, or over 1 MB, and leaves no temp files', async () => {
    const store = createSecureStore(dir, fakeEncryptor());
    await expect(store.set(undefined)).rejects.toThrow(TypeError);
    await expect(store.set('x'.repeat(1024 * 1024 + 1))).rejects.toThrow(RangeError);
    await store.set('ok');
    expect(await readdir(dir)).toEqual(['secure-store.json']);
  });

  it('keeps writes in order', async () => {
    const store = createSecureStore(dir, fakeEncryptor());
    await Promise.all([store.set(1), store.set(2), store.set(3)]);
    expect((await store.get())?.value).toBe(3);
  });
});

describe('IPC encryptor', () => {
  it('matches replies to requests, and passes errors on', async () => {
    const sent: CryptoRequest[] = [];
    const encryptor = ipcEncryptor((request) => sent.push(request));
    const a = encryptor.encrypt('hello');
    const b = encryptor.decrypt('d29ybGQ=');
    expect(sent.map((r) => r.op)).toEqual(['encrypt', 'decrypt']);
    const reply = (r: CryptoReply): void => encryptor.receive(r);
    reply({ type: 'crypto-result', id: sent[1]!.id, ok: false, error: 'locked' });
    reply({ type: 'crypto-result', id: sent[0]!.id, ok: true, data: 'aGVsbG8=' });
    // Unknown ids are ignored.
    reply({ type: 'crypto-result', id: 999, ok: true, data: 'x' });
    await expect(a).resolves.toBe('aGVsbG8=');
    await expect(b).rejects.toThrow('locked');
  });
});
