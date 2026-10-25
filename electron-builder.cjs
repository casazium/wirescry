// @ts-check
/**
 * Packaging config for electron-builder.
 *
 * Signing turns on only when its credentials are in the environment, so the same
 * config builds unsigned installers locally and in CI until the secrets exist:
 *
 * - macOS signing: CSC_LINK and CSC_KEY_PASSWORD (Developer ID Application .p12)
 * - macOS notarization: APPLE_API_KEY (path to the .p8 file), APPLE_API_KEY_ID, APPLE_API_ISSUER
 * - Windows signing (Azure Artifact Signing): AZURE_TENANT_ID, AZURE_CLIENT_ID,
 *   AZURE_CLIENT_SECRET, plus AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT,
 *   AZURE_SIGNING_PROFILE and AZURE_SIGNING_PUBLISHER
 *
 * See docs/RELEASING.md.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('electron-builder');

const env = process.env;

/**
 * Refuses to package a build without its license notices, or with Pro's readable source. A build with WIRESCRY_PRO_DIR set puts Pro's
 * backend in out/main/chunks/pro-*.js; scripts/pro-bytecode/compile.mjs must then swap it
 * for bytecode for every architecture being packaged. Set WIRESCRY_REQUIRE_PRO=1 (the
 * release workflow does) to also refuse a build without Pro.
 *
 * @param {import('electron-builder').BeforePackContext} context
 */
function checkBuild(context) {
  if (!fs.existsSync(path.join(__dirname, 'out/licenses/THIRD_PARTY_NOTICES.txt'))) {
    throw new Error('No out/licenses. Build with `npm run build`, which writes the license notices.');
  }
  const chunks = path.join(__dirname, 'out/main/chunks');
  const names = fs.existsSync(chunks) ? fs.readdirSync(chunks) : [];
  const proChunks = names.filter((n) => /^pro-[\w-]+\.js$/.test(n));
  if (proChunks.length === 0) {
    if (env.WIRESCRY_REQUIRE_PRO === '1')
      throw new Error('WIRESCRY_REQUIRE_PRO=1, but this build has no Pro.');
    return;
  }
  if (proChunks.length > 1)
    throw new Error(`More than one Pro chunk in out/main/chunks: ${proChunks.join(', ')}`);
  const chunk = proChunks[0];
  const head = fs.readFileSync(path.join(chunks, chunk), 'utf8').slice(0, 64);
  if (!head.startsWith('/* wirescry-pro-bytecode-loader */')) {
    throw new Error(`${chunk} is Pro's source. Run scripts/pro-bytecode/compile.mjs before packaging.`);
  }
  const arch = Arch[context.arch];
  const jsc = `${chunk.slice(0, -'.js'.length)}.${arch}.jsc`;
  if (!names.includes(jsc)) {
    throw new Error(
      `No Pro bytecode for ${arch} (${jsc}). Run scripts/pro-bytecode/compile.mjs --arch ${arch}.`,
    );
  }
}

const azureSigning =
  env.AZURE_TENANT_ID &&
  env.AZURE_CLIENT_ID &&
  env.AZURE_CLIENT_SECRET &&
  env.AZURE_SIGNING_ENDPOINT &&
  env.AZURE_SIGNING_ACCOUNT &&
  env.AZURE_SIGNING_PROFILE &&
  env.AZURE_SIGNING_PUBLISHER
    ? {
        endpoint: env.AZURE_SIGNING_ENDPOINT,
        codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
        certificateProfileName: env.AZURE_SIGNING_PROFILE,
        publisherName: env.AZURE_SIGNING_PUBLISHER,
      }
    : undefined;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.casazium.wirescry',
  productName: 'Wirescry',
  copyright: 'Copyright © 2026 Bob Casazza',
  directories: {
    output: 'release/${version}',
    buildResources: 'build',
  },
  files: [
    'out/**',
    'package.json',
    '!**/*.map',
    // Shipped as plain files instead (extraResources), so people can read them.
    '!out/licenses/**',
    // Optional Mockttp module for TLS fingerprint mirroring, which we don't use. It needs
    // OpenSSL and can't be built against Electron's BoringSSL; Mockttp works without it.
    '!node_modules/tls-impersonate/**',
  ],
  // No native modules are shipped, so skip rebuilding dependencies for Electron.
  npmRebuild: false,
  // Never ship a CA: each install generates its own at first run, in the user data folder.
  asar: true,
  beforePack: checkBuild,
  // Third-party license notices, from scripts/third-party-notices.mjs.
  extraResources: [{ from: 'out/licenses', to: 'licenses' }],

  // Electron features the app doesn't use, turned off so they can't be used against it
  // or to read Pro's code: running the app as plain Node, NODE_OPTIONS, --inspect, and
  // loading app code from outside the signed, integrity-checked app.asar.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    // The UI is served from the app's own protocol (src/main/app-protocol.ts), not file://.
    grantFileProtocolExtraPrivileges: false,
    // Flipping fuses breaks Electron's ad-hoc signature, and macOS kills an arm64 app whose
    // signature doesn't match. Re-sign ad hoc so unsigned local builds run; release builds
    // are then signed properly over it.
    resetAdHocDarwinSignature: true,
  },

  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      // The zip is what the auto-updater downloads; the dmg is for first installs.
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // Notarizes when APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER are set.
    notarize: true,
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    ...(azureSigning ? { azureSignOptions: azureSigning } : {}),
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },

  linux: {
    category: 'Development',
    // AppImage can auto-update; deb is updated by reinstalling.
    target: ['AppImage', 'deb'],
    maintainer: 'casazium',
  },

  // Release builds and update files go to a public repo, so the app never needs a
  // GitHub token to check for updates. Releases are created as drafts: nothing reaches
  // users until someone publishes the draft on GitHub.
  publish: {
    provider: 'github',
    owner: 'casazium',
    repo: 'wirescry-releases',
    releaseType: 'draft',
    private: false,
  },
};
