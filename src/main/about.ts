/** The About box's text on Windows and Linux. No Electron imports, so it's testable. */

export const WEBSITE = 'https://casazium.com/wirescry';

export function aboutDetail(info: {
  version: string;
  electron: string;
  platform: string;
  arch: string;
}): string {
  const system = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[info.platform] ?? info.platform;
  return [
    `Version ${info.version}`,
    `Electron ${info.electron}, ${system} ${info.arch}`,
    '',
    'See, debug and change HTTP traffic.',
    WEBSITE,
  ].join('\n');
}
