#!/usr/bin/env node
/**
 * Runs the end-to-end smoke test (e2e/smoke.test.ts) against the packaged app built for
 * this computer's CPU in release/<version>/, e.g. mac-arm64 on Apple silicon. The test
 * drives the app the way a person would; the self-test only checks it starts.
 *
 *   node scripts/smoke-packaged.mjs     (on Linux: xvfb-run -a node …)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const releaseDir = join(root, 'release', version);

/** electron-builder's folder names: arm64 builds say so; x64 ones have no suffix. */
const forThisCpu = (name) => (process.arch === 'arm64' ? name.includes('arm64') : !name.includes('arm64'));
const exeIn = (dir) =>
  process.platform === 'darwin'
    ? join(dir, 'Wirescry.app/Contents/MacOS/Wirescry')
    : process.platform === 'win32'
      ? join(dir, 'Wirescry.exe')
      : join(dir, 'wirescry');

const app = (existsSync(releaseDir) ? readdirSync(releaseDir) : [])
  .filter(forThisCpu)
  .map((name) => exeIn(join(releaseDir, name)))
  .find((exe) => existsSync(exe));
if (!app) {
  console.error(`No packaged app for ${process.platform}-${process.arch} in ${releaseDir}`);
  process.exit(1);
}
console.log(`Smoke testing ${app}`);
const result = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.smoke.config.mts'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, WIRESCRY_SMOKE_APP: app },
});
process.exit(result.status ?? 1);
