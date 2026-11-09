/**
 * Which runtime the tests run on. `npm run test:electron` runs them under Electron's Node, as
 * the app runs the backend; this fails if that run quietly used plain Node instead.
 */
import { describe, expect, it } from 'vitest';

describe('The test runtime', () => {
  it.runIf(process.env.WIRESCRY_EXPECT_ELECTRON === '1')(
    'is Electron’s Node, with BoringSSL, when asked for',
    () => {
      expect(process.versions.electron).toBeDefined();
      // Electron's Node reports no OpenSSL version: it's built on BoringSSL.
      expect(process.versions.openssl).toBe('0.0.0');
    },
  );

  it.runIf(process.env.WIRESCRY_EXPECT_ELECTRON !== '1')('is plain Node, with OpenSSL, otherwise', () => {
    expect(process.versions.electron).toBeUndefined();
    expect(process.versions.openssl).not.toBe('0.0.0');
  });
});
