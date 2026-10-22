import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // The backend runs in its own utility process; see src/main/backend-supervisor.ts.
          backend: resolve(__dirname, 'src/backend/index.ts'),
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
    build: {
      rolldownOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
