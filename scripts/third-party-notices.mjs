#!/usr/bin/env node
/**
 * Writes the license notices for third-party code that ships in the app, into
 * out/licenses (electron-builder.cjs copies that folder into the app's resources):
 *
 * - THIRD_PARTY_NOTICES.txt: every npm package in the app. That's the production
 *   dependencies (shipped as node_modules) plus the packages bundled into the built
 *   code, which the build lists in out/<part>/.bundled-packages.json.
 *   Also the Go modules in Windows' Docker pipe helper (native/docker-pipe), from
 *   native/docker-pipe/licenses, which must match the helper's go.mod.
 * - out/licenses-electron: Electron's LICENSE (as LICENSE.electron.txt) and
 *   LICENSES.chromium.html, for macOS builds, which electron-builder leaves them out
 *   of. Windows and Linux builds already carry them.
 *
 * Run after `electron-vite build`. Fails if a package has no license we can name.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');
const dest = join(out, 'licenses');
const electronDest = join(out, 'licenses-electron');

function fail(message) {
  console.error(`third-party-notices: ${message}`);
  process.exit(1);
}

if (!existsSync(join(out, 'main'))) fail('no out/main. Run electron-vite build first.');

// Not shipped: see `files` in electron-builder.cjs.
const NOT_SHIPPED = new Set(['tls-impersonate']);

/** Package folders to cover, by absolute path. */
const dirs = new Set();

const prod = JSON.parse(
  execFileSync('npm', ['query', '.prod'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  }),
);
for (const pkg of prod) {
  if (!pkg.location || NOT_SHIPPED.has(pkg.name)) continue; // '' is this app
  dirs.add(resolve(root, pkg.location));
}

for (const part of ['main', 'preload', 'renderer']) {
  const file = join(out, part, '.bundled-packages.json');
  if (!existsSync(file)) fail(`no ${relative(root, file)}. Run electron-vite build first.`);
  for (const dir of JSON.parse(readFileSync(file, 'utf8'))) {
    // Pro's own files aren't third-party; anything else outside node_modules is a mistake.
    if (!dir.includes('/node_modules/') && !dir.includes('\\node_modules\\'))
      fail(`unexpected bundled path ${dir}`);
    dirs.add(resolve(dir));
  }
  rmSync(file);
}

/** The license name from package.json, in its old or new forms. */
function licenseName(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === 'string') return l;
  if (Array.isArray(l))
    return l
      .map((x) => (typeof x === 'string' ? x : x?.type))
      .filter(Boolean)
      .join(' OR ');
  if (l && typeof l === 'object' && typeof l.type === 'string') return l.type;
  return undefined;
}

/** LICENSE, LICENCE, COPYING and NOTICE files at the package's top level. */
function licenseFiles(dir) {
  return readdirSync(dir)
    .filter((n) => /licen[cs]e|copying|notice|copyright/i.test(n) && !/\.(c?js|mjs|ts|json|map)$/i.test(n))
    .sort()
    .map((n) => ({ name: n, text: readFileSync(join(dir, n), 'utf8').trim() }));
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function authorName(pkg) {
  const a = pkg.author;
  const name = typeof a === 'string' ? a.replace(/\s*[<(].*$/, '') : a?.name;
  return name?.trim() || undefined;
}

/** Notices for code a package carries that its own license files don't cover. */
const EXTRA_NOTICES = {
  // Ships Zstandard compiled to WebAssembly and asm.js.
  'zstd-codec': {
    name: 'Zstandard (built into zstd-codec), BSD License',
    text: `BSD License

For Zstandard software

Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

 * Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

 * Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

 * Neither the name Facebook, nor Meta, nor the names of its contributors may
   be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  },
};

const entries = [];
const seen = new Set();
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const id = `${pkg.name}@${pkg.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const license = licenseName(pkg);
  const files = licenseFiles(dir);
  if (files.length === 0) {
    // A few MIT packages leave the license file out of what they publish; the notice
    // still has to ship, so use the standard text with the author from package.json.
    if (license !== 'MIT') fail(`${id} (${license ?? 'no license named'}) has no license file`);
    const author = authorName(pkg);
    files.push({
      name: 'MIT license (standard text; the package has no license file)',
      text: `${author ? `Copyright (c) ${author}` : 'Copyright holders not stated in the package.'}\n\n${MIT_TEXT}`,
    });
  }
  const extra = EXTRA_NOTICES[pkg.name];
  if (extra) files.push(extra);
  entries.push({ id, license: license ?? 'see the license text', homepage: pkg.homepage, files });
}
entries.sort((a, b) => a.id.localeCompare(b.id));

// The Docker pipe helper (Windows) is Go: its modules and Go itself are built into it.
const pipeDir = join(root, 'native/docker-pipe');
const goNotices = JSON.parse(readFileSync(join(pipeDir, 'licenses/index.json'), 'utf8'));
const goMod = readFileSync(join(pipeDir, 'go.mod'), 'utf8');
const toolchain = /^toolchain go(\S+)$/m.exec(goMod)?.[1];
// Every module built in, direct or indirect, in a require block or on a line of its own.
const required = [...goMod.matchAll(/^(?:require\s+|\s+)([^\s()]+) (v\S+)(?:\s+\/\/.*)?$/gm)].map(
  ([, mod, version]) => `${mod}@${version}`,
);
if (required.length === 0)
  fail('native/docker-pipe/go.mod requires nothing: the notices check is out of date');
const listed = new Set(goNotices.map((n) => n.id));
for (const id of [...required, `Go standard library and runtime (go${toolchain})`]) {
  if (!listed.has(id)) fail(`native/docker-pipe/licenses/index.json has no notice for ${id} (from go.mod)`);
}
for (const notice of goNotices) {
  entries.push({
    id: `${notice.id} (in wirescry-docker-pipe.exe, Windows)`,
    license: notice.license,
    homepage: notice.homepage,
    files: [{ name: 'LICENSE', text: readFileSync(join(pipeDir, 'licenses', notice.file), 'utf8') }],
  });
}

const rule = '-'.repeat(78);
let text =
  'Wirescry includes the third-party software listed below, under the licenses shown.\n' +
  "Electron's and Chromium's licenses are in LICENSE.electron.txt and LICENSES.chromium.html:\n" +
  "on macOS in the same folder as this file, on Windows and Linux in the app's install folder.\n\n" +
  entries.map((e) => `  ${e.id}  (${e.license})`).join('\n') +
  '\n';
for (const e of entries) {
  text += `\n${rule}\n${e.id}\nLicense: ${e.license}\n`;
  if (e.homepage) text += `Home page: ${e.homepage}\n`;
  for (const f of e.files) text += `\n--- ${f.name} ---\n\n${f.text}\n`;
}

for (const dir of [dest, electronDest]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(dest, 'THIRD_PARTY_NOTICES.txt'), text);
// Electron downloads its binary (and these files with it) the first time its path is
// asked for, not when it's installed, so a fresh `npm ci` may not have them yet.
createRequire(join(root, 'package.json'))('electron');
const electronDist = join(root, 'node_modules/electron/dist');
copyFileSync(join(electronDist, 'LICENSE'), join(electronDest, 'LICENSE.electron.txt'));
copyFileSync(join(electronDist, 'LICENSES.chromium.html'), join(electronDest, 'LICENSES.chromium.html'));
console.log(`Wrote notices for ${entries.length} packages to ${relative(root, dest)}`);
