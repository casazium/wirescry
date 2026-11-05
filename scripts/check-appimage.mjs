/**
 * Checks each AppImage in release/<version>/ can start on a stock Linux install: its
 * launcher (the ELF program at the start of the file, which mounts the app and runs it)
 * must be static or need only libraries every distribution has under their usual names.
 *
 * The packaged-app self-test runs the unpacked app, never this launcher, which is how an
 * arm64 AppImage that needed libz.so (a name only zlib's developer package provides) got
 * through CI.
 *
 *   node scripts/check-appimage.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const dir = join('release', version);

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

/** Problems with a launcher's libraries: an unversioned name (libz.so) needs a -dev package. */
export function launcherProblems(libraries) {
  return libraries
    .filter((lib) => !/\.so\.\d/.test(lib))
    .map((lib) => `needs ${lib}, which only a developer package provides`);
}

if (process.argv[1]?.endsWith('check-appimage.mjs')) {
  const images = readdirSync(dir).filter((f) => f.endsWith('.AppImage'));
  if (images.length === 0) {
    console.error(`No AppImage in ${dir}`);
    process.exit(1);
  }
  let failed = false;
  for (const name of images) {
    const libraries = neededLibraries(readFileSync(join(dir, name)));
    const problems = launcherProblems(libraries);
    console.log(`${name}: launcher ${libraries.length ? `needs ${libraries.join(', ')}` : 'is static'}`);
    for (const problem of problems) console.error(`${name}: FAILED: the launcher ${problem}`);
    if (problems.length) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
