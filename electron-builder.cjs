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

// Third-party license notices, from scripts/third-party-notices.mjs. Windows and Linux
// builds already carry Electron's own license files; electron-builder removes them from
// macOS builds, so those get the copies in out/licenses-electron.
const notices = { from: 'out/licenses', to: 'licenses' };
const electronNotices = { from: 'out/licenses-electron', to: 'licenses' };

/**
 * Refuses to package a build without up-to-date license notices, or with Pro's readable
 * source. A build with WIRESCRY_PRO_DIR set puts Pro's backend in out/main/chunks/pro-*.js
 * (and leaves out/main/.pro-build); scripts/pro-bytecode/compile.mjs must then swap it
 * for bytecode for every architecture being packaged. Set WIRESCRY_REQUIRE_PRO=1 (the
 * release workflow does) to also refuse a build without Pro.
 *
 * @param {import('electron-builder').BeforePackContext} context
 */
function checkBuild(context) {
  const out = path.join(__dirname, 'out');
  const notices = path.join(out, 'licenses/THIRD_PARTY_NOTICES.txt');
  const built = path.join(out, 'main/backend.js');
  // The notices script deletes the .bundled-packages.json files the build leaves.
  const unlisted = ['main', 'preload', 'renderer'].some((part) =>
    fs.existsSync(path.join(out, part, '.bundled-packages.json')),
  );
  if (
    !fs.existsSync(notices) ||
    !fs.existsSync(built) ||
    unlisted ||
    fs.statSync(notices).mtimeMs < fs.statSync(built).mtimeMs
  ) {
    throw new Error('Missing or old license notices. Build with `npm run build`, which writes them.');
  }
  const chunks = path.join(out, 'main/chunks');
  const names = fs.existsSync(chunks) ? fs.readdirSync(chunks) : [];
  const proChunks = names.filter((n) => /^pro-[\w-]+\.js$/.test(n));
  const proBuild = fs.existsSync(path.join(out, 'main/.pro-build'));
  if (proChunks.length === 0) {
    if (proBuild) throw new Error('This is a Pro build, but its Pro chunk is missing.');
    if (env.WIRESCRY_REQUIRE_PRO === '1')
      throw new Error('WIRESCRY_REQUIRE_PRO=1, but this build has no Pro.');
    return;
  }
  if (!proBuild) throw new Error('A Pro chunk without out/main/.pro-build: delete out/ and build again.');
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

/**
 * Who a signed Windows build accepts updates from. The updater checks each downloaded
 * installer's certificate and refuses it unless it matches one of these. An entry with
 * `=` is a distinguished name, and every field in it must match (Windows writes the
 * state as `S=`, not `ST=`). A plain name matches the certificate's CN alone, which any
 * publicly trusted certificate with that CN would pass, so known identities are pinned
 * by DN.
 *
 * Signing may move from the individual identity to the Casazium organization one, once
 * Microsoft validates it. Installed copies must already accept the new identity before
 * the first release signed with it, or they'll refuse that update. 'Casazium' below is a
 * placeholder: the real certificate's CN is the validated legal name, which may differ.
 * Before switching, replace it with the exact DN from a test-signed build and ship a
 * release with it. Remove an entry only when no supported version still needs to update
 * to a build signed with it.
 */
const ROBERT_CASAZZA = 'CN=Robert Casazza, O=Robert Casazza, C=US';
const windowsPublishers = azureSigning
  ? [
      ...new Set([
        env.AZURE_SIGNING_PUBLISHER === 'Robert Casazza' ? ROBERT_CASAZZA : env.AZURE_SIGNING_PUBLISHER,
        ROBERT_CASAZZA,
        'Casazium',
      ]),
    ]
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
    '!out/licenses*/**',
    '!out/main/.pro-build',
    // Optional Mockttp module for TLS fingerprint mirroring, which we don't use. It needs
    // OpenSSL and can't be built against Electron's BoringSSL; Mockttp works without it.
    '!node_modules/tls-impersonate/**',
  ],
  // No native modules are shipped, so skip rebuilding dependencies for Electron.
  npmRebuild: false,
  // The AppImage launcher (the program at the start of the file). The default, legacy one
  // needs FUSE 2, which Ubuntu hasn't installed by default since 22.04, and for arm64 also
  // libz.so, which only zlib's developer package provides: on a stock install the AppImage
  // didn't start. The newer one is static and uses the system's FUSE 3. Its AppRun falls back
  // to --no-sandbox where user namespaces are blocked. check-appimage.mjs checks it in CI.
  toolsets: { appimage: '1.0.3' },
  // Never ship a CA: each install generates its own at first run, in the user data folder.
  asar: true,
  beforePack: checkBuild,
  // Signs and notarizes each macOS .dmg when the build is signed and notarized.
  artifactBuildCompleted: './scripts/notarize-dmg.cjs',

  // Electron features the app doesn't use, turned off so they can't be used against it
  // or to read Pro's code: running the app as plain Node, NODE_OPTIONS, --inspect, and
  // loading app code from outside the signed, integrity-checked app.asar.
  electronFuses: {
    runAsNode: false,
    // Would tie the app to the system keychain (and prompt on Linux) to protect cookies,
    // which it doesn't use.
    enableCookieEncryption: false,
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
    extraResources: [notices, electronNotices],
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

  dmg: {
    // The updater downloads the zip, so the .dmg stays out of latest-mac.yml (and gets no
    // blockmap). scripts/notarize-dmg.cjs changes the .dmg after it's built, which would
    // leave both out of date.
    writeUpdateInfo: false,
  },

  win: {
    extraResources: [notices],
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    ...(azureSigning ? { azureSignOptions: azureSigning } : {}),
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },

  linux: {
    extraResources: [notices],
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
    // Written into the app's app-update.yml; only the Windows updater reads it. Set only
    // for Azure-signed builds, as before: electron-builder otherwise fills in the one
    // name in azureSignOptions.publisherName.
    ...(windowsPublishers ? { publisherName: windowsPublishers } : {}),
  },
};
