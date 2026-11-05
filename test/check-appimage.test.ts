import { describe, expect, it } from 'vitest';
import { launcherProblems, neededLibraries } from '../scripts/check-appimage.mjs';

describe('AppImage launcher check', () => {
  it('accepts versioned system libraries, and a static launcher', () => {
    expect(
      launcherProblems(['libdl.so.2', 'libz.so.1', 'libfuse.so.2', 'libc.so.6', 'ld-linux-aarch64.so.1']),
    ).toEqual([]);
    expect(launcherProblems([])).toEqual([]);
  });
  it('rejects a library only a developer package provides', () => {
    // The legacy arm64 launcher's list.
    expect(launcherProblems(['libdl.so.2', 'libpthread.so.0', 'libz.so', 'libc.so.6'])).toEqual([
      'needs libz.so, which only a developer package provides',
    ]);
  });
  it('refuses a file that is not a 64-bit ELF program', () => {
    expect(() => neededLibraries(Buffer.from('#!/bin/sh\n'.padEnd(64, ' ')))).toThrow(/not an ELF/);
  });
});
