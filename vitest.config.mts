import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import backendV8Flags from './src/shared/backend-v8-flags.json' with { type: 'json' };

const alias = {
  // Tests run against the free build.
  '@wirescry/pro/backend': resolve(import.meta.dirname, 'src/pro-stub/backend.ts'),
  '@wirescry/pro/check-worker': resolve(import.meta.dirname, 'src/pro-stub/check-worker.ts'),
  '@wirescry/pro/ui': resolve(import.meta.dirname, 'src/pro-stub/ui.ts'),
  '@wirescry/plugin-api': resolve(import.meta.dirname, 'src/plugin-api'),
};

export default defineConfig({
  resolve: {
    alias,
    // test/pro-integration.test.ts loads Pro from its own checkout; it must use this app's Mockttp.
    dedupe: ['mockttp'],
  },
  test: {
    testTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          // Tests run the backend in-process, so give it the V8 flags it gets at launch.
          execArgv: backendV8Flags,
        },
      },
      {
        extends: true,
        test: {
          // The window's components and hooks, in a simulated browser.
          name: 'ui',
          include: ['test/ui/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['test/ui/setup.ts'],
        },
      },
    ],
  },
});
