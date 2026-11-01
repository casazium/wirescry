import { describe, expect, it } from 'vitest';
import {
  isInstalledDownload,
  isNothingToDownload,
  quietUpdaterError,
  updateDecision,
  updateErrorDetail,
  updaterCacheBase,
} from '../src/main/update-policy';

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

describe('isNothingToDownload', () => {
  it('treats an unpublished or empty release feed as nothing to download', () => {
    for (const error of [
      { message: 'No published versions on GitHub', code: 'ERR_XML_MISSED_ELEMENT' },
      { message: 'No published versions on GitHub', code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' },
      { message: 'Cannot find latest-mac.yml', code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' },
    ]) {
      expect(isNothingToDownload(error)).toBe(true);
    }
  });

  it('leaves real failures alone', () => {
    expect(isNothingToDownload({ message: 'net::ERR_CONNECTION_REFUSED' })).toBe(false);
    expect(isNothingToDownload({ message: 'HttpError: 404 Not Found' })).toBe(false);
  });
});

describe('updateErrorDetail', () => {
  it('explains network failures without the raw error code', () => {
    for (const error of [
      { message: 'net::ERR_CONNECTION_REFUSED' },
      { message: 'net::ERR_INTERNET_DISCONNECTED' },
      { message: 'getaddrinfo ENOTFOUND github.com', code: 'ENOTFOUND' },
    ]) {
      const detail = updateErrorDetail(error);
      expect(detail).toMatch(/couldn't reach the update server/);
      expect(detail).not.toMatch(/net::|ENOTFOUND/);
    }
  });

  it('points to the log for anything else, without the raw message', () => {
    const detail = updateErrorDetail({ message: 'HttpError: 404 Not Found\nHeaders: {"server": "x"}' });
    expect(detail).toMatch(/Show Log File/);
    expect(detail).not.toMatch(/404|Headers/);
  });
});

describe('quietUpdaterError', () => {
  it('turns an empty release feed into one info line', () => {
    const logged =
      'Error: Error: No published versions on GitHub\n    at GitHubProvider.getLatestVersion (…)';
    expect(quietUpdaterError(logged)).toBe('No release is published yet, so there is nothing to update to.');
    expect(quietUpdaterError('Error: ERR_UPDATER_LATEST_VERSION_NOT_FOUND: …')).toBeDefined();
  });

  it('leaves real errors alone', () => {
    expect(quietUpdaterError('Error: net::ERR_INTERNET_DISCONNECTED')).toBeUndefined();
    expect(quietUpdaterError('Error: sha512 checksum mismatch')).toBeUndefined();
  });
});

describe('isInstalledDownload', () => {
  it('is true for the running version or older', () => {
    expect(isInstalledDownload('Wirescry-0.1.3-arm64-mac.zip', '0.1.3')).toBe(true);
    expect(isInstalledDownload('Wirescry-0.1.2-arm64-mac.zip', '0.1.3')).toBe(true);
    expect(isInstalledDownload('Wirescry-Setup-0.1.3.exe', '0.1.3')).toBe(true);
    expect(isInstalledDownload('Wirescry-0.1.0-rc.2-mac.zip', '0.1.0')).toBe(true);
  });

  it('keeps a newer download, waiting to be installed', () => {
    expect(isInstalledDownload('Wirescry-0.1.4-arm64-mac.zip', '0.1.3')).toBe(false);
    expect(isInstalledDownload('Wirescry-0.2.0-mac.zip', '0.1.10')).toBe(false);
    expect(isInstalledDownload('Wirescry-0.1.0-mac.zip', '0.1.0-rc.2')).toBe(false);
  });

  it('leaves a file it cannot read a version from', () => {
    expect(isInstalledDownload('update.zip', '0.1.3')).toBe(false);
  });
});

describe('updaterCacheBase', () => {
  it("matches electron-updater's cache folder on each system", () => {
    expect(updaterCacheBase('darwin', {}, '/Users/me')).toBe('/Users/me/Library/Caches');
    expect(
      updaterCacheBase('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me'),
    ).toBe('C:\\Users\\me\\AppData\\Local');
    expect(updaterCacheBase('linux', {}, '/home/me')).toBe('/home/me/.cache');
  });
});
