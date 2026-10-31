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

/**
 * What the "Couldn't check for updates" dialog says, in place of electron-updater's raw
 * error (which can name GitHub, quote Chromium error codes, or include response headers).
 * The full error is still written to the log.
 */
export function updateErrorDetail(error: { message?: string; code?: string }): string {
  const code = error.code ?? '';
  const message = error.message ?? '';
  // An empty GitHub release feed comes back as ERR_XML_MISSED_ELEMENT, with this message.
  if (
    code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' ||
    code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' ||
    message.includes('No published versions')
  ) {
    return 'No new version is available to download yet. Try again later.';
  }
  if (/net::ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(`${code} ${message}`)) {
    return "Wirescry couldn't reach the update server. Check your internet connection, and any proxy or firewall, then try again.";
  }
  return 'Something went wrong while checking. The details are in the log (Help → Show Log File).';
}
