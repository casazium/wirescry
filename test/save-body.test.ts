import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeBodyToFile } from '../src/backend/body-content';
import { bodyFileName as suggestedName } from '../src/renderer/src/body-file-name';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, dialog: {} }));
const { bodyFileName: cleanName } = await import('../src/main/har-files');

describe('writeBodyToFile', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-save-body-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('writes a gzip body decoded', async () => {
    const file = path.join(dir, 'a.json');
    const text = JSON.stringify({ hello: 'world'.repeat(1000) });
    const result = await writeBodyToFile(
      () => Readable.from([gzipSync(text)]),
      [['Content-Encoding', 'gzip']],
      file,
    );
    expect(result).toEqual({ size: text.length, decoded: true });
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('writes the stored bytes when decoding fails, and says why', async () => {
    const file = path.join(dir, 'b.bin');
    const stored = Buffer.from('not really gzip');
    const result = await writeBodyToFile(() => Readable.from([stored]), [['content-encoding', 'gzip']], file);
    expect(result.decoded).toBe(false);
    expect(result.decodeError).toMatch(/Couldn't decode gzip/);
    expect(await readFile(file)).toEqual(stored);
  });

  it('writes the stored bytes when the decoded body would be too large', async () => {
    const file = path.join(dir, 'bomb.bin');
    const stored = gzipSync(Buffer.alloc(200_000));
    const result = await writeBodyToFile(
      () => Readable.from([stored]),
      [['content-encoding', 'gzip']],
      file,
      100_000,
    );
    expect(result.decoded).toBe(false);
    expect(result.decodeError).toMatch(/over/);
    expect(await readFile(file)).toEqual(stored);
  });

  it('writes a plain body as it is', async () => {
    const file = path.join(dir, 'c.txt');
    const result = await writeBodyToFile(() => Readable.from([Buffer.from('plain')]), [], file);
    expect(result).toEqual({ size: 5, decoded: false });
    expect(await readFile(file, 'utf8')).toBe('plain');
  });
});

describe('body file names', () => {
  it('suggests the last path segment, with an extension for the type', () => {
    expect(
      suggestedName('https://api.test/v1/users?page=2', 'application/json; charset=utf-8', 'response'),
    ).toBe('users.json');
    expect(suggestedName('https://api.test/logo.png', 'image/png', 'response')).toBe('logo.png');
    expect(suggestedName('https://api.test/', 'text/html', 'response')).toBe('api.test.html');
    expect(suggestedName('https://api.test/upload', undefined, 'request')).toBe('upload-request.bin');
    expect(suggestedName('https://api.test/a%3Cb%3E', 'application/problem+json', 'response')).toBe(
      'a_b_.json',
    );
  });

  it('cleans what the window suggests before using it as a default path', () => {
    expect(cleanName('../../etc/passwd')).toBe('passwd');
    expect(cleanName('C:\\Windows\\evil.json')).toBe('evil.json');
    expect(cleanName('a:b\u0001.json')).toBe('a_b_.json');
    expect(cleanName('...')).toBe('body');
    expect(cleanName(42)).toBe('body');
  });
});
