/**
 * Wirescry's certificate on Android devices: copying it to the device for the user to install
 * (Android 11+ installs CA certificates only from Settings), opening the steps, checking in
 * Chrome that it's trusted, and remembering which devices trust which certificate.
 *
 * Measured on the API 37 emulator (android-design.md, "Measured for PR 5"): a file written to
 * /storage/emulated/<user>/Download shows in the certificate picker's Downloads without a media
 * scan; Settings shows the certificate's SHA-256 in colon hex; Chrome sends the setup page's
 * HTTPS check as soon as the certificate is installed, without a restart.
 */
import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ShellResult } from './adb-client';
import { cleanText } from './text';

export const CERTIFICATE_FILE = 'Wirescry-CA.crt';
/** Wirescry's setup page, answered by the device's own listener (the proxy). */
export const SETUP_PAGE = 'http://wirescry.internal/';
const CHROME = 'com.android.chrome';
const MAX_TRUSTED = 500;

export interface CertificateIo {
  shell(serial: string, command: string, input?: Buffer): Promise<ShellResult>;
}

export class CertificateError extends Error {}

/** A certificate's SHA-256 as Android's Settings shows it: colon-separated upper-case hex. */
export function certificateSha256(pem: string): string {
  return new X509Certificate(pem).fingerprint256;
}

/** Only a lone PEM certificate goes to a device: never a key, never anything else. */
const PEM = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/;
const DEVICE_ID = /^[0-9a-f]{32}$/;
/** Base64 SHA-256 (ca.ts, generateSPKIFingerprint). */
const SPKI = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Whether `am start` opened something. Measured: when nothing can open the intent it prints
 * "Error: Activity not started …" to stderr, and exits 1 on API 37 but 0 on API 28.
 */
const opened = (result: ShellResult): boolean =>
  result.exitCode === 0 && !/^Error:/m.test(result.stderr) && !/^Error:/m.test(result.stdout);

const sameText = (a: string, b: string): boolean =>
  a.replace(/\r/g, '').trim() === b.replace(/\r/g, '').trim();

export class DeviceCertificates {
  /** Device id → SPKI fingerprint of the certificate Chrome on it was last seen to trust. */
  private trust = new Map<string, string>();
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly options: { io: CertificateIo; trustFile: string }) {}

  /** The file in the current user's Downloads (user certificates are per user and profile). */
  private async filePath(serial: string): Promise<string> {
    const result = await this.options.io.shell(serial, 'am get-current-user');
    const user = result.stdout.trim();
    // Older Android may lack the command: the owner is user 0.
    return `/storage/emulated/${result.exitCode === 0 && /^\d{1,6}$/.test(user) ? user : '0'}/Download/${CERTIFICATE_FILE}`;
  }

  /**
   * Copies the certificate to the device's Downloads, checks it arrived intact, and opens Security
   * settings there. Returns whether Settings opened.
   */
  async send(serial: string, pem: string): Promise<{ settingsOpened: boolean }> {
    if (!PEM.test(pem)) throw new CertificateError('That isn’t a certificate Wirescry would send.');
    const { io } = this.options;
    const file = await this.filePath(serial);
    // tee writes its input to the file without any shell syntax (adb-client allows none).
    const wrote = await io.shell(serial, `tee ${file}`, Buffer.from(pem));
    if (wrote.exitCode !== 0) {
      throw new CertificateError(
        `Couldn’t copy the certificate to the device: ${cleanText(wrote.stderr, 200) ?? `exit code ${wrote.exitCode}`}`,
      );
    }
    const back = await io.shell(serial, `cat ${file}`);
    if (back.exitCode !== 0 || !sameText(back.stdout, pem)) {
      throw new CertificateError('The certificate didn’t arrive on the device intact. Try again.');
    }
    const settings = await io.shell(serial, 'am start -a android.settings.SECURITY_SETTINGS');
    return { settingsOpened: opened(settings) };
  }

  /** Removes the copied certificate, if it's still one of these (certificates Wirescry copied). */
  async remove(serial: string, pems: string[]): Promise<void> {
    const { io } = this.options;
    const file = await this.filePath(serial);
    const now = await io.shell(serial, `cat ${file}`);
    if (now.exitCode !== 0 || !pems.some((pem) => sameText(now.stdout, pem))) return;
    await io.shell(serial, `rm -f ${file}`);
  }

  /** Opens Wirescry's setup page in Chrome on the device, or in its default browser without Chrome. */
  async openCheck(serial: string): Promise<{ browser: 'chrome' | 'default' }> {
    const { io } = this.options;
    const view = `am start -a android.intent.action.VIEW -d ${SETUP_PAGE}`;
    if (opened(await io.shell(serial, `${view} -p ${CHROME}`))) return { browser: 'chrome' };
    if (opened(await io.shell(serial, view))) return { browser: 'default' };
    throw new CertificateError(`No browser on the device opened ${SETUP_PAGE}. Open it in a browser there.`);
  }

  /** Opens the list of certificates the user installed, to check or remove Wirescry's. */
  async openInstalled(serial: string): Promise<void> {
    const result = await this.options.io.shell(
      serial,
      'am start -a com.android.settings.TRUSTED_CREDENTIALS_USER',
    );
    if (!opened(result)) {
      throw new CertificateError(
        'Couldn’t open the list on the device. In Settings, search for “Trusted credentials” or “User credentials”.',
      );
    }
  }

  /** Whether a browser on this device was seen to trust the certificate with this SPKI fingerprint. */
  trusted(id: string, spki: string): boolean {
    return this.trust.get(id) === spki;
  }

  /** Reads what's remembered. A missing or unreadable file means nothing is. */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.trustFile, 'utf8')) as unknown;
      const devices = (parsed as { version?: unknown; devices?: unknown }).devices;
      if ((parsed as { version?: unknown }).version !== 1 || !devices || typeof devices !== 'object') return;
      for (const [id, spki] of Object.entries(devices as Record<string, unknown>).slice(0, MAX_TRUSTED)) {
        if (DEVICE_ID.test(id) && typeof spki === 'string' && SPKI.test(spki)) this.trust.set(id, spki);
      }
    } catch {
      // Nothing remembered yet.
    }
  }

  /** Forgets that this device trusts this certificate (its check failed). Returns whether that's news. */
  async forget(id: string, spki: string): Promise<boolean> {
    if (this.trust.get(id) !== spki) return false;
    this.trust.delete(id);
    await this.save();
    return true;
  }

  /** Remembers that this device trusts this certificate. Returns whether that's news. */
  async markTrusted(id: string, spki: string): Promise<boolean> {
    if (!DEVICE_ID.test(id) || !SPKI.test(spki) || this.trust.get(id) === spki) return false;
    this.trust.delete(id);
    this.trust.set(id, spki);
    // The oldest go first once there are too many.
    while (this.trust.size > MAX_TRUSTED) this.trust.delete(this.trust.keys().next().value!);
    await this.save();
    return true;
  }

  private save(): Promise<void> {
    const next = this.saving.then(async () => {
      const file = this.options.trustFile;
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ version: 1, devices: Object.fromEntries(this.trust) }), {
        mode: 0o600,
      });
      await rename(temp, file);
    });
    this.saving = next.catch(() => undefined);
    return next;
  }
}
