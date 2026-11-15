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
 * Libraries the tests run the agent against, never shipped: Apache HttpClient 4.x and 5.x across
 * releases, Spring's RestTemplate and Spring Boot's launcher, with what they need at run time.
 * Pinned like Byte Buddy; each matched Maven Central's published SHA-1 when chosen.
 */
const commonsLogging = testJar(
  'commons-logging',
  'commons-logging',
  '1.2',
  'daddea1ea0be0f56978ab3006b8ac92834afeefbd9b7e4e6316fca57df0fa636',
);
const commonsCodec = testJar(
  'commons-codec',
  'commons-codec',
  '1.11',
  'e599d5318e97aa48f42136a2927e6dfa4e8881dff0e6c8e3109ddbbff51d7b7d',
);
const slf4j = testJar(
  'org.slf4j',
  'slf4j-api',
  '1.7.36',
  'd3ef575e3e4979678dc01bf1dcce51021493b4d11fb7f1be8ad982877c16a1c0',
);
const core5 = 'org.apache.httpcomponents.core5';
/** HttpClient 5.x `client` with HttpCore 5.x `core`, its HTTP/2 module, and SLF4J. */
const apache5 = (client, clientSha, core, coreSha, h2Sha) => [
  testJar('org.apache.httpcomponents.client5', 'httpclient5', client, clientSha),
  testJar(core5, 'httpcore5', core, coreSha),
  testJar(core5, 'httpcore5-h2', core, h2Sha),
  slf4j,
];

/**
 * Jetty's HttpClient across its lines, for the Jetty hook's tests: SHA-256 by artifact and version,
 * each matched Maven Central's published SHA-1 when chosen (2026-11-15).
 */
const jettyPins = {
  'jetty-client-9.4.25.v20191220': [
    'org.eclipse.jetty',
    'ab052c698d468dd2cb8d9d5b707e55a944030d915f4f9f41ac3cdcf82b3dc6e0',
  ],
  'jetty-http-9.4.25.v20191220': [
    'org.eclipse.jetty',
    'dc9c466f0fe4bf37fd5f4da23d01684b067ade9a1602c4f3c5b694bcc20847ba',
  ],
  'jetty-io-9.4.25.v20191220': [
    'org.eclipse.jetty',
    'e9c31db503b6075fd43f15531903007c1e829fc245da3404b6e4327f24ef9569',
  ],
  'jetty-util-9.4.25.v20191220': [
    'org.eclipse.jetty',
    '223780d724c1c7463c3233a82c07686f3fd78a022f560d010257dbe4028e0d14',
  ],
  'jetty-client-9.4.0.v20161208': [
    'org.eclipse.jetty',
    '0e1205e58cfa8c7668dad2b0d8eb0df9f412151138acba7cb3e2e43f829d4de4',
  ],
  'jetty-http-9.4.0.v20161208': [
    'org.eclipse.jetty',
    '96422b4b80d48a1825375b66b48c527414a24f80c24e6eb609074dc725a303a1',
  ],
  'jetty-io-9.4.0.v20161208': [
    'org.eclipse.jetty',
    '9f455825ed17b72a09b38f92e19dc7f0977da820a0bebc6ba8053e4e06043dac',
  ],
  'jetty-util-9.4.0.v20161208': [
    'org.eclipse.jetty',
    '9147feffe04e4e6ab6f94114c81d7a6ae086f705234f5259300097593a84c828',
  ],
  'jetty-client-9.4.58.v20250814': [
    'org.eclipse.jetty',
    '629371e5f65f321832930538bd485e5fd637d180412ea75f592881921e2d4b83',
  ],
  'jetty-http-9.4.58.v20250814': [
    'org.eclipse.jetty',
    '8f49b8583fc8dbbfe3a0ba80a04c97df64ebabca2981b56ee403c989aba9d4da',
  ],
  'jetty-io-9.4.58.v20250814': [
    'org.eclipse.jetty',
    'f55b2cc7c05244fd7b1773e99979b740002b0186e45b8a688243d89c7006fe21',
  ],
  'jetty-util-9.4.58.v20250814': [
    'org.eclipse.jetty',
    '8d591679d318d20c8fb2b1e83900562b3c4571ff7a189696be700293e0204146',
  ],
  'jetty-client-10.0.0': [
    'org.eclipse.jetty',
    'fac55a03125f27b647ed750537bb4eafb16cb97d26ccd026b5701dd4ff22d78d',
  ],
  'jetty-http-10.0.0': [
    'org.eclipse.jetty',
    '9bb4f8785eb9e1566599d34287ae69f4c6f34351c729e9059f528d574d6cb336',
  ],
  'jetty-io-10.0.0': [
    'org.eclipse.jetty',
    'f135df73390d36786c8e437ee86e447c5593fbba641115ab29fc74b754a91fda',
  ],
  'jetty-util-10.0.0': [
    'org.eclipse.jetty',
    'ff57b255419453aca387f759f867e9f08ef719856ff23d536931893e17158574',
  ],
  'jetty-alpn-client-10.0.0': [
    'org.eclipse.jetty',
    'db92674ac30443984a2a08c60c6f1b4b13274d6b3e19c9a6d401f8a279d565cd',
  ],
  'jetty-client-10.0.26': [
    'org.eclipse.jetty',
    '2020666651aa37e4ccb30ed4b13d3a8e819a727e5fd8b1e5af53daba33c4149d',
  ],
  'jetty-http-10.0.26': [
    'org.eclipse.jetty',
    '7d249c0c5a1b187060309ebdbe0845e315914c3aab294886b63b55fa56e2aa87',
  ],
  'jetty-io-10.0.26': [
    'org.eclipse.jetty',
    '6e2274dc5468290d7a9d99806ffeeb3045464b913a3ef3ac048cfbde95edc4ff',
  ],
  'jetty-util-10.0.26': [
    'org.eclipse.jetty',
    '95e2dc9c0d32f8585814272a32128b5328ca3f2b9c31fd8aae06e3476f253cb5',
  ],
  'jetty-alpn-client-10.0.26': [
    'org.eclipse.jetty',
    'd5dbbe89317a8538f77654cc0f39fcc55b0701c272696715de5ce17dd9cb2ae2',
  ],
  'jetty-client-11.0.0': [
    'org.eclipse.jetty',
    '9c617dc26846cbaf892a0cb2b5f8f261c2c997deaec73f686231b885739fec43',
  ],
  'jetty-http-11.0.0': [
    'org.eclipse.jetty',
    'b90f5b2c4c2f8163eec9ee3d101c7fbf984b19351e355d9b9ffdab1ab30957a2',
  ],
  'jetty-io-11.0.0': [
    'org.eclipse.jetty',
    'fbbd42ea6b80597e9cf04d2e487a30995a3e9e8131ffc1dbd7725b29283ff352',
  ],
  'jetty-util-11.0.0': [
    'org.eclipse.jetty',
    'acb0f478d2a1164e376123e27cc1c1c3ebf95e975e58547a7275740c30b9e9c8',
  ],
  'jetty-alpn-client-11.0.0': [
    'org.eclipse.jetty',
    '174c3de2e66a03ad04267eab06b9db4f8f0f7f6ddae3fbc598c92a1eb8c2b49e',
  ],
  'jetty-client-11.0.26': [
    'org.eclipse.jetty',
    '77da3e1dbb0d0f288f8629d7ba2f71e80aebb8f218a5dcfa888278c7fa5e04fd',
  ],
  'jetty-http-11.0.26': [
    'org.eclipse.jetty',
    'de738c8cfd5701627b5373c42376453beb8276f989d75e5258e3b1ffe217e938',
  ],
  'jetty-io-11.0.26': [
    'org.eclipse.jetty',
    'ce0ef76071e361d97f102e5cb48928b3cc66ac899d12be3ef0af8d06b4f768a1',
  ],
  'jetty-util-11.0.26': [
    'org.eclipse.jetty',
    '1b61b875a6d40e8fd44cffb307bdb66f3459370a152a50a092a698c3737eeca9',
  ],
  'jetty-alpn-client-11.0.26': [
    'org.eclipse.jetty',
    '00cae1113d6051aa15f3259c96def9064793756dc62c5f1ae2363b16c55b533f',
  ],
  'jetty-client-12.0.0': [
    'org.eclipse.jetty',
    'ffb7dd3123fb827c404adfc56f9180533350e685d7655e37e7ee42c7d2c1da3f',
  ],
  'jetty-http-12.0.0': [
    'org.eclipse.jetty',
    '9b8aa8187a0bf49bdb2e90da5ab1f4ddc93c80de805cab33bb35d655c2ecbc95',
  ],
  'jetty-io-12.0.0': [
    'org.eclipse.jetty',
    '368a101682cb1d5f741fd0f4d0806123d75d730078010d8c7e2310e13393509e',
  ],
  'jetty-util-12.0.0': [
    'org.eclipse.jetty',
    '4f7400139e9a3fd609fbe17da689d72af9aaa86f5e125ac9e22e5eec6bc63495',
  ],
  'jetty-alpn-client-12.0.0': [
    'org.eclipse.jetty',
    '41dd5052eca0180afa4b4fb27b2b2f9d385953af9c521ab3cdb4561f3113ce77',
  ],
  'jetty-client-12.0.41': [
    'org.eclipse.jetty',
    'e82b2dbe26c3524d2128baa6057bae94ecd1a567fb8af085579cf94de0e0beec',
  ],
  'jetty-http-12.0.41': [
    'org.eclipse.jetty',
    '34c7d495529ad3f771ea5097fd123635222a8eed87a142028aaf56d0b05e04f6',
  ],
  'jetty-io-12.0.41': [
    'org.eclipse.jetty',
    'd1f5af592f5833facebd5799b88ec818a86feace9fe0b9093a7609c945f62cbc',
  ],
  'jetty-util-12.0.41': [
    'org.eclipse.jetty',
    '2f301ac9fb613ad21b6b4cc0d5659f4663ba953a779ed8abc670f84cb196775a',
  ],
  'jetty-alpn-client-12.0.41': [
    'org.eclipse.jetty',
    '095ef664d56e353d65a94dd43d576b6cc5ec7e5aeb0168b76e573b5bea967de6',
  ],
  'jetty-client-12.1.0': [
    'org.eclipse.jetty',
    '8c4b7d823a2e40c109f0e1db0e24add563cade41bdb88cafc48bf7a3dfbf067f',
  ],
  'jetty-http-12.1.0': [
    'org.eclipse.jetty',
    '109c904a4995ab80c02826fa62abccff93683f91dd0c1f304a1f05e4f094d901',
  ],
  'jetty-io-12.1.0': [
    'org.eclipse.jetty',
    '841f5e57cb9270e8a3a829eaf5b0b091f7fb2ae225bba7be2a3ce866a521451a',
  ],
  'jetty-util-12.1.0': [
    'org.eclipse.jetty',
    '169f87dcc14a6a4bc2000a75a60b1f1617e1d2017207ba96d6777121017470c4',
  ],
  'jetty-alpn-client-12.1.0': [
    'org.eclipse.jetty',
    '2c3178842c96ccadf257caa42c3ad856c948f22b8f717e6a272299f11f3ad633',
  ],
  'jetty-compression-common-12.1.0': [
    'org.eclipse.jetty.compression',
    '963e6685ea8228c0e60fbb5ce70deeb3c4bb56e46ea5ef3b796a10feefbf094b',
  ],
  'jetty-compression-gzip-12.1.0': [
    'org.eclipse.jetty.compression',
    'cd14806002a293ab30d5c98deddef0700d9ef4794872ec9b316726e4d7960b6b',
  ],
  'jetty-client-12.1.15': [
    'org.eclipse.jetty',
    'ad910336328a5afde916d1be38391078ac11386038931cdf4637f3c8fef85e9b',
  ],
  'jetty-http-12.1.15': [
    'org.eclipse.jetty',
    '641774717e2fa668ce3a8915c51ce1f4503037a1209620d7bbd074e70b23b7fd',
  ],
  'jetty-io-12.1.15': [
    'org.eclipse.jetty',
    'b5f940782fe61bb1b51269eba7cadd1afa771e2bd649e1fa48057d1647ec9212',
  ],
  'jetty-util-12.1.15': [
    'org.eclipse.jetty',
    '74cb58a645f9d265d8e061b9227ec13c7acbb16c34bd6610eca229f58e928f37',
  ],
  'jetty-alpn-client-12.1.15': [
    'org.eclipse.jetty',
    '7c067bcb22bc225a52272dc6e41e6ae86f385c8e46db2f0adf9b3cb6f6de3d81',
  ],
  'jetty-compression-common-12.1.15': [
    'org.eclipse.jetty.compression',
    'eb879928434fbf9aba1088198349dd5461110f2096c6d084a009de077c76a422',
  ],
  'jetty-compression-gzip-12.1.15': [
    'org.eclipse.jetty.compression',
    '746c008d35a9f14a0f2a3b40a52de7c45df6d239e208032b86614a99abf8e4de',
  ],
  'slf4j-api-2.0.17': ['org.slf4j', '7b751d952061954d5abfed7181c1f645d336091b679891591d63329c622eb832'],
  'http2-client-10.0.26': [
    'org.eclipse.jetty.http2',
    '991ffc4f2b482796791b8e3bb4fff7e8f8bc4315ee95eb210aa04e3ea14c86c4',
  ],
  'http2-http-client-transport-10.0.26': [
    'org.eclipse.jetty.http2',
    'eb132c7af5dda0c88fb2f2c0e931d09d4dd90e1b8e6cc43ac93fb2b7ca277d2f',
  ],
  'http2-common-10.0.26': [
    'org.eclipse.jetty.http2',
    '771b85fafec406d4ddbea6e49788cb0e7b02656d5b573df5c30c439d537663ad',
  ],
  'http2-hpack-10.0.26': [
    'org.eclipse.jetty.http2',
    'e43b49dc1ca83d4289c6dbb045a3b0522c9836e6c948ad6fc368af0d1a9c77e0',
  ],
  'jetty-alpn-java-client-10.0.26': [
    'org.eclipse.jetty',
    '72c97714a3b15a17982a349bd9dcb0090999118a683f0db2ff203f456a00843d',
  ],
  'http2-client-11.0.26': [
    'org.eclipse.jetty.http2',
    '04ef39e0c4c9dfac32f074d29179f35da8e12707e89ddb8aa00ef53cde724e77',
  ],
  'http2-http-client-transport-11.0.26': [
    'org.eclipse.jetty.http2',
    '9cf1fdafc4f305c1ccc4b2f3f4208e3a9836bb3e82a0fc4ce85ee80208947b9a',
  ],
  'http2-common-11.0.26': [
    'org.eclipse.jetty.http2',
    '4878427ca7129c66c6c870296a4224a9d695fc194d1a6851015d7936fea3e4ec',
  ],
  'http2-hpack-11.0.26': [
    'org.eclipse.jetty.http2',
    '269d050fd75e37b52ed6ba83278acb4a0a6ff76bc0b83f097a90a265dfef7ceb',
  ],
  'jetty-alpn-java-client-11.0.26': [
    'org.eclipse.jetty',
    '451292e8b12ffc27f7a8768146f67e82cc05db2a56191ec8573f741ce879e0f3',
  ],
  'jetty-http2-client-12.0.41': [
    'org.eclipse.jetty.http2',
    'e2738d3b1858af10b0a1319b30fb65fcc71a71b85e51635ea44d4532432b9d90',
  ],
  'jetty-http2-client-transport-12.0.41': [
    'org.eclipse.jetty.http2',
    'a30e12ebb3ae1e4dede1bc229d8aa4a2f4c9cad26160f3b6b3b9d5dbb5e2d952',
  ],
  'jetty-http2-common-12.0.41': [
    'org.eclipse.jetty.http2',
    'a46b9aa28d5874beece670136c40b44aa188d5a7eaa00869166d0a7687709cc4',
  ],
  'jetty-http2-hpack-12.0.41': [
    'org.eclipse.jetty.http2',
    'b16dd9d524bdae964666cf769195be17e1e76a26c24b7412c3d3f7498f3318fe',
  ],
  'jetty-alpn-java-client-12.0.41': [
    'org.eclipse.jetty',
    '56ae97e5d9e01d45d50e5bb1e32e1844dbfd143432347a8846de93f4e0c71cfc',
  ],
  'jetty-http2-client-12.1.15': [
    'org.eclipse.jetty.http2',
    '7d38c8127a25bcfac0d6f7472ba5cd7e28f17670c9484c2ddddd20267aa0a148',
  ],
  'jetty-http2-client-transport-12.1.15': [
    'org.eclipse.jetty.http2',
    '906ae3e4246fbe6d7047b7c9e5eac734a4505cafc7309dead03fb253c70b89e8',
  ],
  'jetty-http2-common-12.1.15': [
    'org.eclipse.jetty.http2',
    '1ecc5f201cf0cc3ebff7706b796e1fab2628822ab4f86af78c55b6ade9b36bef',
  ],
  'jetty-http2-hpack-12.1.15': [
    'org.eclipse.jetty.http2',
    'ff8a5ecf745a99dfdac15a3ea00a659889cefadc5939ea3b38511bb8545a1994',
  ],
  'jetty-alpn-java-client-12.1.15': [
    'org.eclipse.jetty',
    '0e65325bedef248911a48678ab0d62d2e5677088e317a0f71bbff1069a4fd713',
  ],
};
const pinned = (artifact, version) => {
  const [group, sha256] = jettyPins[`${artifact}-${version}`];
  return testJar(group, artifact, version, sha256);
};
/** Jetty's client at `version` with what it needs at run time: SLF4J 2 from 10 on, compression in 12.1. */
const jetty = (version) => [
  ...['jetty-client', 'jetty-http', 'jetty-io', 'jetty-util'].map((a) => pinned(a, version)),
  ...(version.startsWith('9.') ? [] : [pinned('jetty-alpn-client', version), pinned('slf4j-api', '2.0.17')]),
  ...(version.startsWith('12.1.')
    ? [pinned('jetty-compression-common', version), pinned('jetty-compression-gzip', version)]
    : []),
];
/** Jetty's HTTP/2 client for the dynamic transport, beside jetty(version). */
const jettyH2 = (version) => [
  ...(version.startsWith('12.')
    ? ['jetty-http2-client', 'jetty-http2-client-transport', 'jetty-http2-common', 'jetty-http2-hpack']
    : ['http2-client', 'http2-http-client-transport', 'http2-common', 'http2-hpack']
  ).map((a) => pinned(a, version)),
  pinned('jetty-alpn-java-client', version),
];

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
    commonsLogging,
    commonsCodec,
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
    slf4j,
  ],
  // Older and newer releases, for the version matrix: the oldest with DefaultRoutePlanner (4.3)
  // and httpcore's older HttpHost constructors (4.3), and 5.x across its minor releases and the
  // 5.7 beta, whose builders no longer use DefaultRoutePlanner.
  'apache4.3': [
    testJar(
      'org.apache.httpcomponents',
      'httpclient',
      '4.3.6',
      '79838d9eaef73d4f852c63a480830c3a2d4b590f0ab3ae815a489463e4714004',
    ),
    testJar(
      'org.apache.httpcomponents',
      'httpcore',
      '4.3.3',
      '5285de80af1651c489313b91a9f40c65a4cdcb6b3bde716fcc028d16869a5a93',
    ),
    commonsLogging,
    commonsCodec,
  ],
  'apache4.4': [
    testJar(
      'org.apache.httpcomponents',
      'httpclient',
      '4.4.1',
      'b2958ffb74f691e108abe69af0002ccff90ba326420596b1aab5bb0f63c31ef9',
    ),
    testJar(
      'org.apache.httpcomponents',
      'httpcore',
      '4.4.1',
      'dd1390c17d40f760f7e51bb20523a8d63deb69e94babeaf567eb76ecd2cad422',
    ),
    commonsLogging,
    commonsCodec,
  ],
  'apache5.0': apache5(
    '5.0.4',
    'bbfa79fef1473fe85cabff39ce370c986820034e146f335cc9093f70eddb8b8c',
    '5.0.4',
    '4e0157d6f9ae2de749f3caa221dadfd08d63117b0fc8d4b13cf9c8fd96dc3219',
    'bfb1786db3001410dba29e82df72aa2cbfdae224bd5d76211ffe9c4b6afab315',
  ),
  'apache5.2': apache5(
    '5.2.3',
    '7cf4c7e60338aa334e8699f2423af1c93bdc3a3121f2df22378d61222fa5910c',
    '5.2.4',
    'a7f62496113f66f9e27c26b84c44f5ce4555c6270083cdf2d45f255336cd52af',
    'dc1a95e73eb04db93451533d390ce02c53b301a10dc343d08c862f2934b3d30e',
  ),
  'apache5.4': apache5(
    '5.4.4',
    '3f8657eab91b7533e5cf232d4e268253c4ff9f99f1e4bcd67841618bed67f2de',
    '5.3.4',
    'f2b2fd7a0164e8c3120cd8437bc9fea439239e165c17262b3e907daa7e979f80',
    '1fb4f34e4b612e7c127ad693335583587850b17ce9b1c366f9de1ca49fe2c781',
  ),
  'apache5.7': apache5(
    '5.7-beta1',
    'e3bbadbf2096e610271318dfd9f5bbdf6d07c4b68ce6ab092c285393200ec2c4',
    '5.5-beta4',
    '51d25499f6a8e1f1804a27414b844701fd9420c99497626971cc356c11d87964',
    'c3d8eba8b0052106f7a5cd86b77b5749b2d629d37d9cb20dee80cffea811adee',
  ),
  // Spring's RestTemplate (Java 17+), beside apache5, and Spring Boot's launcher for a fat jar.
  spring: [
    testJar(
      'org.springframework',
      'spring-web',
      '6.2.19',
      'ca88e364ecebee61163e2260e8a20584138eca74e28a050d6a2ef6302bad2f2d',
    ),
    testJar(
      'org.springframework',
      'spring-core',
      '6.2.19',
      '52146689e71a911c92bac26677d73c692512a739893a57710cc233591756bff6',
    ),
    testJar(
      'org.springframework',
      'spring-beans',
      '6.2.19',
      '846dc8f30a639a36eb551ee99a30469be4d11bd285ca9daf164d98321571b404',
    ),
    testJar(
      'org.springframework',
      'spring-jcl',
      '6.2.19',
      '9994478bcea1423b8892d4eb0db942c94da0090167c3c684050c1eaef04491d0',
    ),
    testJar(
      'io.micrometer',
      'micrometer-observation',
      '1.15.12',
      '54483e68ed44af1bb0c36d1df2235d36f233e459d52f5a3be3e69813827a6300',
    ),
    testJar(
      'io.micrometer',
      'micrometer-commons',
      '1.15.12',
      '4b779cf7acb0534bb1f8e964f25200037ecb3944368f859a630fa637d6d5d7c0',
    ),
  ],
  springBootLoader: [
    testJar(
      'org.springframework.boot',
      'spring-boot-loader',
      '3.5.16',
      'b62a856794f4b05b2f44a3dda573204d7f07cd3c32923bfb970bdccd15dedc0f',
    ),
  ],
  'jetty9.4.0': jetty('9.4.0.v20161208'),
  // The first 9.4 release the hooks cover: the first with createOrigin and tags.
  'jetty9.4.25': jetty('9.4.25.v20191220'),
  'jetty9.4': jetty('9.4.58.v20250814'),
  'jetty10.0.0': jetty('10.0.0'),
  jetty10: [...jetty('10.0.26'), ...jettyH2('10.0.26')],
  'jetty11.0.0': jetty('11.0.0'),
  jetty11: [...jetty('11.0.26'), ...jettyH2('11.0.26')],
  'jetty12.0.0': jetty('12.0.0'),
  'jetty12.0': [...jetty('12.0.41'), ...jettyH2('12.0.41')],
  'jetty12.1.0': jetty('12.1.0'),
  'jetty12.1': [...jetty('12.1.15'), ...jettyH2('12.1.15')],
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
