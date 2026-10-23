import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import { pemToDer, trustStoreJks } from '../src/backend/jks';

const keytool = ['keytool', process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'keytool')]
  .filter((k): k is string => Boolean(k))
  // macOS has a /usr/bin/keytool placeholder that only reports there's no Java, so require success.
  .find((k) => spawnSync(k, ['-help'], { stdio: 'ignore' }).status === 0);

describe('trustStoreJks', () => {
  const certs = pemToDer(tls.rootCertificates.slice(0, 5).join('\n'));

  it('reads certificates out of PEM', () => {
    expect(certs).toHaveLength(5);
    expect(certs[0]![0]).toBe(0x30); // DER SEQUENCE
  });

  it('starts with the JKS header and ends with a 20-byte checksum', () => {
    const jks = trustStoreJks(certs, 'changeit', 0);
    expect(jks.readUInt32BE(0)).toBe(0xfeedfeed);
    expect(jks.readUInt32BE(4)).toBe(2);
    expect(jks.readUInt32BE(8)).toBe(5);
    const bodyLength =
      12 +
      certs.reduce(
        (n, c, i) => n + 4 + 2 + (i === 0 ? 'wirescry-ca'.length : `root-${i}`.length) + 8 + 7 + 4 + c.length,
        0,
      );
    expect(jks.length).toBe(bodyLength + 20);
  });

  it.skipIf(!keytool)('is read by keytool, with every certificate trusted', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wirescry jks test-'));
    const file = path.join(dir, 'trust.jks');
    await writeFile(file, trustStoreJks(certs, 'changeit'));
    const ok = spawnSync(
      keytool!,
      ['-list', '-keystore', file, '-storepass', 'changeit', '-storetype', 'JKS'],
      {
        encoding: 'utf8',
      },
    );
    expect(ok.status).toBe(0);
    expect(ok.stdout.match(/trustedCertEntry/g)).toHaveLength(5);
    expect(ok.stdout).toContain('wirescry-ca');

    const wrong = spawnSync(
      keytool!,
      ['-list', '-keystore', file, '-storepass', 'wrong', '-storetype', 'JKS'],
      {
        encoding: 'utf8',
      },
    );
    expect(wrong.status).not.toBe(0); // The checksum covers the password.
    await rm(dir, { recursive: true, force: true });
  });
});
