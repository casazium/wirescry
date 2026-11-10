import { describe, expect, it } from 'vitest';
import { ABOUT_LINE_MAX, aboutDetail, WEBSITE } from '../src/main/about';

/** The text with its line breaks as spaces, as a reader takes it in. */
const asRead = (text: string): string => text.replace(/\n+/g, ' ');

describe('aboutDetail', () => {
  it('names the version, Electron and the system, and links the website', () => {
    const text = aboutDetail({ version: '0.1.2', electron: '45.0.0', platform: 'win32', arch: 'arm64' });
    expect(text.split('\n')[0]).toBe('Version 0.1.2');
    expect(text).toContain('Electron 45.0.0, Windows arm64');
    expect(text).toContain(WEBSITE);
    expect(asRead(text)).toContain('Copyright © 2026 Bob Casazza, Casazium');
    expect(asRead(text)).toContain(
      'See, debug and change HTTP traffic. Free and open source (AGPL-3.0). Wirescry Pro is a paid add-on.',
    );
  });

  it('keeps every line short enough for the macOS box, on every system', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const text = aboutDetail({ version: '0.1.21', electron: '45.0.0', platform, arch: 'arm64' });
      const long = text.split('\n').filter((line) => line.length > ABOUT_LINE_MAX);
      expect(long, platform).toEqual([]);
    }
  });

  it('keeps a name on one line: the copyright holder is never split', () => {
    const lines = aboutDetail({
      version: '0.1.21',
      electron: '45.0.0',
      platform: 'darwin',
      arch: 'arm64',
    }).split('\n');
    expect(lines).toContain('Bob Casazza, Casazium');
    expect(lines).toContain('Copyright © 2026');
    expect(lines.some((line) => line.endsWith('Bob'))).toBe(false);
  });

  it('measures against the longest line the box was seen to show whole', () => {
    // On macOS 27, "Free and open source (AGPL-3.0)." fit and "See, debug and change HTTP
    // traffic." didn't.
    expect('Free and open source (AGPL-3.0).'.length).toBeLessThanOrEqual(ABOUT_LINE_MAX);
    expect('See, debug and change HTTP traffic.'.length).toBeGreaterThan(ABOUT_LINE_MAX);
  });

  it('shows an unknown system by its own name', () => {
    const text = aboutDetail({ version: '0.1.21', electron: '45.0.0', platform: 'freebsd', arch: 'x64' });
    expect(text).toContain('Electron 45.0.0, freebsd x64');
  });
});
