import { createHash } from 'node:crypto';

/**
 * Builds a Java KeyStore (JKS) holding only trusted certificates, for Java's
 * javax.net.ssl.trustStore. JKS is a simple, stable format that every Java from 8
 * to 25 reads, so there's no need to run keytool.
 *
 * Layout (big-endian): magic 0xFEEDFEED, version 2, entry count, then for each
 * trusted certificate: tag 2, alias, creation time (ms), "X.509", DER length, DER.
 * It ends with SHA-1(password as UTF-16BE + "Mighty Aphrodite" + everything before).
 */

const MAGIC = 0xfeedfeed;
const VERSION = 2;
const TRUSTED_CERT_TAG = 2;

/** PEM certificates in `pem` as DER buffers. */
export function pemToDer(pem: string): Buffer[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((block) =>
    Buffer.from(block.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''), 'base64'),
  );
}

function utf(text: string): Buffer {
  // Java's modified UTF-8 matches plain UTF-8 for the ASCII text used here.
  const bytes = Buffer.from(text, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
}

/** A JKS trust store with each certificate as a trusted entry, in order. */
export function trustStoreJks(certs: Buffer[], password: string, createdAt = Date.now()): Buffer {
  const parts: Buffer[] = [u32(MAGIC), u32(VERSION), u32(certs.length)];
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(BigInt(createdAt));
  certs.forEach((der, i) => {
    // Aliases must be unique; Java lower-cases them.
    parts.push(
      u32(TRUSTED_CERT_TAG),
      utf(i === 0 ? 'leverframe-ca' : `root-${i}`),
      time,
      utf('X.509'),
      u32(der.length),
      der,
    );
  });
  const body = Buffer.concat(parts);

  const passwordBytes = Buffer.alloc(password.length * 2);
  for (let i = 0; i < password.length; i++) passwordBytes.writeUInt16BE(password.charCodeAt(i), i * 2);
  const digest = createHash('sha1')
    .update(passwordBytes)
    .update(Buffer.from('Mighty Aphrodite', 'utf8'))
    .update(body)
    .digest();
  return Buffer.concat([body, digest]);
}
