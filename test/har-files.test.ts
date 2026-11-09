/**
 * The main process's half of HAR export, HAR import and saving a body (src/main/har-files.ts):
 * it asks where, has the backend write or read a scratch file in Wirescry's data folder, and
 * copies between that and the user's file. With real files in a temporary folder, and the
 * dialogs and backend stood in for. The requests it refuses are in file-dialogs.test.ts.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Recorded when a dialog is shown without a window argument at all. */
const NO_WINDOW = 'no window argument';

const fake = vi.hoisted(() => ({
  root: '',
  /** What the next dialog answers: a path, or nothing for Cancel. */
  chosen: undefined as string | undefined,
  dialogs: [] as Array<{ kind: 'save' | 'open'; window: unknown; options: Record<string, unknown> }>,
  /** Makes copies run out of disk space halfway, as on a full disk. */
  diskFull: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const copyFile: typeof actual.copyFile = async (from, to, mode) => {
    if (!fake.diskFull) return actual.copyFile(from, to, mode);
    const data = await actual.readFile(from);
    await actual.writeFile(to, data.subarray(0, Math.floor(data.length / 2)));
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  return { ...actual, copyFile, default: { ...actual, copyFile } };
});

vi.mock('electron', async () => {
  const nodePath = await import('node:path');
  return {
    app: {
      getPath: (name: string) => nodePath.join(fake.root, name === 'userData' ? 'data' : name),
    },
    dialog: {
      showSaveDialog: async (...args: unknown[]) => {
        fake.dialogs.push({
          kind: 'save',
          window: args.length > 1 ? args[0] : NO_WINDOW,
          options: args.at(-1) as Record<string, unknown>,
        });
        return fake.chosen ? { canceled: false, filePath: fake.chosen } : { canceled: true, filePath: '' };
      },
      showOpenDialog: async (...args: unknown[]) => {
        fake.dialogs.push({
          kind: 'open',
          window: args.length > 1 ? args[0] : NO_WINDOW,
          options: args.at(-1) as Record<string, unknown>,
        });
        return fake.chosen
          ? { canceled: false, filePaths: [fake.chosen] }
          : { canceled: true, filePaths: [] };
      },
    },
  };
});

const { clearScratch, exportHar, importHar, saveBody } = await import('../src/main/har-files');
const { MAX_HAR_IMPORT_BYTES } = await import('../src/backend/har');

type Job = {
  op: string;
  file: string;
  exchangeIds?: string[];
  name?: string;
  exchangeId?: string;
  side?: string;
};

/** A stand-in for the backend supervisor: runs `work` for each HAR job, and records the jobs. */
function backend(work: (job: Job) => Promise<unknown>) {
  const jobs: Job[] = [];
  const har = vi.fn(async (job: Job) => {
    jobs.push(job);
    return work(job);
  });
  return { supervisor: { har } as never, har, jobs };
}

const scratchDir = () => path.join(fake.root, 'data', 'har-transfer');
const downloads = () => path.join(fake.root, 'downloads');
/** The files in a folder, or none if it isn't there. */
const filesIn = async (dir: string) => (existsSync(dir) ? (await readdir(dir)).sort() : []);
const window = { id: 1 } as never;

beforeEach(async () => {
  fake.root = await mkdtemp(path.join(os.tmpdir(), 'wirescry-har-files-'));
  fake.chosen = undefined;
  fake.dialogs = [];
  fake.diskFull = false;
  await mkdir(downloads());
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(fake.root, { recursive: true, force: true });
});

describe('Exporting a HAR file', () => {
  it('asks where, has the backend write it, and puts it there', async () => {
    // The suggested name has the date: fixed, so a run across midnight can't fail.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
    fake.chosen = path.join(downloads(), 'capture.har');
    const { supervisor, jobs } = backend(async (job) => {
      // The backend only ever writes inside Wirescry's data folder.
      expect(path.dirname(job.file)).toBe(scratchDir());
      await writeFile(job.file, '{"log":{"entries":[1,2]}}');
      return { count: 2 };
    });
    const result = await exportHar(window, supervisor, ['a1', 'b_2-x']);
    expect(result).toEqual({ name: 'capture.har', count: 2 });
    expect(jobs).toEqual([{ op: 'export', file: expect.any(String), exchangeIds: ['a1', 'b_2-x'] }]);
    expect(await readFile(fake.chosen, 'utf8')).toBe('{"log":{"entries":[1,2]}}');
    expect(fake.dialogs).toEqual([
      {
        kind: 'save',
        window,
        options: {
          defaultPath: path.join(downloads(), 'wirescry-2026-11-09.har'),
          filters: [{ name: 'HAR (HTTP Archive)', extensions: ['har'] }],
        },
      },
    ]);
    // Nothing left behind: no scratch file, no temporary file beside the export.
    expect(await filesIn(scratchDir())).toEqual([]);
    expect(await filesIn(downloads())).toEqual(['capture.har']);
  });

  it('replaces a file the user chose to replace', async () => {
    fake.chosen = path.join(downloads(), 'capture.har');
    await writeFile(fake.chosen, 'an older, longer capture that must not show through');
    const { supervisor } = backend(async (job) => {
      await writeFile(job.file, 'new');
      return { count: 1 };
    });
    await exportHar(undefined, supervisor, ['a1']);
    expect(await readFile(fake.chosen, 'utf8')).toBe('new');
    // Without a window, the dialog is shown on its own.
    expect(fake.dialogs[0]!.window).toBe(NO_WINDOW);
  });

  it('does nothing when the user cancels', async () => {
    const { supervisor, har } = backend(async () => ({ count: 1 }));
    expect(await exportHar(undefined, supervisor, ['a1'])).toEqual({});
    expect(har).not.toHaveBeenCalled();
    expect(await filesIn(scratchDir())).toEqual([]);
  });

  it('takes up to 10,000 exchanges, with ids up to 128 characters', async () => {
    fake.chosen = path.join(downloads(), 'big.har');
    const { supervisor, jobs } = backend(async (job) => {
      await writeFile(job.file, '{}');
      return { count: job.exchangeIds!.length };
    });
    const ids = Array.from({ length: 10_000 }, (_, i) => `id${i}`);
    ids[0] = 'x'.repeat(128);
    expect(await exportHar(undefined, supervisor, ids)).toEqual({ name: 'big.har', count: 10_000 });
    expect(jobs[0]!.exchangeIds).toHaveLength(10_000);
    await expect(exportHar(undefined, supervisor, ['x'.repeat(129)])).rejects.toThrow('Nothing to export.');
  });

  it('leaves the user’s file as it was when the backend fails, and cleans up', async () => {
    fake.chosen = path.join(downloads(), 'capture.har');
    await writeFile(fake.chosen, 'the user’s earlier export');
    const { supervisor } = backend(async (job) => {
      await writeFile(job.file, '{"log":');
      throw new Error('The backend stopped while working on the file.');
    });
    await expect(exportHar(undefined, supervisor, ['a1'])).rejects.toThrow(
      'The backend stopped while working on the file.',
    );
    expect(await readFile(fake.chosen, 'utf8')).toBe('the user’s earlier export');
    expect(await filesIn(scratchDir())).toEqual([]);
    expect(await filesIn(downloads())).toEqual(['capture.har']);
  });

  it('leaves no temporary file when it can’t be put in place', async () => {
    // A folder can't be replaced by a file, so the last step fails.
    fake.chosen = path.join(downloads(), 'capture.har');
    await mkdir(fake.chosen);
    const { supervisor } = backend(async (job) => {
      await writeFile(job.file, '{}');
      return { count: 1 };
    });
    await expect(exportHar(undefined, supervisor, ['a1'])).rejects.toThrow();
    expect(await filesIn(downloads())).toEqual(['capture.har']);
    expect((await stat(fake.chosen)).isDirectory()).toBe(true);
    expect(await filesIn(scratchDir())).toEqual([]);
  });

  it('leaves the user’s earlier file whole when the disk fills up', async () => {
    fake.chosen = path.join(downloads(), 'capture.har');
    await writeFile(fake.chosen, 'the user’s earlier export');
    const { supervisor } = backend(async (job) => {
      await writeFile(job.file, '{"log":{"entries":["a long new capture"]}}');
      return { count: 1 };
    });
    fake.diskFull = true;
    await expect(exportHar(undefined, supervisor, ['a1'])).rejects.toThrow('ENOSPC');
    expect(await readFile(fake.chosen, 'utf8')).toBe('the user’s earlier export');
    expect(await filesIn(downloads())).toEqual(['capture.har']);
    expect(await filesIn(scratchDir())).toEqual([]);
  });

  it('keeps its scratch folder private to this user', async () => {
    if (process.platform === 'win32') return; // Folder permissions work differently there.
    fake.chosen = path.join(downloads(), 'capture.har');
    const { supervisor } = backend(async (job) => {
      await writeFile(job.file, '{}');
      return { count: 1 };
    });
    await exportHar(undefined, supervisor, ['a1']);
    expect((await stat(scratchDir())).mode & 0o777).toBe(0o700);
  });
});

describe('Importing a HAR file', () => {
  it('asks for a file, has the backend read a copy, and says what it added', async () => {
    fake.chosen = path.join(fake.root, 'from-a-colleague.har');
    await writeFile(fake.chosen, '{"log":{"entries":[]}}');
    const { supervisor, jobs } = backend(async (job) => {
      // The backend reads a copy in Wirescry's data folder, never the user's file.
      expect(path.dirname(job.file)).toBe(scratchDir());
      expect(await readFile(job.file, 'utf8')).toBe('{"log":{"entries":[]}}');
      return { imported: 3, skipped: 1, problems: ['Entry 4 has no URL.'] };
    });
    const result = await importHar(window, supervisor);
    expect(result).toEqual({
      name: 'from-a-colleague.har',
      imported: 3,
      skipped: 1,
      problems: ['Entry 4 has no URL.'],
    });
    expect(jobs).toEqual([{ op: 'import', file: expect.any(String), name: 'from-a-colleague.har' }]);
    expect(fake.dialogs).toEqual([
      {
        kind: 'open',
        window,
        options: {
          properties: ['openFile'],
          filters: [
            { name: 'HAR (HTTP Archive)', extensions: ['har'] },
            { name: 'JSON', extensions: ['json'] },
          ],
        },
      },
    ]);
    // The user's file is untouched, and the copy is gone.
    expect(await readFile(fake.chosen, 'utf8')).toBe('{"log":{"entries":[]}}');
    expect(await filesIn(scratchDir())).toEqual([]);
  });

  it('does nothing when the user cancels', async () => {
    const { supervisor, har } = backend(async () => ({}));
    expect(await importHar(undefined, supervisor)).toEqual({});
    expect(har).not.toHaveBeenCalled();
  });

  it('refuses a folder, and a file that’s gone', async () => {
    const { supervisor, har } = backend(async () => ({}));
    fake.chosen = downloads();
    await expect(importHar(undefined, supervisor)).rejects.toThrow("That isn't a file.");
    fake.chosen = path.join(fake.root, 'deleted.har');
    await expect(importHar(undefined, supervisor)).rejects.toThrow(/ENOENT/);
    expect(har).not.toHaveBeenCalled();
    expect(await filesIn(scratchDir())).toEqual([]);
  });

  it('cleans up a half copy when the disk fills up', async () => {
    fake.chosen = path.join(fake.root, 'capture.har');
    await writeFile(fake.chosen, '{"log":{"entries":[]}}');
    const { supervisor, har } = backend(async () => ({}));
    fake.diskFull = true;
    await expect(importHar(undefined, supervisor)).rejects.toThrow('ENOSPC');
    expect(har).not.toHaveBeenCalled();
    expect(await filesIn(scratchDir())).toEqual([]);
    expect(await readFile(fake.chosen, 'utf8')).toBe('{"log":{"entries":[]}}');
  });

  it('refuses a file over the size limit, without copying it', async () => {
    fake.chosen = path.join(fake.root, 'huge.har');
    await writeFile(fake.chosen, '');
    // A sparse file: the size counts, but nothing is written.
    await truncate(fake.chosen, MAX_HAR_IMPORT_BYTES + 1);
    const { supervisor, har } = backend(async () => ({}));
    await expect(importHar(undefined, supervisor)).rejects.toThrow('That file is larger than 256 MB.');
    expect(har).not.toHaveBeenCalled();
    expect(await filesIn(scratchDir())).toEqual([]);
  });

  it('cleans up its copy when the backend fails', async () => {
    fake.chosen = path.join(fake.root, 'broken.har');
    await writeFile(fake.chosen, 'not json');
    const { supervisor } = backend(async () => {
      throw new Error('That file isn’t a HAR file.');
    });
    await expect(importHar(undefined, supervisor)).rejects.toThrow('That file isn’t a HAR file.');
    expect(await filesIn(scratchDir())).toEqual([]);
    expect(await readFile(fake.chosen, 'utf8')).toBe('not json');
  });
});

describe('Saving a body', () => {
  it('checks it can be saved, asks where, has the backend write all of it, and puts it there', async () => {
    fake.chosen = path.join(downloads(), 'users.json');
    const { supervisor, jobs } = backend(async (job) => {
      if (job.file === '') return {};
      expect(path.dirname(job.file)).toBe(scratchDir());
      await writeFile(job.file, '{"users":[]}');
      return { size: 12, decoded: true };
    });
    const result = await saveBody(window, supervisor, {
      exchangeId: 'x1',
      side: 'response',
      name: '../users.json',
    });
    // Exactly these: no empty decodeError for the window to show.
    expect(result).toStrictEqual({ name: 'users.json', size: 12 });
    expect(jobs).toEqual([
      { op: 'body', file: '', exchangeId: 'x1', side: 'response' },
      { op: 'body', file: expect.any(String), exchangeId: 'x1', side: 'response' },
    ]);
    // The suggested name is cleaned before it's used.
    expect(fake.dialogs).toEqual([
      { kind: 'save', window, options: { defaultPath: path.join(downloads(), 'users.json') } },
    ]);
    expect(await readFile(fake.chosen, 'utf8')).toBe('{"users":[]}');
    expect(await filesIn(scratchDir())).toEqual([]);
    expect(await filesIn(downloads())).toEqual(['users.json']);
  });

  it('says when the body couldn’t be decoded, so it was saved as stored', async () => {
    fake.chosen = path.join(downloads(), 'body.bin');
    const { supervisor } = backend(async (job) => {
      if (job.file === '') return {};
      await writeFile(job.file, Buffer.from([0x1f, 0x8b, 0]));
      return { size: 3, decoded: false, decodeError: 'The gzip data is cut short.' };
    });
    expect(await saveBody(undefined, supervisor, { exchangeId: 'x1', side: 'request' })).toEqual({
      name: 'body.bin',
      size: 3,
      decodeError: 'The gzip data is cut short.',
    });
    // No suggestion: a plain name.
    expect(fake.dialogs[0]!.options).toEqual({ defaultPath: path.join(downloads(), 'body') });
  });

  it('does nothing more when the user cancels', async () => {
    const { supervisor, jobs } = backend(async () => ({}));
    expect(await saveBody(undefined, supervisor, { exchangeId: 'x1', side: 'response' })).toEqual({});
    expect(jobs).toEqual([{ op: 'body', file: '', exchangeId: 'x1', side: 'response' }]);
    expect(await filesIn(scratchDir())).toEqual([]);
  });

  it('leaves the user’s file as it was when the backend fails, and cleans up', async () => {
    fake.chosen = path.join(downloads(), 'users.json');
    await writeFile(fake.chosen, 'kept');
    const { supervisor } = backend(async (job) => {
      if (job.file === '') return {};
      await writeFile(job.file, 'part');
      throw new Error('That body is no longer stored.');
    });
    await expect(saveBody(undefined, supervisor, { exchangeId: 'x1', side: 'response' })).rejects.toThrow(
      'That body is no longer stored.',
    );
    expect(await readFile(fake.chosen, 'utf8')).toBe('kept');
    expect(await filesIn(scratchDir())).toEqual([]);
    expect(await filesIn(downloads())).toEqual(['users.json']);
  });

  it('leaves the user’s earlier file whole when the disk fills up', async () => {
    fake.chosen = path.join(downloads(), 'users.json');
    await writeFile(fake.chosen, 'kept');
    const { supervisor } = backend(async (job) => {
      if (job.file !== '') await writeFile(job.file, '{"users":["a","b","c"]}');
      return { size: 23, decoded: true };
    });
    fake.diskFull = true;
    await expect(saveBody(undefined, supervisor, { exchangeId: 'x1', side: 'response' })).rejects.toThrow(
      'ENOSPC',
    );
    expect(await readFile(fake.chosen, 'utf8')).toBe('kept');
    expect(await filesIn(downloads())).toEqual(['users.json']);
    expect(await filesIn(scratchDir())).toEqual([]);
  });

  it('leaves no temporary file when it can’t be put in place', async () => {
    fake.chosen = path.join(downloads(), 'users.json');
    await mkdir(fake.chosen);
    const { supervisor } = backend(async (job) => {
      if (job.file !== '') await writeFile(job.file, '{}');
      return { size: 2, decoded: true };
    });
    await expect(saveBody(undefined, supervisor, { exchangeId: 'x1', side: 'response' })).rejects.toThrow();
    expect(await filesIn(downloads())).toEqual(['users.json']);
    expect(await filesIn(scratchDir())).toEqual([]);
  });
});

describe('Clearing scratch files at startup', () => {
  it('removes what a crash or a slow job left, and copes with none', async () => {
    await mkdir(scratchDir(), { recursive: true });
    await writeFile(path.join(scratchDir(), 'left-by-a-crash.har'), '{}');
    await clearScratch();
    expect(existsSync(scratchDir())).toBe(false);
    await expect(clearScratch()).resolves.toBeUndefined();
    // Only its own folder: the rest of the data folder stays.
    await mkdir(path.join(fake.root, 'data'), { recursive: true });
    await writeFile(path.join(fake.root, 'data', 'settings.json'), '{}');
    await clearScratch();
    expect(await filesIn(path.join(fake.root, 'data'))).toEqual(['settings.json']);
  });
});
