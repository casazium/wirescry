/** The About box's text, the same on every system. No Electron imports, so it's testable. */

export const WEBSITE = 'https://casazium.com/wirescry';
/** Where to report a problem: the open-source app's issues. */
export const ISSUES_URL = 'https://github.com/casazium/wirescry/issues';
// The year of first publication, as in electron-builder.cjs's copyright.
const COPYRIGHT_YEAR = 2026;

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
    'Free and open source (AGPL-3.0). Wirescry Pro is a paid add-on.',
    `Copyright © ${COPYRIGHT_YEAR} Bob Casazza, Casazium`,
    WEBSITE,
  ].join('\n');
}
