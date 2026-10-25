#!/usr/bin/env node
/**
 * Replaces Wirescry Pro's backend chunk (out/main/chunks/pro-*.js, from a build with
 * WIRESCRY_PRO_DIR set) with V8 bytecode, so the packaged app doesn't carry Pro's source.
 *
 *   node scripts/pro-bytecode/compile.mjs --arch arm64,x64
 *
 * V8 bytecode only loads on the CPU type and Electron version that made it, so this
 * compiles once per --arch (default: this machine's) with that architecture's Electron.
 * Other architectures run under emulation: Rosetta on Apple silicon Macs makes x64, and
 * Windows on Arm makes x64. An x64 machine can't make arm64.
 *
 * Writes chunks/pro-<hash>.<arch>.jsc for each architecture and overwrites
 * chunks/pro-<hash>.js with ./loader.cjs, which picks the file for the CPU it runs on.
 * electron-builder.cjs refuses to package if this hasn't run for the target architecture.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch as hostArch, platform } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const chunks = join(root, 'out/main/chunks');
const LOADER_MARK = '/* wirescry-pro-bytecode-loader */';

function fail(message) {
  console.error(`compile-pro-bytecode: ${message}`);
  process.exit(1);
}

function parseArches() {
  const i = process.argv.indexOf('--arch');
  const list = i === -1 ? hostArch : process.argv[i + 1];
  if (!list) fail('--arch needs a value, e.g. --arch arm64,x64');
  const arches = [
    ...new Set(
      list
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    ),
  ];
  for (const a of arches) if (a !== 'x64' && a !== 'arm64') fail(`unsupported architecture "${a}"`);
  return arches;
}

/** The plain Pro chunk, checking there's exactly one and it hasn't been compiled already. */
function findChunk() {
  const names = existsSync(chunks) ? readdirSync(chunks).filter((n) => /^pro-[\w-]+\.js$/.test(n)) : [];
  if (names.length === 0) fail('no out/main/chunks/pro-*.js. Build with WIRESCRY_PRO_DIR set first.');
  if (names.length > 1) fail(`more than one Pro chunk: ${names.join(', ')}. Delete out/ and build again.`);
  const file = join(chunks, names[0]);
  if (readFileSync(file, 'utf8').startsWith(LOADER_MARK)) {
    fail(`${names[0]} is already the bytecode loader. Build again to compile for other architectures.`);
  }
  return { file, base: names[0].slice(0, -'.js'.length) };
}

/**
 * V8 can compile arrow functions lazily even with --no-lazy, and a lazily compiled
 * function needs its source, which the bytecode build doesn't have. Plain functions don't.
 */
async function withoutArrowFunctions(code) {
  const babel = require('@babel/core');
  const result = await babel.transformAsync(code, {
    babelrc: false,
    configFile: false,
    compact: false,
    comments: false,
    plugins: [require.resolve('@babel/plugin-transform-arrow-functions')],
  });
  if (!result?.code) fail('Babel returned no code');
  return result.code;
}

/** The Electron executable for an architecture, downloading it if it isn't this machine's. */
async function electronFor(targetArch) {
  if (targetArch === hostArch) return require('electron');
  const version = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')).version;
  const dir = join(root, 'node_modules/.cache/wirescry-electron', `${version}-${platform}-${targetArch}`);
  const exe =
    platform === 'darwin'
      ? join(dir, 'Electron.app/Contents/MacOS/Electron')
      : platform === 'win32'
        ? join(dir, 'electron.exe')
        : join(dir, 'electron');
  if (existsSync(exe)) return exe;
  if (platform === 'linux') fail(`can't run ${targetArch} Electron on Linux ${hostArch}`);
  if (platform === 'win32' && hostArch === 'x64' && targetArch === 'arm64') {
    fail("x64 Windows can't run arm64 Electron. Build on Windows on Arm, which can make both.");
  }
  if (platform === 'darwin' && hostArch === 'x64' && targetArch === 'arm64') {
    fail("Intel Macs can't run arm64 Electron. Build on Apple silicon, which can make both.");
  }
  console.log(`Downloading Electron ${version} for ${platform}-${targetArch}…`);
  const { downloadArtifact } = await import('@electron/get');
  const zip = await downloadArtifact({ version, platform, arch: targetArch, artifactName: 'electron' });
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // ditto keeps the app bundle's symlinks; Windows 10+ has bsdtar, which reads zips.
  if (platform === 'darwin') execFileSync('ditto', ['-x', '-k', zip, dir]);
  else {
    // Windows' own bsdtar, not a GNU tar that Git Bash may put first on the PATH.
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', zip, '-C', dir]);
  }
  if (!existsSync(exe)) fail(`the Electron download has no ${exe}`);
  return exe;
}

const arches = parseArches();
const { file, base } = findChunk();
const prepared = join(chunks, `${base}.prepared.js`);
writeFileSync(prepared, await withoutArrowFunctions(readFileSync(file, 'utf8')));

try {
  for (const a of arches) {
    const out = join(chunks, `${base}.${a}.jsc`);
    const exe = await electronFor(a);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // On Linux, Electron needs a display (in CI, run this under xvfb-run) and, on Ubuntu
    // 24.04 and later, --no-sandbox: its sandbox helper isn't set up in node_modules.
    if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
      fail('Electron needs a display on Linux. Run this under xvfb-run.');
    }
    const flags = platform === 'linux' ? ['--no-sandbox'] : [];
    const run = spawnSync(exe, [...flags, join(here, 'electron-main.cjs'), prepared, out], {
      stdio: 'inherit',
      env,
    });
    if (run.status !== 0 || !existsSync(out)) {
      rmSync(prepared, { force: true });
      fail(`compiling for ${a} failed`);
    }
  }
} finally {
  rmSync(prepared, { force: true });
}

// Last, so a failure above leaves the plain chunk to compile again.
const loader = readFileSync(join(here, 'loader.cjs'), 'utf8').replaceAll('__JSC_BASE__', base);
writeFileSync(file, loader);
console.log(`Pro backend is now bytecode for ${arches.join(', ')}: ${base}.<arch>.jsc`);
