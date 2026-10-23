import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against the free build.
      '@leverframe/pro/backend': resolve(import.meta.dirname, 'src/pro-stub/backend.ts'),
      '@leverframe/pro/ui': resolve(import.meta.dirname, 'src/pro-stub/ui.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
