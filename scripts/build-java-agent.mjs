#!/usr/bin/env node
// Builds Wirescry's Java agent (native/java-agent) into native/java-agent/build/:
//
//   wirescry-agent.jar       the stub that -javaagent: and the Attach API name (Java 8+)
//   wirescry-agent-impl.jar  the agent itself, which the stub loads (Java 8+)
//   wirescry-agent-weaver.jar  the weaver and Byte Buddy, which only the agent's own class loader
//                            loads, next to the agent's jar
//   wirescry-attach.jar      lists JVMs and loads the agent into one (runs on JDK 11+)
//
//   node scripts/build-java-agent.mjs
//
// Offline, put the pinned Byte Buddy jar in native/java-agent/deps/ by hand: it's used if its
// SHA-256 matches.
//
// Needs a JDK 17 or later: JAVA_HOME's, else the one on PATH. The jars target Java 8 (the attacher
// Java 11) whatever JDK builds them, and are reproducible: fixed timestamps, sorted entries.
//
// Byte Buddy (Apache-2.0) is fetched once from Maven Central into native/java-agent/deps/ and
// checked against the SHA-256 below; a file that doesn't match is never used.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
const JAR_NAMES = {
  stub: 'wirescry-agent.jar',
  impl: 'wirescry-agent-impl.jar',
  weaver: 'wirescry-agent-weaver.jar',
  attach: 'wirescry-attach.jar',
};
/** The jars a build into `dir` makes. */
export const jarsIn = (dir = buildDir) =>
  Object.fromEntries(Object.entries(JAR_NAMES).map(([part, name]) => [part, path.join(dir, name)]));
export const jars = jarsIn();
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

/**
 * A pinned jar: the one at `jar.file` if its SHA-256 matches, else fetched from `jar.url` and
 * checked. A file that doesn't match is never used.
 */
async function fetchPinned(jar, what) {
  if (existsSync(jar.file) && sha256Of(jar.file) === jar.sha256) return jar.file;
  mkdirSync(path.dirname(jar.file), { recursive: true });
  let response;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await fetch(jar.url, { signal: AbortSignal.timeout(60_000) });
      if (response.ok) break;
      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (attempt >= 2) {
        throw new Error(`Fetching ${what} from ${jar.url}: ${error.message}`, { cause: error });
      }
    }
  }
  // Its own name: builds running at once (test files in parallel) each write their own.
  const temp = `${jar.file}.${process.pid}.${randomUUID()}.download`;
  writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  const got = sha256Of(temp);
  if (got !== jar.sha256) {
    rmSync(temp, { force: true });
    throw new Error(`${what}'s SHA-256 is ${got}, not the pinned ${jar.sha256}. Not used.`);
  }
  renameSync(temp, jar.file);
  return jar.file;
}

/** Byte Buddy's jar: the one in deps/ if its SHA-256 matches, else fetched and checked. */
export function fetchByteBuddy() {
  return fetchPinned(byteBuddy, 'Byte Buddy');
}

const central = (group, artifact, version) =>
  `https://repo1.maven.org/maven2/${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
const testJar = (group, artifact, version, sha256) => ({
  name: `${artifact}-${version}`,
  url: central(group, artifact, version),
  sha256,
  file: path.join(source, 'deps', 'test', `${artifact}-${version}.jar`),
});

/**
 * Libraries the tests run the agent against, never shipped: Apache HttpClient 4.x and 5.x with
 * what they need at run time. Pinned like Byte Buddy; each matched Maven Central's published
 * SHA-1 when chosen.
 */
export const testJars = {
  apache4: [
    testJar(
      'org.apache.httpcomponents',
      'httpclient',
      '4.5.14',
      'c8bc7e1c51a6d4ce72f40d2ebbabf1c4b68bfe76e732104b04381b493478e9d6',
    ),
    testJar(
      'org.apache.httpcomponents',
      'httpcore',
      '4.4.16',
      '6c9b3dd142a09dc468e23ad39aad6f75a0f2b85125104469f026e52a474e464f',
    ),
    testJar(
      'commons-logging',
      'commons-logging',
      '1.2',
      'daddea1ea0be0f56978ab3006b8ac92834afeefbd9b7e4e6316fca57df0fa636',
    ),
    testJar(
      'commons-codec',
      'commons-codec',
      '1.11',
      'e599d5318e97aa48f42136a2927e6dfa4e8881dff0e6c8e3109ddbbff51d7b7d',
    ),
  ],
  // 4.x's async client, beside the 4.x jars above.
  apache4async: [
    testJar(
      'org.apache.httpcomponents',
      'httpasyncclient',
      '4.1.5',
      '0c1877489a9d1ba4fa50f6cfcab11d1123618858cb31d56afaab5afdd5064d99',
    ),
    testJar(
      'org.apache.httpcomponents',
      'httpcore-nio',
      '4.4.16',
      '4018736ede2d321034e8517ea90baefb31831a8608afccc446d8a699fb1d00d4',
    ),
  ],
  apache5: [
    testJar(
      'org.apache.httpcomponents.client5',
      'httpclient5',
      '5.6.5',
      'a10b555f7c85a720d1011a086d679d854b155816cde91a40198cc98c2b0867e8',
    ),
    testJar(
      'org.apache.httpcomponents.core5',
      'httpcore5',
      '5.4.4',
      'b08e3c3a440fec2029e89980134c7c787dd6796454641ad1eafb81478d7e8b0b',
    ),
    testJar(
      'org.apache.httpcomponents.core5',
      'httpcore5-h2',
      '5.4.4',
      '9a61441889f9b222ce99581977cc549b4dfca7ac9d2841582c1e57a31fa65b48',
    ),
    testJar(
      'org.slf4j',
      'slf4j-api',
      '1.7.36',
      'd3ef575e3e4979678dc01bf1dcce51021493b4d11fb7f1be8ad982877c16a1c0',
    ),
  ],
};

/** The jars of `set` (a key of testJars), fetched and checked as needed: their paths. */
export async function fetchTestJars(set) {
  const files = [];
  for (const jar of testJars[set]) files.push(await fetchPinned(jar, jar.name));
  return files;
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

/**
 * Builds the jars into `outDir` (default native/java-agent/build/), replacing what's there.
 * Returns their paths and SHA-256 digests.
 */
export async function buildJavaAgent(outDir = buildDir) {
  const jars = jarsIn(outDir);
  const javac = jdkTool('javac');
  const jar = jdkTool('jar');
  if (!javac || !jar) {
    throw new Error(
      'Building the Java agent needs a JDK 17 or later: set JAVA_HOME, or put its bin folder on PATH.',
    );
  }
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const byteBuddyJar = await fetchByteBuddy();
  rmSync(outDir, { recursive: true, force: true });
  const gen = path.join(outDir, 'gen');
  const classes = path.join(outDir, 'classes');

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
  // The weaver and Byte Buddy go in a jar of their own, which only the agent's own class loader
  // reads (see Hooks.java). Byte Buddy's base classes (Java 5 and 8) only: its versions/ folders
  // serve Java 9's module and Java 24's Class-File API, which the weaver doesn't use.
  const weaverClasses = path.join(classes, 'weaver');
  compile(javac, 8, javaFiles(path.join(source, 'weaver')), weaverClasses, ['-cp', byteBuddyJar]);
  const unpacked = path.join(outDir, 'byte-buddy');
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
  // Byte Buddy's license and notice go with it (Apache-2.0, section 4), and the license of the ASM
  // it bundles (BSD-3-Clause). The app's notices list them from the copies in licenses/, which
  // must be the same texts.
  const kept = JSON.parse(readFileSync(path.join(source, 'licenses', 'index.json'), 'utf8'));
  if (kept.byteBuddy !== byteBuddy.version) {
    throw new Error(
      `native/java-agent/licenses is for Byte Buddy ${kept.byteBuddy}: update it for ${byteBuddy.version}.`,
    );
  }
  for (const name of ['LICENSE', 'NOTICE', path.join('licenses', 'ASM')]) {
    const from = path.join(unpacked, 'META-INF', name);
    if (!existsSync(from))
      throw new Error(`Byte Buddy ${byteBuddy.version} has no META-INF/${name}: check its licensing.`);
    const copy = kept.inJar[name.split(path.sep).join('/')];
    if (!copy || !readFileSync(from).equals(readFileSync(path.join(source, 'licenses', copy)))) {
      throw new Error(
        `Byte Buddy's META-INF/${name} differs from native/java-agent/licenses: update the copy.`,
      );
    }
    const to = path.join(weaverClasses, 'META-INF', 'byte-buddy', name);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to);
  }
  compile(javac, 11, javaFiles(path.join(source, 'attach')), path.join(classes, 'attach'), [
    '--add-modules',
    'jdk.attach',
  ]);
  // The license goes in each jar, since the jars run inside other people's programs.
  for (const part of ['stub', 'impl', 'weaver', 'attach']) {
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
    `Implementation-Title: Wirescry Java agent weaver\nCreated-By: Wirescry build\nImplementation-Version: ${version}`,
    path.join(classes, 'weaver'),
    jars.weaver,
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
