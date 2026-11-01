#!/usr/bin/env node
/**
 * Starts each packaged app in release/<version>/ with --wirescry-self-test, which runs
 * the backend without a window and reports what loaded, and fails unless every one
 * started. For a Pro build (out/main/.pro-build), Pro must have loaded and started too: the loader
 * otherwise falls back to the free app quietly, which would hide broken bytecode.
 *
 * On Windows it also installs the setup .exe silently and starts the installed app. The
 * unpacked app can be fine while the installer isn't: 0.1.0's first build installed no
 * .exe or .dll files on ARM PCs, because its unpacker can't read the ARM64 compression
 * filter (see ELECTRON_BUILDER_7Z_FILTER in release.yml).
 *
 *   node scripts/self-test-packaged.mjs     (on Linux: xvfb-run -a node …)
 */
import { spawn, spawnSync } from 'node:child_process';
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

/** Installs the Windows setup silently into a temporary folder and returns the installed app. */
function installWindowsSetup() {
  const setup = join(releaseDir, `Wirescry-Setup-${version}.exe`);
  if (process.platform !== 'win32' || !existsSync(setup)) return [];
  const dir = mkdtempSync(join(tmpdir(), 'wirescry-installed-'));
  // NSIS wants /D last and unquoted.
  const result = spawnSync(setup, ['/S', '/currentuser', `/D=${dir}`], { stdio: 'inherit' });
  const exe = join(dir, 'Wirescry.exe');
  if (result.status !== 0 || !existsSync(exe)) {
    const files = existsSync(dir) ? readdirSync(dir).join(', ') : 'nothing';
    console.log(`installed setup: FAILED: exit ${result.status}, no Wirescry.exe (installed: ${files})`);
    return [{ name: 'installed setup', exe: undefined }];
  }
  return [{ name: `installed setup (${process.arch})`, exe }];
}

function run({ name, exe }) {
  if (!exe) return Promise.resolve(false);
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
      let problem;
      if (!result) problem = `exited (code ${code}) without a result`;
      else if (result.error) problem = result.error;
      else if (expectPro) {
        // Unlicensed is fine: Pro still starts, and locks its features itself.
        const pro = result.plugins?.find((p) => p.name === 'pro');
        if (!pro) problem = 'Pro did not load; see the log';
        else if (!pro.active) problem = `Pro did not start: ${pro.reason}`;
      }
      console.log(
        `${name}: ${problem ? `FAILED: ${problem}` : 'ok'} ${result ? JSON.stringify(result) : ''}`,
      );
      // Windows doesn't show a GUI app's output, so print the end of its log on failure.
      if (problem) {
        const logs = join(work, 'data/logs');
        for (const f of existsSync(logs) ? readdirSync(logs) : []) {
          console.log(`--- ${f} (last 40 lines) ---`);
          console.log(readFileSync(join(logs, f), 'utf8').split('\n').slice(-40).join('\n'));
        }
      }
      rmSync(work, { recursive: true, force: true });
      done(!problem);
    });
  });
}

const apps = findApps();
if (apps.length === 0) {
  console.error(`self-test: no packaged apps in ${releaseDir}`);
  process.exit(1);
}
apps.push(...installWindowsSetup());
let ok = true;
for (const app of apps) ok = (await run(app)) && ok;
if (!ok) process.exitCode = 1;
