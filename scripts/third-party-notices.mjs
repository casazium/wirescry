#!/usr/bin/env node
/**
 * Writes the license notices for third-party code that ships in the app, into
 * out/licenses (electron-builder.cjs copies that folder into the app's resources):
 *
 * - THIRD_PARTY_NOTICES.txt: every npm package in the app. That's the production
 *   dependencies (shipped as node_modules) plus the packages bundled into the built
 *   code, which the build lists in out/<part>/.bundled-packages.json.
 * - LICENSE.electron.txt and LICENSES.chromium.html: Electron's own, which
 *   electron-builder leaves out of macOS builds.
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
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');
const dest = join(out, 'licenses');

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
    .filter((n) => /^(licen[cs]e|copying|notice)([.-].*)?$/i.test(n))
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
  return name?.trim() || `the ${pkg.name} authors`;
}

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
    files.push({
      name: 'MIT license (standard text; the package has no license file)',
      text: `Copyright (c) ${authorName(pkg)}\n\n${MIT_TEXT}`,
    });
  }
  entries.push({ id, license: license ?? 'see the license text', homepage: pkg.homepage, files });
}
entries.sort((a, b) => a.id.localeCompare(b.id));

const rule = '-'.repeat(78);
let text =
  'Wirescry includes the third-party software listed below, under the licenses shown.\n' +
  'Electron and Chromium are covered by LICENSE.electron.txt and LICENSES.chromium.html\n' +
  'in the same folder as this file.\n\n' +
  entries.map((e) => `  ${e.id}  (${e.license})`).join('\n') +
  '\n';
for (const e of entries) {
  text += `\n${rule}\n${e.id}\nLicense: ${e.license}\n`;
  if (e.homepage) text += `Home page: ${e.homepage}\n`;
  for (const f of e.files) text += `\n--- ${f.name} ---\n\n${f.text}\n`;
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, 'THIRD_PARTY_NOTICES.txt'), text);
const electronDist = join(root, 'node_modules/electron/dist');
copyFileSync(join(electronDist, 'LICENSE'), join(dest, 'LICENSE.electron.txt'));
copyFileSync(join(electronDist, 'LICENSES.chromium.html'), join(dest, 'LICENSES.chromium.html'));
console.log(`Wrote notices for ${entries.length} packages to ${relative(root, dest)}`);
