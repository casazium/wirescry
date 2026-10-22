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

const env = process.env;

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
  appId: 'com.casazium.leverframe',
  productName: 'Leverframe',
  copyright: 'Copyright © 2026 casazium',
  directories: {
    output: 'release/${version}',
    buildResources: 'build',
  },
  files: [
    'out/**',
    'package.json',
    '!**/*.map',
    // Optional Mockttp module for TLS fingerprint mirroring, which we don't use. It needs
    // OpenSSL and can't be built against Electron's BoringSSL; Mockttp works without it.
    '!node_modules/tls-impersonate/**',
  ],
  // No native modules are shipped, so skip rebuilding dependencies for Electron.
  npmRebuild: false,
  // Never ship a CA: each install generates its own at first run, in the user data folder.
  asar: true,

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
    repo: 'leverframe-releases',
    releaseType: 'draft',
    private: false,
  },
};
