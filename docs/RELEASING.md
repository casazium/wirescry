# Releasing Wirescry

Releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml) and published to the public [casazium/wirescry-releases](https://github.com/casazium/wirescry-releases) repo, which the app's updater reads. The source repo stays private.

## Cutting a release

1. Bump `version` in `package.json` (for example `0.2.0`) and merge it to `main`. The updater compares versions, so every release needs a higher one.
2. Tag the merge commit and push the tag:

   ```bash
   git tag v0.2.0
   ```

   ```bash
   git push origin v0.2.0
   ```

3. The workflow builds on macOS, Windows and Linux with Pro included (from `wirescry-pro`'s `main`), signs what it has secrets for, and uploads everything to a **draft** release in `casazium/wirescry-releases`. The tag must match `package.json`, and Pro must be reachable, or the build stops.
4. Write the release notes in the draft, using the headings below.
5. Download and try the installers from the draft. When they're good, click **Publish release** on GitHub. Only published releases reach users.

Pull requests that change packaging build Linux only; manual runs (**Actions → Release → Run workflow**) build all three. Neither publishes; they keep the installers as workflow artifacts for 3 days. Pull requests always build the free app, so a workflow change in a pull request can't read Pro. A manual run includes Pro, and can build in a different Pro branch or commit (**Pro branch, tag or commit**); its artifacts then contain that Pro, as bytecode.

## Release notes

Write each release's notes in the draft release on `casazium/wirescry-releases`, grouped under these headings, in this order, leaving out any that are empty. The Casazium website's release summary reads them, so keep the headings exactly as written:

```markdown
### Added

### Changed

### Fixed

### Removed

### Deprecated

### Security
```

One line per change, written for users: what they can now do or what was wrong, not how it was done. Mark Pro-only changes with **(Pro)** at the start of the line.

## Secrets and variables

Set these in **casazium/wirescry → Settings → Secrets and variables → Actions**. Each platform signs only when all of its values are set; otherwise it builds unsigned and the run shows a warning.

### Publishing

| Secret           | What                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELEASES_TOKEN` | Fine-grained GitHub token with **Contents: read and write** on `casazium/wirescry-releases` only. Used to upload releases; never built into the app. |

### macOS signing and notarization

Needs an [Apple Developer Program](https://developer.apple.com/programs/) membership.

| Secret             | What                                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`         | Your **Developer ID Application** certificate exported from Keychain as a `.p12`, base64-encoded: `base64 -i cert.p12 \| pbcopy`                                                                                                                |
| `CSC_KEY_PASSWORD` | The password you set when exporting the `.p12`                                                                                                                                                                                                  |
| `APPLE_API_KEY_P8` | Contents of an App Store Connect **Team** API key (`.p8` file), Developer role. Users and Access → Integrations → Team Keys. An Individual key won't work: electron-builder always sends an issuer ID, which Apple rejects for Individual keys. |
| `APPLE_API_KEY_ID` | That key's Key ID                                                                                                                                                                                                                               |
| `APPLE_API_ISSUER` | The Issuer ID shown above the Team Keys list                                                                                                                                                                                                    |

Notarization runs only when the app is also signed.

### Windows signing (Azure Artifact Signing)

Needs a paid Azure subscription and an [Artifact Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/) account with a validated identity and a certificate profile. Create an app registration and give it the **Artifact Signing Certificate Profile Signer** role on the account.

| Secret                | What                                          |
| --------------------- | --------------------------------------------- |
| `AZURE_TENANT_ID`     | Directory (tenant) ID of the app registration |
| `AZURE_CLIENT_ID`     | Application (client) ID                       |
| `AZURE_CLIENT_SECRET` | A client secret for the app registration      |

| Variable (not secret)     | What                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| `AZURE_SIGNING_ENDPOINT`  | The account's region endpoint, for example `https://eus.codesigning.azure.net/` |
| `AZURE_SIGNING_ACCOUNT`   | Artifact Signing account name                                                   |
| `AZURE_SIGNING_PROFILE`   | Certificate profile name                                                        |
| `AZURE_SIGNING_PUBLISHER` | The publisher name on the certificate, exactly as validated                     |

New Windows releases show a SmartScreen warning until they build reputation. No certificate type avoids this since 2024; signing every release with the same identity is what builds it.

### Linux

Nothing to set. AppImage and `.deb` builds aren't signed.

### Pro

The workflow reads the private `casazium/wirescry-pro` repo through the org's **wirescry-ci** GitHub App (the one Pro's own CI uses), with a read-only token that expires within the hour. Tag builds stop if these aren't set; manual runs build the free app without them. Every platform builds the same Pro commit, picked once at the start of the run and shown in the run's summary.

| Name                 | Kind     | What                                         |
| -------------------- | -------- | -------------------------------------------- |
| `CI_APP_ID`          | Variable | The app's App ID                             |
| `CI_APP_PRIVATE_KEY` | Secret   | A private key (`.pem`) generated for the app |

The app must also be installed on `casazium/wirescry-pro`, with **Contents: read-only**: org **Settings → GitHub Apps → wirescry-ci → Configure → Repository access**.

Anyone who can push a branch to this repo and start a manual run could change the workflow on that branch to read Pro. While only the owner can push, that's fine. Before adding collaborators, move `CI_APP_PRIVATE_KEY` into a GitHub **Environment** (for example `release`) that only `main` and `v*` tags can use, and add `environment: release` to the workflow's `pro` job.

## How updates work

- The app checks `casazium/wirescry-releases` 30 seconds after launch and every 6 hours, downloads a newer version in the background, and asks to restart when it's ready. Otherwise it installs on the next quit. **Check for Updates…** (app menu on macOS, Help on Windows and Linux) checks on demand.
- Update files come over HTTPS from GitHub and are verified by SHA-512. On macOS the update must be signed by the same Developer ID as the running app, so **unsigned builds can't update themselves**. On Windows, signed builds check the installer's publisher.
- Updates are off in development, for `.deb` installs (reinstall instead), and when `WIRESCRY_DISABLE_UPDATES` is set.
- Update checks and errors are written to the log (**Help → Show Log File**).

## Building locally

```bash
npm run package
```

Builds unsigned installers for the current platform into `release/<version>/`. To skip looking for a signing certificate in your keychain on macOS, set `CSC_IDENTITY_AUTO_DISCOVERY=false`.

## How Pro is built in

Pro's frontend is bundled like the rest of the UI. Its backend, where licenses are checked, ships as V8 bytecode rather than JavaScript:

1. With `WIRESCRY_PRO_DIR` set, `electron-vite build` puts all of Pro's backend code in one file, `out/main/chunks/pro-<hash>.js`, and fails if any of it lands anywhere else (see `electron.vite.config.ts`).
2. [`scripts/pro-bytecode/compile.mjs`](../scripts/pro-bytecode/compile.mjs) `--arch <list>` minifies that file (renaming Pro's own variables and functions), rewrites arrow functions and class fields, and compiles it to `pro-<hash>.<arch>.jsc` with Electron for each CPU type, then replaces the JavaScript with a small loader that picks the file for the machine it runs on. Bytecode only loads on the CPU type and Electron version that made it, so the other architecture runs emulated: Rosetta on Apple silicon makes x64, and Windows on Arm makes x64 (which is why Windows builds on `windows-11-arm`). x64 machines can't make arm64.
3. `electron-builder.cjs` refuses to package Pro's JavaScript, or a build missing an architecture's bytecode. With `WIRESCRY_REQUIRE_PRO=1`, as on tags, it also refuses a build without Pro.
4. [`scripts/self-test-packaged.mjs`](../scripts/self-test-packaged.mjs) starts each packaged app with `--wirescry-self-test`, which runs the backend without a window, and fails unless Pro loaded and started. (Without a license Pro still starts; it locks its features itself.) On a tag this runs after the upload to the draft release, so if it fails, delete the draft.

If an installed copy can't load the bytecode, Pro turns off, the app runs as the free version, and the reason goes to the log. Step 4 is there so that never reaches a release unnoticed.

The compiler runs Electron without `NODE_OPTIONS` or `ELECTRON_*` variables: V8 flags passed that way would be baked into the bytecode, and the packaged app, which ignores `NODE_OPTIONS`, would then reject it.

Pro's errors in a release build point at `pro-<hash>.<arch>.jsc` with no useful line numbers, and the readable, minified copy isn't kept. To trace one, rebuild the same app and Pro commits locally.

To build a Pro package locally (Apple silicon shown):

```bash
WIRESCRY_PRO_DIR=../wirescry-pro npm run build
```

```bash
node scripts/pro-bytecode/compile.mjs --arch arm64,x64
```

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir
```

Bytecode makes Pro much harder to read or patch, not impossible: V8 bytecode can be decompiled, and anyone who can change the app's code (any Linux install, or a re-signed macOS or Windows copy) can interfere with what Pro calls. The license check doesn't depend on secrecy, since keys are verified against a public key, but treat bytecode as a deterrent, not a lock.

## What else release builds do

- **Electron fuses** (`electronFuses` in `electron-builder.cjs`): the app can't be run as plain Node, ignores `NODE_OPTIONS` and `--inspect`, loads its code only from `app.asar`, and on macOS and Windows checks `app.asar` against a hash built into the signed executable before loading it.
- **License notices**: `npm run build` runs [`scripts/third-party-notices.mjs`](../scripts/third-party-notices.mjs), which writes the licenses of every npm package in the app to `out/licenses/THIRD_PARTY_NOTICES.txt`. It ships in the app's resources folder, under `licenses/`, with Electron's and Chromium's licenses on macOS (Windows and Linux builds have those in the install folder already). Packaging stops if the notices are missing or older than the build.
