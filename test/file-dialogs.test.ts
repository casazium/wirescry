import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
const dialogs: Array<{ kind: string; options: { defaultPath?: string } }> = [];
let chosen: string | undefined;

vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test/Downloads' },
  dialog: {
    showSaveDialog: async (options: { defaultPath?: string }) => {
      dialogs.push({ kind: 'save', options });
      return chosen ? { canceled: false, filePath: chosen } : { canceled: true };
    },
    showOpenDialog: async (options: { defaultPath?: string }) => {
      dialogs.push({ kind: 'open', options });
      return chosen ? { canceled: false, filePaths: [chosen] } : { canceled: true, filePaths: [] };
    },
  },
}));

const { openTextFile, saveTextFile, MAX_TEXT_FILE_BYTES } = await import('../src/main/text-files');
const { exportHar, saveBody } = await import('../src/main/har-files');

/** A stand-in for the backend supervisor that must never be reached by refused requests. */
const backend = {
  har: vi.fn(async () => {
    throw new Error('backend reached');
  }),
} as never;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-dialogs-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
beforeEach(() => {
  dialogs.length = 0;
  chosen = undefined;
});

describe('saving and opening text files', () => {
  it('refuses bad requests before showing a dialog', async () => {
    for (const request of [
      null,
      'text',
      { text: 'x', extensions: [] },
      { text: 'x', extensions: ['../json'] },
      { text: 'x', extensions: ['JSON'] },
      { text: 'x', extensions: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { text: 42, extensions: ['json'] },
      { text: 'x'.repeat(MAX_TEXT_FILE_BYTES + 1), extensions: ['json'] },
    ]) {
      await expect(saveTextFile(undefined, request), JSON.stringify(request)?.slice(0, 60)).rejects.toThrow();
    }
    await expect(openTextFile(undefined, { extensions: ['j*'] })).rejects.toThrow('Invalid file type');
    expect(dialogs).toEqual([]);
  });

  it('cleans the suggested name and saves where the user chose', async () => {
    chosen = path.join(dir, 'rules.json');
    const result = await saveTextFile(undefined, {
      text: '{}',
      defaultName: '..\\..\\ev\u0001il<>:|?\u007f.json',
      extensions: ['json'],
    });
    expect(dialogs[0]!.options.defaultPath).toBe(path.join('/Users/test/Downloads', 'evil.json'));
    expect(result).toEqual({ name: 'rules.json' });
  });

  it('refuses to open a file over the size limit', async () => {
    chosen = path.join(dir, 'big.json');
    await writeFile(chosen, Buffer.alloc(MAX_TEXT_FILE_BYTES + 1));
    await expect(openTextFile(undefined, { extensions: ['json'] })).rejects.toThrow('larger than 16 MB');
  });

  it('returns nothing when the user cancels', async () => {
    expect(await saveTextFile(undefined, { text: 'x', extensions: ['json'] })).toEqual({});
    expect(await openTextFile(undefined, { extensions: ['json'] })).toEqual({});
  });
});

describe('HAR export and body saves', () => {
  it('refuses bad exchange lists before showing a dialog', async () => {
    for (const request of [
      [],
      'abc',
      [42],
      ['../etc'],
      ['a b'],
      Array.from({ length: 10_001 }, (_, i) => `id${i}`),
    ]) {
      await expect(exportHar(undefined, backend, request), String(request).slice(0, 40)).rejects.toThrow(
        'Nothing to export',
      );
    }
    for (const request of [
      null,
      { exchangeId: 'ok', side: 'both' },
      { exchangeId: '../x', side: 'response' },
      { side: 'response' },
    ]) {
      await expect(saveBody(undefined, backend, request)).rejects.toThrow('Nothing to save');
    }
    expect(dialogs).toEqual([]);
  });

  it('checks the body can be saved before asking where', async () => {
    await expect(
      saveBody(undefined, backend, { exchangeId: 'abc', side: 'response', name: 'x.json' }),
    ).rejects.toThrow('backend reached');
    expect(dialogs).toEqual([]);
  });
});
