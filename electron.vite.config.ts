import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

/**
 * Leverframe Pro lives in a separate private repo. Set LEVERFRAME_PRO_DIR to its
 * checkout to build with Pro; otherwise the free build uses the stubs in src/pro-stub.
 */
const proDir = process.env.LEVERFRAME_PRO_DIR ? resolve(process.env.LEVERFRAME_PRO_DIR) : undefined;
if (proDir && !existsSync(resolve(proDir, 'src/backend/index.ts'))) {
  throw new Error(`LEVERFRAME_PRO_DIR is set, but ${proDir} doesn't look like a leverframe-pro checkout.`);
}
const pluginApi = resolve(__dirname, 'src/plugin-api');
const proBackend = proDir
  ? resolve(proDir, 'src/backend/index.ts')
  : resolve(__dirname, 'src/pro-stub/backend.ts');
const proUi = proDir ? resolve(proDir, 'src/ui/index.ts') : resolve(__dirname, 'src/pro-stub/ui.ts');

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@leverframe/pro/backend': proBackend,
        '@leverframe/plugin-api': pluginApi,
      },
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
        '@leverframe/pro/ui': proUi,
        '@leverframe/plugin-api': pluginApi,
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
});
