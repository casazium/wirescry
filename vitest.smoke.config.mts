import { defineConfig } from 'vitest/config';

// The end-to-end smoke test: drives the built (or packaged) app. Run with npm run smoke.
export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
