#!/usr/bin/env node
/**
 * Starts each packaged app in release/<version>/ with --wirescry-self-test, which runs
 * the backend without a window and reports what loaded, and fails unless every one
 * started. For a Pro build (out/main/.pro-build), Pro must have loaded too: the loader
 * otherwise falls back to the free app quietly, which would hide broken bytecode.
 *
 *   node scripts/self-test-packaged.mjs     (on Linux: xvfb-run -a node …)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const releaseDir = join(root, 'release', version);
const expectPro = existsSync(join(root, 'out/main/.pro-build'));

/** The unpacked apps electron-builder leaves next to the installers. */
function findApps() {
  if (!existsSync(releaseDir)) return [];
  const apps = [];
  for (const name of readdirSync(releaseDir)) {
    const dir = join(releaseDir, name);
    const candidates =
      process.platform === 'darwin'
        ? [join(dir, 'Wirescry.app/Contents/MacOS/Wirescry')]
        : process.platform === 'win32'
          ? [join(dir, 'Wirescry.exe')]
          : [join(dir, 'wirescry')];
    for (const exe of candidates) if (existsSync(exe)) apps.push({ name, exe });
  }
  return apps;
}

function run({ name, exe }) {
  const work = mkdtempSync(join(tmpdir(), 'wirescry-self-test-'));
  const resultFile = join(work, 'result.json');
  const args = [`--user-data-dir=${join(work, 'data')}`, `--wirescry-self-test=${resultFile}`];
  // The unpacked Linux app's sandbox helper isn't set up (it needs root).
  if (process.platform === 'linux') args.unshift('--no-sandbox');
  const env = { ...process.env, WIRESCRY_DISABLE_UPDATES: '1' };
  return new Promise((done) => {
    const child = spawn(exe, args, { stdio: 'inherit', env });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      let result;
      try {
        result = JSON.parse(readFileSync(resultFile, 'utf8'));
      } catch {
        result = undefined;
      }
      rmSync(work, { recursive: true, force: true });
      let problem;
      if (!result) problem = `exited (code ${code}) without a result`;
      else if (result.error) problem = result.error;
      else if (expectPro && !result.plugins?.includes('pro')) problem = 'Pro did not load; see the log above';
      console.log(
        `${name}: ${problem ? `FAILED: ${problem}` : 'ok'} ${result ? JSON.stringify(result) : ''}`,
      );
      done(!problem);
    });
  });
}

const apps = findApps();
if (apps.length === 0) {
  console.error(`self-test: no packaged apps in ${releaseDir}`);
  process.exit(1);
}
let ok = true;
for (const app of apps) ok = (await run(app)) && ok;
if (!ok) process.exitCode = 1;
