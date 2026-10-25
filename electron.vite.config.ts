import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * Wirescry Pro lives in a separate private repo. Set WIRESCRY_PRO_DIR to its
 * checkout to build with Pro; otherwise the free build uses the stubs in src/pro-stub.
 */
const proDir = process.env.WIRESCRY_PRO_DIR ? resolve(process.env.WIRESCRY_PRO_DIR) : undefined;
if (proDir && !existsSync(resolve(proDir, 'src/backend/index.ts'))) {
  throw new Error(`WIRESCRY_PRO_DIR is set, but ${proDir} doesn't look like a wirescry-pro checkout.`);
}
const pluginApi = resolve(__dirname, 'src/plugin-api');
const v8Flags = resolve(__dirname, 'src/backend/v8-flags.ts');
const proBackend = proDir
  ? resolve(proDir, 'src/backend/index.ts')
  : resolve(__dirname, 'src/pro-stub/backend.ts');
const proUi = proDir ? resolve(proDir, 'src/ui/index.ts') : resolve(__dirname, 'src/pro-stub/ui.ts');

/**
 * Lists the npm packages bundled into this part of the app, as .bundled-packages.json
 * next to its output, for scripts/third-party-notices.mjs (which then deletes the file).
 */
function recordBundledPackages(): Plugin {
  return {
    name: 'wirescry:record-bundled-packages',
    apply: 'build',
    generateBundle() {
      const dirs = new Set<string>();
      for (const id of this.getModuleIds()) {
        const file = id.replace(/\\/g, '/').replace(/^\0/, '').split('?')[0] ?? '';
        const match = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file);
        if (match?.[1]) dirs.add(match[1]);
      }
      this.emitFile({
        type: 'asset',
        fileName: '.bundled-packages.json',
        source: JSON.stringify([...dirs].sort(), null, 2),
      });
    },
  };
}

export default defineConfig(() => {
  return {
    main: {
      plugins: [recordBundledPackages()],
      resolve: {
        alias: {
          '@wirescry/pro/backend': proBackend,
          '@wirescry/plugin-api': pluginApi,
        },
        // Pro's files sit outside this repo; make sure they use this app's Mockttp.
        dedupe: ['mockttp'],
      },
      build: {
        rolldownOptions: {
          input: {
            index: resolve(__dirname, 'src/main/index.ts'),
            // The backend runs in its own utility process; see src/main/backend-supervisor.ts.
            backend: resolve(__dirname, 'src/backend/index.ts'),
            // Formats bodies in a worker thread of the backend; see src/backend/formatter.ts.
            'format-worker': resolve(__dirname, 'src/backend/format-worker.mts'),
          },
          // With Pro, put all of Pro's backend code in one chunk (chunks/pro-*.js), so that
          // scripts/pro-bytecode/compile.mjs can swap it for V8 bytecode before packaging.
          // electron-builder.cjs refuses to package a build where that hasn't happened.
          // v8-flags gets its own chunk too, so it still runs before Pro's code loads.
          output: proDir
            ? {
                codeSplitting: {
                  groups: [
                    { name: 'v8-flags', test: (id: string) => id === v8Flags, priority: 2 },
                    { name: 'pro', test: (id: string) => id.startsWith(proDir + sep), priority: 1 },
                  ],
                },
              }
            : undefined,
        },
      },
    },
    preload: {
      plugins: [recordBundledPackages()],
      build: {
        // Sandboxed preloads can only `require('electron')`, so bundle everything else in.
        externalizeDeps: false,
      },
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      plugins: [react(), recordBundledPackages()],
      resolve: {
        alias: {
          '@wirescry/pro/ui': proUi,
          '@wirescry/plugin-api': pluginApi,
        },
        // Pro's files sit outside this repo; make sure they use this app's React.
        dedupe: ['react', 'react-dom'],
      },
      server: proDir ? { fs: { allow: [resolve(__dirname), proDir] } } : undefined,
      build: {
        rolldownOptions: {
          input: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  };
});
