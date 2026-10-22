import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import { curlrcContent, phpIniContent } from '../shared/terminal-env';

export const CA_BUNDLE_FILE = 'ca-bundle.pem';

/**
 * Writes Leverframe's CA followed by Node's bundled public roots and the operating
 * system's roots. Tools told to use this file (SSL_CERT_FILE and similar) then trust
 * Leverframe without losing trust in everything else, e.g. for hosts that skip the proxy.
 */
export async function writeCABundle(dir: string, caCert: string): Promise<string> {
  let system: string[] = [];
  try {
    system = tls.getCACertificates('system');
  } catch {
    // Older Node: bundled roots only.
  }
  const certs = [caCert.trim(), ...new Set([...tls.rootCertificates, ...system].map((c) => c.trim()))];
  const file = path.join(dir, CA_BUNDLE_FILE);
  await writeFile(file, certs.join('\n') + '\n', { mode: 0o644 });
  return file;
}

export interface TerminalConfig {
  bundlePath: string;
  phpIniDir: string;
  curlHome: string;
}

/** Writes the CA bundle plus the PHP and curl config files that point at it. */
export async function writeTerminalConfig(dir: string, caCert: string): Promise<TerminalConfig> {
  const bundlePath = await writeCABundle(dir, caCert);
  const phpIniDir = path.join(dir, 'terminal-config', 'php');
  const curlHome = path.join(dir, 'terminal-config', 'curl');
  await mkdir(phpIniDir, { recursive: true });
  await mkdir(curlHome, { recursive: true });
  await writeFile(path.join(phpIniDir, 'leverframe.ini'), phpIniContent(bundlePath));
  // Windows curl reads _curlrc; newer versions also read .curlrc.
  await writeFile(path.join(curlHome, '_curlrc'), curlrcContent(bundlePath));
  await writeFile(path.join(curlHome, '.curlrc'), curlrcContent(bundlePath));
  return { bundlePath, phpIniDir, curlHome };
}
