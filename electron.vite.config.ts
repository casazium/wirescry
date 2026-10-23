import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

/**
 * Wirescry Pro lives in a separate private repo. Set WIRESCRY_PRO_DIR to its
 * checkout to build with Pro; otherwise the free build uses the stubs in src/pro-stub.
 */
const proDir = process.env.WIRESCRY_PRO_DIR ? resolve(process.env.WIRESCRY_PRO_DIR) : undefined;
if (proDir && !existsSync(resolve(proDir, 'src/backend/index.ts'))) {
  throw new Error(`WIRESCRY_PRO_DIR is set, but ${proDir} doesn't look like a wirescry-pro checkout.`);
}
const pluginApi = resolve(__dirname, 'src/plugin-api');
const proBackend = proDir
  ? resolve(proDir, 'src/backend/index.ts')
  : resolve(__dirname, 'src/pro-stub/backend.ts');
const proUi = proDir ? resolve(proDir, 'src/ui/index.ts') : resolve(__dirname, 'src/pro-stub/ui.ts');

export default defineConfig(({ command }) => {
  // Pro isn't ready to ship (no licence checks or bytecode yet), and a production build
  // would bundle its source in readable form. Refuse unless explicitly asked.
  if (proDir && command === 'build' && process.env.WIRESCRY_ALLOW_PRO_BUILD !== '1') {
    throw new Error(
      'WIRESCRY_PRO_DIR is set for a production build, which would put readable Pro code in out/. ' +
        'Unset it, or set WIRESCRY_ALLOW_PRO_BUILD=1 for a local test build that must not be shipped.',
    );
  }
  return {
    main: {
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
        },
      },
    },
    preload: {
      build: {
        // Sandboxed preloads can only `require('electron')`, so bundle everything else in.
        externalizeDeps: false,
      },
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      plugins: [react()],
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
