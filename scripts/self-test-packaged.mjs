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
// WIRESCRY_EXPECT_PRO=1 for a run that has only the installers, without the build's out/.
const expectPro = existsSync(join(root, 'out/main/.pro-build')) || process.env.WIRESCRY_EXPECT_PRO === '1';

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
  if (process.platform !== 'win32') return [];
  // Built as "Wirescry Setup 0.1.0.exe"; the upload renames it to Wirescry-Setup-0.1.0.exe.
  const name = (existsSync(releaseDir) ? readdirSync(releaseDir) : []).find((f) =>
    /^Wirescry[ -]Setup[ -][\d.]+\.exe$/.test(f),
  );
  if (!name) {
    console.log(`installed setup: FAILED: no Wirescry Setup .exe in ${releaseDir}`);
    return [{ name: 'installed setup', exe: undefined }];
  }
  const setup = join(releaseDir, name);
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
    // Past the app's own 10-minute limit, so a slow start is reported with its timings.
    const timer = setTimeout(() => child.kill(), 12 * 60_000);
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
      else if (result.backendStartMs > MAX_BACKEND_START_MS) {
        problem = `the backend took ${Math.round(result.backendStartMs / 1000)} s to start (the limit is ${MAX_BACKEND_START_MS / 1000} s)`;
      } else if (expectPro) {
        // Unlicensed is fine: Pro still starts, and locks its features itself.
        const pro = result.plugins?.find((p) => p.name === 'pro');
        if (!pro) problem = 'Pro did not load; see the log';
        else if (!pro.active) problem = `Pro did not start: ${pro.reason}`;
      }
      console.log(
        `${name}: ${problem ? `FAILED: ${problem}` : 'ok'} ${result ? JSON.stringify(result) : ''}`,
      );
      const logs = join(work, 'data/logs');
      const logFiles = existsSync(logs) ? readdirSync(logs) : [];
      // How long each step of the backend's start took, pass or fail: from the ready
      // message when there was one, or else from the log (which can lag behind it).
      if (result?.startup) {
        for (const [step, ms] of result.startup) console.log(`${name}: Startup: ${step} at ${ms} ms`);
      } else {
        for (const f of logFiles) {
          for (const line of readFileSync(join(logs, f), 'utf8').split('\n')) {
            if (line.includes('Startup: ')) console.log(`${name}: ${line.slice(line.indexOf('Startup: '))}`);
          }
        }
      }
      // Windows doesn't show a GUI app's output, so print the end of its log on failure.
      if (problem) {
        for (const f of logFiles) {
          console.log(`--- ${f} (last 40 lines) ---`);
          console.log(readFileSync(join(logs, f), 'utf8').split('\n').slice(-40).join('\n'));
        }
      }
      rmSync(work, { recursive: true, force: true });
      done(!problem);
    });
  });
}

const apps = [...findApps(), ...installWindowsSetup()];
if (apps.length === 0) {
  console.error(`self-test: no packaged apps in ${releaseDir}`);
  process.exit(1);
}
/**
 * The Intel Mac app on an Apple silicon runner runs under Rosetta, whose first start
 * translates everything and can take over a minute: long enough to trip the app's own
 * time limits (0.1.4 and 0.1.11 each failed this way, then passed on another try).
 * Rosetta keeps what it translated, so that app gets one more try.
 */
/** The slowest backend start that passes. The log's "Startup:" lines say where the time went. */
const MAX_BACKEND_START_MS = 120_000;

const underRosetta = (app) => process.platform === 'darwin' && process.arch === 'arm64' && app.name === 'mac';

let ok = true;
for (const app of apps) {
  let passed = await run(app);
  if (!passed && underRosetta(app)) {
    console.log(`${app.name}: trying once more, now that Rosetta has translated it`);
    passed = await run(app);
  }
  ok = passed && ok;
}
if (!ok) process.exitCode = 1;
