import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';

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
