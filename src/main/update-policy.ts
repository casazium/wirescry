/** Decides whether this copy of the app should check for updates. No Electron imports, so it's testable. */

export interface UpdateContext {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

export type UpdateDecision = { check: true } | { check: false; reason: string };

export function updateDecision({ isPackaged, platform, env }: UpdateContext): UpdateDecision {
  if (!isPackaged) return { check: false, reason: 'not a packaged build' };
  if (env.WIRESCRY_DISABLE_UPDATES) return { check: false, reason: 'WIRESCRY_DISABLE_UPDATES is set' };
  // On Linux only the AppImage can update itself; a .deb install is updated by reinstalling.
  if (platform === 'linux' && !env.APPIMAGE) return { check: false, reason: 'not running as an AppImage' };
  return { check: true };
}

/** How often to check after the first check at startup. */
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Wait after startup before the first check, so it doesn't compete with launch. */
export const FIRST_CHECK_DELAY_MS = 30 * 1000;

/** Sent by every copy in place of electron-updater's per-install ID (the nil UUID). */
export const NO_STAGING_ID = '00000000-0000-0000-0000-000000000000';
