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
  it('turns Docker setup on for Windows only with experimentalWindowsDocker: true', async () => {
    expect(await load('{"experimentalWindowsDocker": true}')).toEqual({ experimentalWindowsDocker: true });
    for (const value of ['false', '"true"', '1', 'null']) {
      expect(await load(`{"experimentalWindowsDocker": ${value}}`), value).toEqual({});
    }
  });

  it('ignores a damaged file', async () => {
    expect(await load('{"experimentalWindowsDocker": tru')).toEqual({});
  });
});
