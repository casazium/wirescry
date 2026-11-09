/** settings.json's Android settings: only valid values are kept. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSettings, saveSettings } from '../src/backend/settings';

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

describe('settings.json for Android', () => {
  it('keeps androidSetup only when false, and drops the old experimental setting', async () => {
    expect(await load('{"androidSetup": false}')).toEqual({ androidSetup: false });
    for (const raw of [
      '{"androidSetup": true}',
      '{"androidSetup": "false"}',
      '{"experimentalAndroid": true}',
    ]) {
      expect(await load(raw), raw).toEqual({});
    }
  });

  it('keeps an absolute adbPath only', async () => {
    expect(await load('{"adbPath": "/sdk/platform-tools/adb"}')).toEqual({
      adbPath: '/sdk/platform-tools/adb',
    });
    for (const raw of ['{"adbPath": "adb"}', '{"adbPath": 5}', `{"adbPath": "/${'a'.repeat(1000)}"}`]) {
      expect(await load(raw), raw.slice(0, 40)).toEqual({});
    }
  });

  it('keeps androidSetup when other settings are saved', async () => {
    const settings = await load('{"androidSetup": false}');
    await saveSettings(dir!, { ...settings, dockerSetup: false });
    expect(await loadSettings(dir!)).toEqual({ androidSetup: false, dockerSetup: false });
  });
});
