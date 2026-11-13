#!/usr/bin/env node
// Builds Wirescry's Java agent (native/java-agent) into native/java-agent/build/:
//
//   wirescry-agent.jar       the stub that -javaagent: and the Attach API name (Java 8+)
//   wirescry-agent-impl.jar  the agent itself, which the stub loads (Java 8+), with its weaver and
//                            Byte Buddy under weaver/, which only the agent's own class loader reads
//   wirescry-attach.jar      lists JVMs and loads the agent into one (runs on JDK 11+)
//
//   node scripts/build-java-agent.mjs
//
// Needs a JDK 17 or later: JAVA_HOME's, else the one on PATH. The jars target Java 8 (the attacher
// Java 11) whatever JDK builds them, and are reproducible: fixed timestamps, sorted entries.
//
// Byte Buddy (Apache-2.0) is fetched once from Maven Central into native/java-agent/deps/ and
// checked against the SHA-256 below; a file that doesn't match is never used.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const source = path.join(root, 'native', 'java-agent');
export const buildDir = path.join(source, 'build');
export const jars = {
  stub: path.join(buildDir, 'wirescry-agent.jar'),
  impl: path.join(buildDir, 'wirescry-agent-impl.jar'),
  attach: path.join(buildDir, 'wirescry-attach.jar'),
};
/**
 * Byte Buddy, pinned. Its release was three weeks old when chosen (the newest, 1.18.17, was 12
 * days old). The SHA-256 is Maven Central's, and matched its published SHA-512 too.
 */
export const byteBuddy = {
  version: '1.18.16',
  url: 'https://repo1.maven.org/maven2/net/bytebuddy/byte-buddy/1.18.16/byte-buddy-1.18.16.jar',
  sha256: '666e4b302cea0baf5c43484675a15e1ad8537101c63cdfcc95fdbcfab35cf24a',
  file: path.join(source, 'deps', 'byte-buddy-1.18.16.jar'),
};

const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Byte Buddy's jar: the one in deps/ if its SHA-256 matches, else fetched and checked. */
export async function fetchByteBuddy() {
  if (existsSync(byteBuddy.file) && sha256Of(byteBuddy.file) === byteBuddy.sha256) return byteBuddy.file;
  mkdirSync(path.dirname(byteBuddy.file), { recursive: true });
  const response = await fetch(byteBuddy.url);
  if (!response.ok) throw new Error(`Fetching Byte Buddy: HTTP ${response.status} from ${byteBuddy.url}`);
  const temp = `${byteBuddy.file}.download`;
  writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  const got = sha256Of(temp);
  if (got !== byteBuddy.sha256) {
    rmSync(temp, { force: true });
    throw new Error(`Byte Buddy's SHA-256 is ${got}, not the pinned ${byteBuddy.sha256}. Not used.`);
  }
  renameSync(temp, byteBuddy.file);
  return byteBuddy.file;
}

/** Every entry's timestamp: the jars are the same bytes for the same sources. */
const DATE = '2026-01-01T00:00:00Z';

/**
 * A JDK tool (javac, jar) from JAVA_HOME, else PATH, if it's JDK 17 or later. On macOS, PATH's
 * /usr/bin tools are placeholders that offer to install Java in a dialog when run, so there the
 * JDK comes from JAVA_HOME or /usr/libexec/java_home (which answers without a dialog), never PATH.
 */
export function jdkTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  let home = process.env.JAVA_HOME;
  if (!home && process.platform === 'darwin') {
    const found = spawnSync('/usr/libexec/java_home', { encoding: 'utf8' });
    if (found.status === 0) home = found.stdout.trim();
  }
  const candidates = home ? [path.join(home, 'bin', exe)] : process.platform === 'darwin' ? [] : [exe];
  for (const tool of candidates) {
    const run = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    const major = Number(/(\d+)(?:\.\d+)*/.exec(`${run.stdout}${run.stderr}`)?.[1]);
    if (run.status === 0 && major >= 17) return tool;
  }
  return undefined;
}

function javaFiles(dir) {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.java'))
    .map((file) => path.join(dir, file))
    .sort();
}

function compile(javac, release, sources, out, extra = []) {
  mkdirSync(out, { recursive: true });
  // -Xlint:-options: newer JDKs warn that release 8 is old; it's chosen on purpose.
  execFileSync(
    javac,
    [
      '--release',
      String(release),
      '-Xlint:-options',
      '-encoding',
      'UTF-8',
      '-g',
      '-d',
      out,
      ...extra,
      ...sources,
    ],
    { stdio: 'inherit' },
  );
}

function packJar(jar, manifest, classes, out) {
  const manifestFile = `${classes}.MF`;
  writeFileSync(manifestFile, `${manifest.trim()}\n`);
  rmSync(out, { force: true });
  // Entries in sorted order, so the jar doesn't depend on the file system's listing order.
  const entries = readdirSync(classes, { recursive: true, encoding: 'utf8' })
    .filter((entry) => statSync(path.join(classes, entry)).isFile())
    .map((entry) => entry.split(path.sep).join('/'))
    .sort();
  // -C applies to the one file after it, so each entry gets its own. In an argument file: with
  // Byte Buddy's classes the command line would pass Windows' length limit.
  const quote = (arg) => `"${arg.replaceAll('\\', '/')}"`;
  const argFile = `${classes}.args`;
  writeFileSync(argFile, entries.map((entry) => `-C ${quote(classes)} ${quote(entry)}`).join('\n'));
  execFileSync(
    jar,
    ['--create', `--date=${DATE}`, '--file', out, '--manifest', manifestFile, `@${argFile}`],
    {
      stdio: 'inherit',
    },
  );
}

/** Builds the three jars. Returns their paths and SHA-256 digests. */
export async function buildJavaAgent() {
  const javac = jdkTool('javac');
  const jar = jdkTool('jar');
  if (!javac || !jar) {
    throw new Error(
      'Building the Java agent needs a JDK 17 or later: set JAVA_HOME, or put its bin folder on PATH.',
    );
  }
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const byteBuddyJar = await fetchByteBuddy();
  rmSync(buildDir, { recursive: true, force: true });
  const gen = path.join(buildDir, 'gen');
  const classes = path.join(buildDir, 'classes');

  const implGen = path.join(gen, 'com', 'wirescry', 'agent', 'impl');
  mkdirSync(implGen, { recursive: true });
  if (!/^[0-9A-Za-z.+-]{1,40}$/.test(version)) throw new Error(`Unexpected version ${version}`);
  writeFileSync(
    path.join(implGen, 'Version.java'),
    `// Made by scripts/build-java-agent.mjs.\npackage com.wirescry.agent.impl;\n\nfinal class Version {\n  static final String AGENT = "${version}";\n\n  private Version() {}\n}\n`,
  );

  compile(javac, 8, javaFiles(path.join(source, 'stub')), path.join(classes, 'stub'));
  // The implementation uses the stub's permission check, from the stub's jar: both are on the
  // system class loader.
  compile(
    javac,
    8,
    [...javaFiles(path.join(source, 'impl')), ...javaFiles(gen)],
    path.join(classes, 'impl'),
    ['-cp', path.join(classes, 'stub')],
  );
  // The weaver and Byte Buddy go under weaver/ in the implementation's jar: classes there are
  // invisible to the program, and loaded only by the agent's WeaverLoader. Byte Buddy's base
  // classes (Java 5 and 8) only: its versions/ folders serve Java 9's module and Java 24's
  // Class-File API, which the weaver doesn't use.
  const weaverClasses = path.join(classes, 'impl', 'weaver');
  compile(javac, 8, javaFiles(path.join(source, 'weaver')), weaverClasses, ['-cp', byteBuddyJar]);
  const unpacked = path.join(buildDir, 'byte-buddy');
  mkdirSync(unpacked, { recursive: true });
  execFileSync(jar, ['--extract', '--file', byteBuddyJar], { cwd: unpacked, stdio: 'inherit' });
  for (const entry of readdirSync(unpacked, { recursive: true, encoding: 'utf8' })) {
    const from = path.join(unpacked, entry);
    if (!statSync(from).isFile() || !entry.endsWith('.class') || entry.startsWith('META-INF')) continue;
    if (entry === 'module-info.class') continue;
    const to = path.join(weaverClasses, entry);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to);
  }
  // Byte Buddy's license and notice go with it (Apache-2.0, section 4).
  mkdirSync(path.join(classes, 'impl', 'META-INF', 'byte-buddy'), { recursive: true });
  for (const name of ['LICENSE', 'NOTICE']) {
    cpSync(path.join(unpacked, 'META-INF', name), path.join(classes, 'impl', 'META-INF', 'byte-buddy', name));
  }
  compile(javac, 11, javaFiles(path.join(source, 'attach')), path.join(classes, 'attach'), [
    '--add-modules',
    'jdk.attach',
  ]);
  // The license goes in each jar, since the jars run inside other people's programs.
  for (const part of ['stub', 'impl', 'attach']) {
    mkdirSync(path.join(classes, part, 'META-INF'), { recursive: true });
    cpSync(path.join(source, 'LICENSE'), path.join(classes, part, 'META-INF', 'LICENSE'));
  }

  packJar(
    jar,
    `Premain-Class: com.wirescry.agent.Stub\nCreated-By: Wirescry build\nAgent-Class: com.wirescry.agent.Stub\nCan-Retransform-Classes: true\nImplementation-Title: Wirescry Java agent\nImplementation-Version: ${version}`,
    path.join(classes, 'stub'),
    jars.stub,
  );
  packJar(
    jar,
    `Implementation-Title: Wirescry Java agent implementation\nCreated-By: Wirescry build\nImplementation-Version: ${version}`,
    path.join(classes, 'impl'),
    jars.impl,
  );
  packJar(
    jar,
    `Main-Class: com.wirescry.attach.Main\nCreated-By: Wirescry build\nImplementation-Version: ${version}`,
    path.join(classes, 'attach'),
    jars.attach,
  );

  return Object.fromEntries(
    Object.entries(jars).map(([name, file]) => [name, { file, sha256: sha256Of(file) }]),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const { file, sha256 } of Object.values(await buildJavaAgent())) {
    console.log(`Built ${path.relative(root, file)}  sha256 ${sha256}`);
  }
}
