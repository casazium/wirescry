import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import {
  curlrcContent,
  JAVA_TRUST_STORE_PASSWORD,
  phpIniContent,
  SHELL_SCRIPT_NAMES,
  shellScript,
  shellScriptSupported,
  type ShellKind,
} from '../shared/terminal-env';
import { CONTAINER_FILES, MOUNT_POINT } from './docker/container';
import { pemToDer, trustStoreJks } from './jks';

export const CA_BUNDLE_FILE = 'ca-bundle.pem';

/**
 * Writes Wirescry's CA followed by Node's bundled public roots and the operating
 * system's roots. Tools told to use this file (SSL_CERT_FILE and similar) then trust
 * Wirescry without losing trust in everything else, e.g. for hosts that skip the proxy.
 */
export async function writeCABundle(dir: string, caCert: string): Promise<{ path: string; pem: string }> {
  let system: string[] = [];
  try {
    system = tls.getCACertificates('system');
  } catch {
    // Older Node: bundled roots only.
  }
  const certs = [caCert.trim(), ...new Set([...tls.rootCertificates, ...system].map((c) => c.trim()))];
  const file = path.join(dir, CA_BUNDLE_FILE);
  const pem = certs.join('\n') + '\n';
  await writeFile(file, pem, { mode: 0o644 });
  return { path: file, pem };
}

export interface TerminalConfig {
  bundlePath: string;
  phpIniDir: string;
  curlHome: string;
  javaTrustStore: string;
  /** Folder mounted into Docker containers Wirescry sets up, with the same files at container paths. */
  containerDir: string;
}

/** Writes the CA bundle plus the PHP and curl config files that point at it. */
export async function writeTerminalConfig(dir: string, caCert: string): Promise<TerminalConfig> {
  const { path: bundlePath, pem } = await writeCABundle(dir, caCert);
  const phpIniDir = path.join(dir, 'terminal-config', 'php');
  const curlHome = path.join(dir, 'terminal-config', 'curl');
  await mkdir(phpIniDir, { recursive: true });
  await mkdir(curlHome, { recursive: true });
  await writeFile(path.join(phpIniDir, 'wirescry.ini'), phpIniContent(bundlePath));
  // Windows curl reads _curlrc; newer versions also read .curlrc.
  await writeFile(path.join(curlHome, '_curlrc'), curlrcContent(bundlePath));
  await writeFile(path.join(curlHome, '.curlrc'), curlrcContent(bundlePath));
  // Java can't read PEM bundles, so give it the same certificates as a JKS trust store.
  const javaDir = path.join(dir, 'terminal-config', 'java');
  await mkdir(javaDir, { recursive: true });
  const javaTrustStore = path.join(javaDir, 'wirescry-truststore.jks');
  const jks = trustStoreJks(pemToDer(pem), JAVA_TRUST_STORE_PASSWORD);
  await writeFile(javaTrustStore, jks);
  const containerDir = await writeContainerConfig(dir, caCert, pem, jks);
  return { bundlePath, phpIniDir, curlHome, javaTrustStore, containerDir };
}

/**
 * The folder Docker containers see at MOUNT_POINT: the certificate, the bundle, and the PHP and
 * Java files, with paths as the container sees them. Files are rewritten in place, so running
 * containers pick up a new certificate too.
 */
async function writeContainerConfig(
  dir: string,
  caCert: string,
  bundlePem: string,
  jks: Buffer,
): Promise<string> {
  const containerDir = path.join(dir, 'docker-config');
  await mkdir(path.join(containerDir, CONTAINER_FILES.phpDir), { recursive: true });
  await mkdir(path.dirname(path.join(containerDir, CONTAINER_FILES.javaTrustStore)), { recursive: true });
  // Readable by everyone: containers often run as a user other than the host's.
  await writeFile(path.join(containerDir, CONTAINER_FILES.ca), caCert.trim() + '\n', { mode: 0o644 });
  await writeFile(path.join(containerDir, CONTAINER_FILES.bundle), bundlePem, { mode: 0o644 });
  await writeFile(
    path.join(containerDir, CONTAINER_FILES.phpDir, 'wirescry.ini'),
    phpIniContent(`${MOUNT_POINT}/${CONTAINER_FILES.bundle}`),
    { mode: 0o644 },
  );
  await writeFile(path.join(containerDir, CONTAINER_FILES.javaTrustStore), jks, { mode: 0o644 });
  return containerDir;
}

/**
 * Writes a script per shell that sets `env`, so an open terminal can be set up with one
 * line. Returns the path of each script written; a shell whose script can't be written
 * (or can't hold these values) is left out, and the Setup page falls back for it.
 */
export async function writeShellScripts(
  dir: string,
  env: Record<string, string>,
): Promise<Partial<Record<ShellKind, string>>> {
  const scriptDir = path.join(dir, 'terminal-config', 'env');
  const paths: Partial<Record<ShellKind, string>> = {};
  try {
    await mkdir(scriptDir, { recursive: true });
  } catch (error) {
    console.error('[wirescry] could not create the terminal scripts folder:', error);
    return paths;
  }
  for (const shell of Object.keys(SHELL_SCRIPT_NAMES) as ShellKind[]) {
    if (!shellScriptSupported(env, shell)) continue;
    const file = path.join(scriptDir, SHELL_SCRIPT_NAMES[shell]);
    try {
      await writeFile(file, shellScript(env, shell), { mode: 0o644 });
      paths[shell] = file;
    } catch (error) {
      // E.g. antivirus holding the file. Not worth failing a proxy restart over.
      console.error(`[wirescry] could not write ${file}:`, error);
    }
  }
  return paths;
}
