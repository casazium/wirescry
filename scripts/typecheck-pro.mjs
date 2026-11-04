// Typechecks the app against the real Pro module instead of the stubs, so a change to
// src/plugin-api that breaks Pro shows up here. Needs WIRESCRY_PRO_DIR.
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const proDir = process.env.WIRESCRY_PRO_DIR;
if (!proDir) {
  console.error('Set WIRESCRY_PRO_DIR to a wirescry-pro checkout.');
  process.exit(1);
}
const root = path.resolve(import.meta.dirname, '..');
const pro = path.resolve(proDir);
const dir = mkdtempSync(path.join(tmpdir(), 'wirescry-typecheck-pro-'));
let failed = false;
try {
  for (const [name, extra] of [
    [
      'tsconfig.node.json',
      {
        '@wirescry/pro/backend': [path.join(pro, 'src/backend/index.ts')],
        '@wirescry/pro/check-worker': [path.join(pro, 'src/backend/openapi/check-worker.ts')],
      },
    ],
    ['tsconfig.web.json', { '@wirescry/pro/ui': [path.join(pro, 'src/ui/index.ts')] }],
  ]) {
    const config = path.join(dir, name);
    const original = JSON.parse(readFileSync(path.join(root, name), 'utf8'));
    writeFileSync(
      config,
      JSON.stringify({
        extends: path.join(root, name),
        compilerOptions: {
          paths: { ...extra, '@wirescry/plugin-api/*': [path.join(root, 'src/plugin-api/*')] },
          // Pro's own files need the app's types for mockttp and React.
          typeRoots: [path.join(root, 'node_modules/@types')],
        },
        // The app's own files, as in the original config; Pro's come in through the paths above.
        include: original.include.map((p) => path.join(root, p)),
        ...(original.exclude ? { exclude: original.exclude.map((p) => path.join(root, p)) } : {}),
      }),
    );
    const result = spawnSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', config, '--noEmit'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) failed = true;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
