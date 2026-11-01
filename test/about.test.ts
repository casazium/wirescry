import { describe, expect, it } from 'vitest';
import { aboutDetail, WEBSITE } from '../src/main/about';

describe('aboutDetail', () => {
  it('names the version, Electron and the system, and links the website', () => {
    const text = aboutDetail({ version: '0.1.2', electron: '45.0.0', platform: 'win32', arch: 'arm64' });
    expect(text.split('\n')[0]).toBe('Version 0.1.2');
    expect(text).toContain('Electron 45.0.0, Windows arm64');
    expect(text).toContain(WEBSITE);
  });
});
