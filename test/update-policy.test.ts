import { describe, expect, it } from 'vitest';
import { updateDecision } from '../src/main/update-policy';

describe('updateDecision', () => {
  it('checks in packaged builds on macOS and Windows', () => {
    expect(updateDecision({ isPackaged: true, platform: 'darwin', env: {} })).toEqual({ check: true });
    expect(updateDecision({ isPackaged: true, platform: 'win32', env: {} })).toEqual({ check: true });
  });

  it('never checks during development', () => {
    expect(updateDecision({ isPackaged: false, platform: 'darwin', env: {} })).toMatchObject({
      check: false,
    });
  });

  it('checks on Linux only when running as an AppImage', () => {
    expect(updateDecision({ isPackaged: true, platform: 'linux', env: {} })).toEqual({
      check: false,
      reason: 'not running as an AppImage',
    });
    expect(
      updateDecision({ isPackaged: true, platform: 'linux', env: { APPIMAGE: '/opt/Wirescry.AppImage' } }),
    ).toEqual({ check: true });
  });

  it('can be turned off with WIRESCRY_DISABLE_UPDATES', () => {
    expect(
      updateDecision({ isPackaged: true, platform: 'darwin', env: { WIRESCRY_DISABLE_UPDATES: '1' } }),
    ).toMatchObject({ check: false });
  });
});
