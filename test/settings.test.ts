/** settings.json: only valid values are kept. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSettings } from '../src/backend/settings';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function load(raw: string): Promise<Awaited<ReturnType<typeof loadSettings>>> {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry-settings-'));
  await writeFile(path.join(dir, 'settings.json'), raw);
  return loadSettings(dir);
}

describe('settings.json', () => {
  it('ignores experimentalWindowsDocker, which Docker setup on Windows no longer needs', async () => {
    for (const value of ['true', 'false']) {
      expect(await load(`{"experimentalWindowsDocker": ${value}}`), value).toEqual({});
    }
    expect(await load('{"experimentalWindowsDocker": true, "dockerSetup": false}')).toEqual({
      dockerSetup: false,
    });
  });

  it('ignores a damaged file', async () => {
    expect(await load('{"dockerSetup": fals')).toEqual({});
  });
});
