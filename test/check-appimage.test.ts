import { describe, expect, it } from 'vitest';
import { launcherProblems, neededLibraries } from '../scripts/check-appimage.mjs';

describe('AppImage launcher check', () => {
  it('accepts a static launcher', () => {
    expect(launcherProblems([])).toEqual([]);
  });
  it('rejects any linked launcher: the legacy ones need libz.so or load FUSE 2', () => {
    // The legacy arm64 launcher's list, and the x64 one's (which loads libfuse.so.2 itself).
    expect(launcherProblems(['libdl.so.2', 'libpthread.so.0', 'libz.so', 'libc.so.6'])).toEqual([
      "isn't static: it needs libdl.so.2, libpthread.so.0, libz.so, libc.so.6, and may load FUSE 2 at run time",
    ]);
    expect(launcherProblems(['libdl.so.2', 'libpthread.so.0', 'libz.so.1', 'libc.so.6'])).toHaveLength(1);
  });
  it('refuses a file that is not a 64-bit ELF program', () => {
    expect(() => neededLibraries(Buffer.from('#!/bin/sh\n'.padEnd(64, ' ')))).toThrow(/not an ELF/);
  });
});
