/* wirescry-pro-bytecode-loader */
// Loads Wirescry Pro's backend from V8 bytecode built for this CPU. Written into
// out/main/chunks by scripts/pro-bytecode/compile.mjs, in place of Pro's JavaScript;
// "__JSC_BASE__" is replaced with the chunk's name there.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

// The V8 flags the bytecode was compiled with (src/shared/backend-v8-flags.json, filled in
// by compile.mjs). The backend gets them at launch. They can't be set here: changing a V8
// flag in a running process makes it abort the next time it creates a V8 context.
const V8_FLAGS = JSON.parse('__V8_FLAGS__');

const MAGIC = 'WSBC0001';
const HEADER = 28; // magic (8), source length (4), tag (16)

function load() {
  const given = process.execArgv.filter((arg) => arg.startsWith('--js-flags=')).join(' ');
  const missing = V8_FLAGS.filter((flag) => !given.split(/[\s=]+/).includes(flag));
  if (missing.length > 0)
    throw new Error('the backend was started without the V8 flags ' + missing.join(' '));
  const filename = path.join(__dirname, '__JSC_BASE__.' + process.arch + '.jsc');
  let data;
  try {
    data = fs.readFileSync(filename);
  } catch {
    throw new Error('this build has no Pro bytecode for ' + process.arch);
  }
  if (data.length <= HEADER || data.toString('latin1', 0, 8) !== MAGIC) {
    throw new Error('the Pro bytecode file is damaged');
  }
  const length = data.readUInt32LE(8);
  const tag = '/*' + data.subarray(12, HEADER).toString('hex') + '*/';
  if (length < tag.length || length > 0x1fffffff) throw new Error('the Pro bytecode file is damaged');
  // V8 checks the source's length, not its text, so spaces stand in for the code.
  const placeholder = tag + ' '.repeat(length - tag.length);
  const params = ['exports', 'require', 'module', '__filename', '__dirname'];
  const fn = vm.compileFunction(placeholder, params, { filename, cachedData: data.subarray(HEADER) });
  if (fn.cachedDataRejected) {
    throw new Error('V8 rejected the Pro bytecode (built for a different Electron or CPU?)');
  }
  const mod = { exports: {} };
  const req = (id) => module.require(id);
  req.resolve = (request, options) => Module._resolveFilename(request, module, false, options);
  fn.call(mod.exports, mod.exports, req, mod, filename, __dirname);
  return mod.exports;
}

try {
  module.exports = load();
} catch (error) {
  // Run as the free app rather than not at all; the reason goes to Wirescry's log.
  console.error('Wirescry Pro is off: ' + (error && error.message ? error.message : error));
  module.exports = { backendPlugins: [] };
}
