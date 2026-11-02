import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import backendV8Flags from './src/shared/backend-v8-flags.json' with { type: 'json' };

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against the free build.
      '@wirescry/pro/backend': resolve(import.meta.dirname, 'src/pro-stub/backend.ts'),
      '@wirescry/pro/ui': resolve(import.meta.dirname, 'src/pro-stub/ui.ts'),
      '@wirescry/plugin-api': resolve(import.meta.dirname, 'src/plugin-api'),
    },
    // test/pro-integration.test.ts loads Pro from its own checkout; it must use this app's Mockttp.
    dedupe: ['mockttp'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Tests run the backend in-process, so give it the V8 flags it gets at launch.
    execArgv: backendV8Flags,
    testTimeout: 20_000,
  },
});
