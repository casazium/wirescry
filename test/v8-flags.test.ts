import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import backendV8Flags from '../src/shared/backend-v8-flags.json';

const root = path.resolve(import.meta.dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx|mts|cjs|mjs)$/.test(entry.name))
    .filter((entry) => !entry.parentPath.includes('node_modules'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

// Pro's checkout too, when it's here (as for a Pro build).
const proSrc = process.env.WIRESCRY_PRO_DIR ? [path.resolve(process.env.WIRESCRY_PRO_DIR, 'src')] : [];

// Up to 0.1.3 the backend set these flags once running. From then on, anything that made a new
// V8 context (a worker thread, a decompression stream) aborted the process, so opening a gzip
// or HTML body lost the whole capture. They now come at launch; see src/main/backend-supervisor.ts.
describe("the backend's V8 flags", () => {
  it('are never changed at run time', () => {
    // compile-worker.cjs runs in its own process, which electron-main.cjs starts with the flags.
    const dirs = [path.join(root, 'src'), path.join(root, 'scripts'), ...proSrc];
    const offenders = dirs
      .flatMap(files)
      .filter((file) => readFileSync(file, 'utf8').includes('setFlagsFromString'))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });

  it('are what these tests run with, as the backend does', () => {
    expect(() => new RegExp('a+', 'l')).not.toThrow();
  });

  it('given at launch, let a process start worker threads and decode gzip', () => {
    // Run in a fresh Node with the flags given the way the supervisor gives them.
    const script = `
      const { Worker } = require('node:worker_threads');
      const { gzipSync } = require('node:zlib');
      (async () => {
        const stream = new Blob([gzipSync('x'.repeat(1000))]).stream().pipeThrough(new DecompressionStream('gzip'));
        const text = await new Response(stream).text();
        const worker = new Worker('require("node:worker_threads").parentPort.postMessage(1)', { eval: true });
        await new Promise((resolve) => worker.on('message', resolve));
        await worker.terminate();
        console.log(text.length);
      })();`;
    const run = spawnSync(process.execPath, [...backendV8Flags, '-e', script], { encoding: 'utf8' });
    expect(run.signal).toBeNull();
    expect(run.stdout.trim()).toBe('1000');
  });
});
