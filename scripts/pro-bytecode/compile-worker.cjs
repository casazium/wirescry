// Runs in an Electron utility process, like the backend that will load the result, so
// V8's flags and version match. Compiles one file to cached bytecode, then checks that
// a fresh load accepts it. Arguments: <source.js> <out.jsc>
'use strict';
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

// electron-main.cjs starts this process with the backend's V8 flags
// (src/shared/backend-v8-flags.json), which V8 bakes into the bytecode.

const params = ['exports', 'require', 'module', '__filename', '__dirname'];
const [source, out] = process.argv.slice(-2);

try {
  const tagBytes = randomBytes(16);
  const tag = '/*' + tagBytes.toString('hex') + '*/';
  // The tag leads the placeholder the loader builds, so it must lead here too: V8 keys
  // the cache on the source's length, and the loader rebuilds it from the header.
  const code = tag + fs.readFileSync(source, 'utf8');
  const { cachedData } = vm.compileFunction(code, params, { produceCachedData: true });
  if (!Buffer.isBuffer(cachedData) || cachedData.length === 0) throw new Error('V8 produced no bytecode');

  const header = Buffer.alloc(28);
  header.write('WSBC0001', 0, 'latin1');
  header.writeUInt32LE(code.length, 8);
  tagBytes.copy(header, 12);

  const placeholder = tag + ' '.repeat(code.length - tag.length);
  const check = vm.compileFunction(placeholder, params, { cachedData });
  if (check.cachedDataRejected) throw new Error('V8 rejected the bytecode it just made');

  fs.writeFileSync(out, Buffer.concat([header, cachedData]));
  process.parentPort.postMessage({ ok: true, arch: process.arch, bytes: header.length + cachedData.length });
} catch (error) {
  process.parentPort.postMessage({ ok: false, error: String(error && error.stack ? error.stack : error) });
}
