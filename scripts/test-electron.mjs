// Runs the backend's tests (vitest's "node" project) under Electron's own Node, as the app runs
// them. Electron's Node uses BoringSSL, not OpenSSL, and words TLS errors differently: plain Node
// missed a bug that came from that (refused certificates counted as unknown errors).
// Extra arguments go to vitest, e.g. a test file.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron');
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

const child = spawn(electron, [vitest, 'run', '--project', 'node', ...process.argv.slice(2)], {
  stdio: 'inherit',
  // ELECTRON_RUN_AS_NODE: Electron's binary acts as Node, with no window; test workers inherit it.
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WIRESCRY_EXPECT_ELECTRON: '1' },
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
