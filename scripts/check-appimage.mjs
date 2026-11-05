/**
 * Checks each AppImage in release/<version>/ can start on a stock Linux install. Its
 * launcher (the ELF program at the start of the file, which mounts the app and runs it)
 * must be static: a legacy launcher needed libz.so on arm64 (only zlib's developer package
 * has that name) and loaded FUSE 2 at run time, which Ubuntu hasn't installed by default
 * since 22.04, so a needed-libraries list can't vouch for one. Then it runs each launcher
 * for its version, which needs nothing but the launcher itself.
 *
 * The packaged-app self-test runs the unpacked app, never this launcher, which is how those
 * got through CI.
 *
 *   node scripts/check-appimage.mjs
 */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { arch } from 'node:process';
import { join } from 'node:path';

/** The libraries an ELF program needs (DT_NEEDED), or [] if it's static. */
export function neededLibraries(buf) {
  if (buf.readUInt32BE(0) !== 0x7f454c46) throw new Error('not an ELF file');
  if (buf[4] !== 2 || buf[5] !== 1) throw new Error('not a 64-bit little-endian ELF file');
  const phoff = Number(buf.readBigUInt64LE(0x20));
  const phentsize = buf.readUInt16LE(0x36);
  const phnum = buf.readUInt16LE(0x38);
  const loads = [];
  let dynamic;
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize;
    const type = buf.readUInt32LE(at);
    const offset = Number(buf.readBigUInt64LE(at + 8));
    const vaddr = Number(buf.readBigUInt64LE(at + 16));
    const filesz = Number(buf.readBigUInt64LE(at + 32));
    if (type === 1) loads.push({ vaddr, offset, filesz });
    if (type === 2) dynamic = offset;
  }
  if (dynamic === undefined) return [];
  const fileOffset = (vaddr) => {
    const load = loads.find((l) => vaddr >= l.vaddr && vaddr < l.vaddr + l.filesz);
    if (!load) throw new Error(`address ${vaddr} isn't in the file`);
    return vaddr - load.vaddr + load.offset;
  };
  const entries = [];
  for (let at = dynamic; ; at += 16) {
    const tag = Number(buf.readBigInt64LE(at));
    if (tag === 0) break;
    entries.push({ tag, value: Number(buf.readBigUInt64LE(at + 8)) });
  }
  const strtab = entries.find((e) => e.tag === 5);
  if (!strtab) throw new Error('no string table');
  const base = fileOffset(strtab.value);
  return entries
    .filter((e) => e.tag === 1)
    .map((e) => {
      const start = base + e.value;
      return buf.toString('latin1', start, buf.indexOf(0, start));
    });
}

/** Problems with a launcher's libraries: any at all, since a static launcher is the only one known to start everywhere. */
export function launcherProblems(libraries) {
  if (libraries.length === 0) return [];
  return [`isn't static: it needs ${libraries.join(', ')}, and may load FUSE 2 at run time`];
}

/** The start of a file: an AppImage's launcher and its tables are in its first few MB. */
function head(path, bytes = 8 * 1024 * 1024) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1]?.endsWith('check-appimage.mjs')) {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const dir = join('release', version);
  const images = readdirSync(dir).filter((f) => f.endsWith('.AppImage'));
  if (images.length === 0) {
    console.error(`No AppImage in ${dir}`);
    process.exit(1);
  }
  let failed = false;
  for (const name of images) {
    const path = join(dir, name);
    const libraries = neededLibraries(head(path));
    const problems = launcherProblems(libraries);
    console.log(`${name}: launcher ${libraries.length ? `needs ${libraries.join(', ')}` : 'is static'}`);
    for (const problem of problems) console.error(`${name}: FAILED: the launcher ${problem}`);
    if (problems.length) failed = true;
    // Only this machine's CPU can run it.
    if ((arch === 'arm64') !== name.includes('-arm64')) continue;
    const run = spawnSync(path, ['--appimage-version'], { encoding: 'utf8', timeout: 30_000 });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    if (run.status === 0) {
      console.log(`${name}: launcher runs: ${output.split('\n')[0]}`);
    } else {
      console.error(
        `${name}: FAILED: the launcher didn't run (exit ${run.status}): ${output || run.error?.message}`,
      );
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}
