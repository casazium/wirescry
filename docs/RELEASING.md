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

3. The workflow builds on macOS, Windows and Linux, signs what it has secrets for, and uploads everything to a **draft** release in `casazium/wirescry-releases`. The tag must match `package.json`, or the build stops.
4. Download and try the installers from the draft. When they're good, click **Publish release** on GitHub. Only published releases reach users.

Pull requests that change packaging, and manual runs (**Actions → Release → Run workflow**), build the same installers without publishing and keep them as workflow artifacts for 7 days.

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

## Pro in releases: not yet

Releases are built from this repo alone, so they include only the free app. Pro (the private `wirescry-pro` repo) isn't in any release yet, and shouldn't be until these are in place:

- ~~License checks~~: done, in Pro (signed keys checked offline; see its README). Still needed: a production signing key, and a way to sell and deliver keys.
- Pro compiled to V8 bytecode, and Electron's fuses and integrity checks turned on.
- The release workflow checking out `wirescry-pro` (through the `wirescry-ci` GitHub App that Pro's own CI uses) and building with `WIRESCRY_PRO_DIR` and `WIRESCRY_ALLOW_PRO_BUILD` set.
