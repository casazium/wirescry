import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Finding a JDK that can run Wirescry's attacher (native/java-agent/attach): Java 11 or later,
 * with the jdk.attach module. A runtime without it (a JRE, or a trimmed jlink image) can't attach.
 * Any such JDK attaches to programs on Java 8 and later.
 */

export interface Jdk {
  /** The JDK's folder (its java.home). */
  home: string;
  /** Its `java` executable. */
  java: string;
  /** Its version, as its `release` file gives it (e.g. "21.0.2"). */
  version: string;
  major: number;
  /** Where it was found. */
  from: 'JAVA_HOME' | 'PATH' | 'java_home';
}

export interface JdkSearch {
  jdk?: Jdk;
  /** Why each place looked at was passed over, for the Setup page when none is found. */
  passed: string[];
}

export interface JdkFinderOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Lists macOS's installed JDKs (`/usr/libexec/java_home -V`'s output). For tests. */
  javaHomeList?: () => Promise<string>;
}

/** The major version in a `JAVA_VERSION` ("1.8.0_412" is 8, "21.0.2" is 21), or 0 if unknown. */
export function majorOf(version: string): number {
  const match = /^(?:1\.)?(\d{1,4})(?:[.+_-]|$)/.exec(version);
  return match ? Number(match[1]) : 0;
}

/** A `release` file's fields (KEY="value" lines). */
export function parseRelease(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(?:"([^"]*)"|(\S*))\s*$/.exec(line);
    if (match?.[1]) fields.set(match[1], match[2] ?? match[3] ?? '');
  }
  return fields;
}

const exe = (platform: NodeJS.Platform) => (platform === 'win32' ? 'java.exe' : 'java');

/**
 * The JDK at `home` if it can attach, else why not. Reads its `release` file: JAVA_VERSION 11 or
 * later, and jdk.attach among MODULES.
 */
export async function checkJdk(
  home: string,
  from: Jdk['from'],
  platform: NodeJS.Platform = process.platform,
): Promise<Jdk | string> {
  const java = path.join(home, 'bin', exe(platform));
  const text = await readFile(path.join(home, 'release'), 'utf8').catch(() => undefined);
  if (text === undefined) return `${home} has no release file, so it isn't a JDK Wirescry can use`;
  const fields = parseRelease(text);
  const version = fields.get('JAVA_VERSION') ?? '';
  const major = majorOf(version);
  if (major < 11)
    return `${home} is Java ${version || 'of an unknown version'}; attaching needs Java 11 or later`;
  if (!(fields.get('MODULES') ?? '').split(/\s+/).includes('jdk.attach')) {
    return `${home} is a runtime without the jdk.attach module (a JRE, or a trimmed one)`;
  }
  const file = await stat(java).catch(() => undefined);
  if (!file?.isFile()) return `${home} has no ${path.join('bin', exe(platform))}`;
  return { home, java, version, major, from };
}

/** The JDK homes `/usr/libexec/java_home -V` lists, newest first as it gives them. */
export function parseJavaHomeList(text: string): string[] {
  const homes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    // `    21.0.2 (arm64) "Eclipse Adoptium" - "OpenJDK 21.0.2" /Library/Java/…/Contents/Home`
    const match = /^\s+\S.*"\s+(\/.+?)\s*$/.exec(line);
    if (match?.[1]) homes.push(match[1]);
  }
  return homes;
}

function javaHomeList(): Promise<string> {
  return new Promise((resolve) => {
    // It lists on stderr, and exits non-zero when there are none.
    execFile('/usr/libexec/java_home', ['-V'], { timeout: 5000 }, (_error, stdout, stderr) =>
      resolve(`${stderr}\n${stdout}`),
    );
  });
}

/** `java` on PATH, as PATH lists it (not resolved). */
function onPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const delimiter = platform === 'win32' ? ';' : ':';
  return (env[key] ?? '')
    .split(delimiter)
    .filter((dir) => dir && path.isAbsolute(dir))
    .map((dir) => path.join(dir, exe(platform)));
}

/**
 * Looks for a JDK that can attach, in order: JAVA_HOME, `java` on PATH, then (macOS) the JDKs
 * `/usr/libexec/java_home` knows. macOS's /usr/bin/java is a placeholder that asks to install
 * Java, so it's passed over; java_home finds what it would run.
 */
export async function findJdk(options: JdkFinderOptions = {}): Promise<JdkSearch> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const passed: string[] = [];
  const seen = new Set<string>();
  const tryHome = async (home: string, from: Jdk['from']): Promise<Jdk | undefined> => {
    const key = platform === 'win32' ? home.toLowerCase() : home;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const found = await checkJdk(home, from, platform);
    if (typeof found === 'string') {
      passed.push(found);
      return undefined;
    }
    return found;
  };

  const javaHome = env.JAVA_HOME?.trim();
  if (javaHome && path.isAbsolute(javaHome)) {
    const jdk = await tryHome(path.normalize(javaHome), 'JAVA_HOME');
    if (jdk) return { jdk, passed };
  }

  for (const candidate of onPath(env, platform)) {
    if (platform === 'darwin' && candidate === '/usr/bin/java') continue;
    const real = await realpath(candidate).catch(() => undefined);
    if (!real) continue;
    // <home>/bin/java
    const jdk = await tryHome(path.dirname(path.dirname(real)), 'PATH');
    if (jdk) return { jdk, passed };
  }

  if (platform === 'darwin') {
    const list = await (options.javaHomeList ?? javaHomeList)();
    for (const home of parseJavaHomeList(list)) {
      const jdk = await tryHome(home, 'java_home');
      if (jdk) return { jdk, passed };
    }
  }
  return { passed };
}
