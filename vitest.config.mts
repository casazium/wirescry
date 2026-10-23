import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against the free build.
      '@leverframe/pro/backend': resolve(import.meta.dirname, 'src/pro-stub/backend.ts'),
      '@leverframe/pro/ui': resolve(import.meta.dirname, 'src/pro-stub/ui.ts'),
      '@leverframe/plugin-api': resolve(import.meta.dirname, 'src/plugin-api'),
    },
    // test/pro-integration.test.ts loads Pro from its own checkout; it must use this app's Mockttp.
    dedupe: ['mockttp'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
