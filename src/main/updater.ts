import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { FileLogger } from './logger';
import {
  FIRST_CHECK_DELAY_MS,
  NO_STAGING_ID,
  UPDATE_INTERVAL_MS,
  isInstalledDownload,
  isNothingToDownload,
  quietUpdaterError,
  updateDecision,
  updateErrorDetail,
  updaterCacheBase,
} from './update-policy';

/**
 * Checks the public releases repo for new versions, downloads them in the
 * background, and offers to restart once one is ready. Update files come from
 * casazium/wirescry-releases over HTTPS; on macOS and Windows the installer
 * is checked against the app's own code signature before it's used.
 */
export class Updater {
  readonly enabled: boolean;
  private readonly reason: string | undefined;
  private manualCheck = false;
  private prompting = false;
  /** Set just before quitting to install an update, which must not be delayed. */
  installing = false;

  constructor(
    private readonly logger: FileLogger,
    private readonly getWindow: () => BrowserWindow | undefined,
    /** Runs (briefly: it must not hold up the install) just before quitting to install. */
    private readonly beforeInstall: () => Promise<void> = async () => undefined,
  ) {
    const decision = updateDecision({
      isPackaged: app.isPackaged,
      platform: process.platform,
      env: process.env,
    });
    this.enabled = decision.check;
    this.reason = decision.check ? undefined : decision.reason;

    autoUpdater.logger = {
      info: (message?: unknown) => logger.write('updater', 'info', String(message)),
      warn: (message?: unknown) => logger.write('updater', 'warn', String(message)),
      error: (message?: unknown) => {
        const quiet = quietUpdaterError(String(message));
        logger.write('updater', quiet ? 'info' : 'error', quiet ?? String(message));
      },
      debug: () => undefined,
    };
    // electron-updater sends a random ID, kept for the life of the install, with every
    // request (x-user-staging-id), for staged rollouts. Wirescry doesn't stage rollouts,
    // so every copy sends the same value and every copy is in every rollout.
    autoUpdater.requestHeaders = { 'x-user-staging-id': NO_STAGING_ID };
    autoUpdater.isUserWithinRollout = () => true;
    // Nor make the ID at all: it would be saved in the data folder and written to the log.
    // stagingUserIdPromise is protected, and only its `value` is read.
    (autoUpdater as unknown as { stagingUserIdPromise: { value: Promise<string> } }).stagingUserIdPromise = {
      value: Promise.resolve(NO_STAGING_ID),
    };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-not-available', () => {
      if (this.manualCheck)
        void this.message('info', 'Wirescry is up to date.', `You have version ${app.getVersion()}.`);
      this.manualCheck = false;
    });
    autoUpdater.on('update-available', (info) => {
      if (this.manualCheck) {
        void this.message(
          'info',
          `Wirescry ${info.version} is available.`,
          'It is downloading now. You will be asked to restart when it is ready.',
        );
      }
      this.manualCheck = false;
    });
    autoUpdater.on('error', (error) => {
      this.installing = false;
      // Background checks fail quietly (offline, GitHub unavailable); errors go to the log.
      // A manual check shows a plain explanation; electron-updater has already logged the error.
      const failure = error as Error & { code?: string };
      if (this.manualCheck && isNothingToDownload(failure))
        void this.message('info', 'Wirescry is up to date.', `You have version ${app.getVersion()}.`);
      else if (this.manualCheck)
        void this.message('error', "Couldn't check for updates.", updateErrorDetail(failure));
      this.manualCheck = false;
    });
    autoUpdater.on('update-downloaded', (info) => void this.offerRestart(info.version));
  }

  /** Checks shortly after startup, then every few hours. */
  start(): void {
    if (!this.enabled) {
      this.logger.write('updater', 'info', `Update checks off: ${this.reason}`);
      return;
    }
    void this.pruneInstalledDownload();
    setTimeout(() => this.check(), FIRST_CHECK_DELAY_MS).unref();
    setInterval(() => this.check(), UPDATE_INTERVAL_MS).unref();
  }

  /**
   * Deletes the cache's pending download once its version is installed. The cache's other
   * copy (update.zip on macOS) stays: the next differential download needs it.
   */
  private async pruneInstalledDownload(): Promise<void> {
    // electron-builder writes this name into app-update.yml; it's "wirescry-updater".
    const pending = path.join(
      updaterCacheBase(process.platform, process.env, homedir()),
      'wirescry-updater',
      'pending',
    );
    try {
      const info = JSON.parse(await readFile(path.join(pending, 'update-info.json'), 'utf8')) as {
        fileName?: unknown;
      };
      if (typeof info.fileName !== 'string' || !isInstalledDownload(info.fileName, app.getVersion())) return;
      await rm(pending, { recursive: true, force: true });
      this.logger.write('updater', 'info', `Removed the installed update's download (${info.fileName})`);
    } catch {
      // No pending download, or one electron-updater will replace on its next download.
    }
  }

  /** For the "Check for Updates…" menu item: reports the result either way. */
  checkNow(): void {
    if (!this.enabled) {
      void this.message('info', "This copy of Wirescry doesn't update itself.", `Reason: ${this.reason}.`);
      return;
    }
    this.manualCheck = true;
    this.check();
  }

  private check(): void {
    autoUpdater.checkForUpdates().catch(() => undefined); // Reported through the 'error' event.
  }

  private async offerRestart(version: string): Promise<void> {
    if (this.prompting) return;
    this.prompting = true;
    try {
      const result = await this.message(
        'info',
        `Wirescry ${version} is ready to install.`,
        'Restart now to update, or it will install the next time you quit.',
        ['Restart Now', 'Later'],
      );
      if (result === 0) {
        this.installing = true;
        // If the install doesn't go ahead (it can fail without quitting), later quits clean up again.
        setTimeout(() => (this.installing = false), 15_000).unref();
        await this.beforeInstall().catch(() => undefined);
        autoUpdater.quitAndInstall();
      }
    } finally {
      this.prompting = false;
    }
  }

  private async message(
    type: 'info' | 'error',
    message: string,
    detail: string,
    buttons = ['OK'],
  ): Promise<number> {
    const options = { type, message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 };
    const window = this.getWindow();
    const { response } = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    return response;
  }
}
