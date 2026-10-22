import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateCACertificate, generateSPKIFingerprint } from 'mockttp';

export interface CertificateAuthority {
  key: string;
  cert: string;
  certPath: string;
  /** Base64 SHA-256 of the certificate's public key, as Chrome's SPKI flags expect. */
  spkiFingerprint: string;
}

const KEY_FILE = 'ca.key';
const CERT_FILE = 'ca.pem';

/**
 * Loads this install's CA from `dir`, creating one the first time.
 * Every install gets its own CA; one is never shipped with the app.
 */
export async function loadOrCreateCA(dir: string): Promise<CertificateAuthority> {
  const keyPath = path.join(dir, KEY_FILE);
  const certPath = path.join(dir, CERT_FILE);

  let key: string;
  let cert: string;
  try {
    [key, cert] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certPath, 'utf8')]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    ({ key, cert } = await generateCACertificate({
      subject: {
        // A random suffix makes each install's CA easy to tell apart in trust stores.
        commonName: `Leverframe CA (${randomBytes(4).toString('hex')})`,
        organizationName: 'Leverframe',
      },
      bits: 2048,
    }));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(keyPath, key, { mode: 0o600 });
    await writeFile(certPath, cert, { mode: 0o644 });
  }

  return { key, cert, certPath, spkiFingerprint: await generateSPKIFingerprint(cert) };
}
