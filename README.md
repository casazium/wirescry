# Wirescry

A desktop tool for seeing, debugging and rewriting HTTP traffic. Built with Electron, TypeScript and React, with [Mockttp](https://github.com/httptoolkit/mockttp) as the proxy engine.

This is an early Stage 1 skeleton. See [FEATURES.md](FEATURES.md) for the full plan.

## Requirements

- Node.js 22.12 or later (tested with Node 26 and npm 11)
- macOS, Windows or Linux

## Install

```bash
npm install
```

Electron downloads its binary the first time it runs, so the first `npm run dev` takes a little longer.

## Run

```bash
npm run dev
```

This opens the Wirescry window with hot reload. The toolbar shows the proxy port (usually `8000`), and requests appear in the list as they pass through.

The list stays fast with thousands of requests and keeps the most recent 10,000. Search with Cmd/Ctrl+F, narrow it with the quick filters (JSON, HTML, Errors and so on) or field filters in the search box such as `status>=400`, `status=5xx`, `method=POST`, `host=api.*`, `path~login`, `size>1mb`, `time>500ms` or `-host=*.google.com` (the **?** button lists them), and use **Pause** to let traffic through without recording it. Click a request, or use the arrow keys, to see its headers and bodies.

To send traffic through it:

- **Chrome, Chromium, Edge or Brave:** click **Launch** to open the browser with a fresh temporary profile that uses the proxy and trusts Wirescry's certificate. The profile is deleted when the browser closes.
- **Firefox:** Firefox can't be told to trust a certificate from the command line, so Wirescry keeps its own Firefox profile in the user data folder. The first launch opens a setup page at `http://wirescry.internal/` (answered by the proxy itself) where you trust the certificate once. Later launches go straight to browsing.
- **Terminals:** **Setup → Terminals** opens Terminal or iTerm (macOS), PowerShell or Command Prompt (Windows), or your terminal (Linux) with variables that send Node.js, Python, Ruby, Go, PHP, Java, curl and git through Wirescry. The same variables are shown for bash, zsh, fish, PowerShell and cmd, to paste into a terminal that's already open. They point tools at a CA bundle (`ca-bundle.pem` in the user data folder) holding Wirescry's CA plus the usual public and system roots. Java gets `JAVA_TOOL_OPTIONS` with proxy settings and a JKS trust store holding the same certificates (Java can't read PEM bundles). PHP gets an extra `.ini` (through `PHP_INI_SCAN_DIR`) that points its curl and OpenSSL settings at the bundle. On Windows, `curl.exe` ignores `CURL_CA_BUNDLE`, so terminals there point `CURL_HOME` at a Wirescry curl config that sets the CA and turns off revocation checks (a local CA has nowhere to publish revocation lists); your own `_curlrc` isn't read in those terminals. Known gaps: the Python and Ruby built into macOS ignore the certificate setting, and Go on Windows reads only the Windows certificate store.
- **Anything else:** the **Setup** view shows the proxy address and a **Save certificate…** button.
- **curl:**

  ```bash
  curl --proxy http://127.0.0.1:8000 --cacert "$HOME/Library/Application Support/Wirescry/ca.pem" https://example.com/
  ```

  On Linux the certificate is in `~/.config/Wirescry/ca.pem`, and on Windows in `%APPDATA%\Wirescry\ca.pem`.

The **Setup** view also lets you fix the proxy port (it's otherwise picked automatically, starting at 8000) and reset the certificate, which creates a new one and removes the Firefox profile.

`npm start` runs the production build without packaging it.

### When requests fail

If the real server can't be reached, the request's Status shows why: **DNS**, **Refused**, **TLS**, **Timeout**, **Reset**, **No route**, or **Closed** (the client gave up first). The detail pane explains the problem in plain language, with the original error. The client receives a 502 from Wirescry in these cases. Wirescry doesn't impose its own response timeout, so long-polling and other slow responses keep working; a request still waiting just shows `…`.

WebSocket connections show in the list with status 101 and type `websocket`. Select one to see its messages live: direction, time since the connection opened, size and content, with JSON formatted and binary shown as hex. Filter by sent or received, or search the text. Messages are kept in memory, at most 64 KB of each and 64 MB in total; the oldest are dropped first, and the view says when.

### Logs

Errors and warnings from the window, the backend and the UI are written to `wirescry.log` (**Help → Show Log File**):

- macOS: `~/Library/Logs/Wirescry/`
- Windows: `%APPDATA%\Wirescry\logs\`
- Linux: `~/.config/Wirescry/logs/`

The file is readable only by you, starts over past 5 MB (keeping one previous file), and never contains the API token. It does include hostnames of requests that failed.

## Test and check

```bash
npm test
```

```bash
npm run lint
```

```bash
npm run typecheck
```

```bash
npm run format:check
```

The backend tests start the real proxy and API, push an HTTPS request through the proxy to a local server, and check that it streams to an API client. They also check that the API rejects a missing or wrong token, other origins and non-loopback hosts.

## Package

```bash
npm run package
```

Builds unsigned installers for the current platform into `release/`. Use `package:mac`, `package:win` or `package:linux` for a specific one.

Signed releases, notarization and auto-update are handled by the release workflow; see [docs/RELEASING.md](docs/RELEASING.md).

## Plugins and Pro

Pro features live in a separate, private repo (`wirescry-pro`) and plug into the app through `src/plugin-api`:

- **Backend plugins** run in the backend process. They get a data folder, can add proxy rules that run after Wirescry's setup page and before normal pass-through, handle calls from their UI, and send it events. Their rules can use Wirescry's own pass-through step, optionally with Mockttp's request and response transforms (to forward or rewrite) or its `beforeRequest` and `beforeResponse` callbacks (to pause, for breakpoints).
- **UI plugins** add views as toolbar tabs. They can also save and open files, always through a system dialog where the user picks the file (up to 16 MB), for example to export and import rules, and put a short badge on their tabs (such as how many requests are paused).

The build uses the empty stubs in `src/pro-stub` unless `WIRESCRY_PRO_DIR` points at a `wirescry-pro` checkout, usually next to this one:

```bash
WIRESCRY_PRO_DIR=../wirescry-pro npm run dev
```

How plugins are kept in line (`src/backend/plugin-host.ts`):

- A plugin declares the `PLUGIN_API_VERSION` it was built for, and isn't loaded with any other. Bump the version for breaking changes to `src/plugin-api`.
- A plugin that throws, or takes more than 10 seconds to start, is marked as failed, and its rules are removed. Calls to it are refused, and it can't add rules back. Other plugins and the free features keep working.
- Plugin rules keep only their matchers and steps, so they can't jump ahead of the setup page. Requests a plugin rule handled show a **Rule** badge, and `rule=` finds them in the search box.
- A view that crashes shows an error in its tab, not a blank app.

Plugins always start. Pro checks its own license, in Pro's code rather than this open-source app: without a valid license it applies no rules and pauses nothing, and its tabs ask for a license key. Development builds run Pro without a license; that's decided when the app is built, so release builds don't have the shortcut. Set `WIRESCRY_PRO_DIR` when running tests to include `test/pro-integration.test.ts`, which runs the real Pro module in the backend.

With `WIRESCRY_PRO_DIR` set:

- `npm run typecheck:pro` typechecks the app with Pro in place of the stubs. Run it after changing `src/plugin-api`.
- A production build (`npm run build`, `npm run package`) stops with an error, because Pro isn't ready to ship and its source would be readable in the bundle. `WIRESCRY_ALLOW_PRO_BUILD=1` overrides this for a local test build that must not be shared.

## How it fits together

| Part         | Folder         | Job                                                                                       |
| ------------ | -------------- | ----------------------------------------------------------------------------------------- |
| Main process | `src/main`     | Window, menu, app protocol, and starting and restarting the backend                       |
| Backend      | `src/backend`  | Runs in its own Electron utility process: CA, Mockttp proxy, local API, browser launching |
| Preload      | `src/preload`  | Gives the UI one thing: how to reach the backend                                          |
| UI           | `src/renderer` | React app (Vite) that talks to the backend over a WebSocket                               |
| Shared       | `src/shared`   | Types used by more than one part                                                          |

Security basics:

- **Certificate authority:** each install creates its own CA on first run, stored in the app's user data folder (`ca.key` is readable only by the user). No CA ships with the app.
- **Proxy:** only accepts connections from this computer. Mockttp listens on every network interface and has no setting to change that, so Wirescry drops connections from other machines as they arrive. A fixed port is checked on `127.0.0.1` first, so another program already listening there can't silently receive the traffic.
- **Local API:** listens on `127.0.0.1` only. Each connection needs the secret token generated at launch, an allowed `Origin`, and a loopback `Host` header (which blocks DNS rebinding).
- **Renderer:** `contextIsolation` and `sandbox` on, `nodeIntegration` off, a strict Content Security Policy, and no navigation, new windows or permission requests. Packaged builds serve the UI from `wirescry://app`.

Captured traffic is split in two:

- `RequestStore` (`src/backend/store.ts`) holds each exchange's summary, headers and timing, in memory.
- `BodyStore` (`src/backend/body-store.ts`) holds bodies. They stream in chunk by chunk as they pass through the proxy: up to 64 KB stays in memory, and anything larger goes straight to a file in `bodies/` in the user data folder, so a large body is never held in memory whole. The folder is emptied on every start and on Clear. Each body keeps up to 512 MB; past that the size is still counted and the traffic still passes through.

The UI fetches headers and bodies only for the exchange you select. Bodies are decoded (gzip, deflate, brotli, zstd) as a stream in the backend, which stops once it has the first 5 MB the UI shows. HTML, XML, JavaScript and CSS bodies up to 2 MB are pretty-printed by js-beautify and xml-formatter in a worker thread, so formatting a large file never stalls the proxy.

## Notes

- `tls-impersonate`, an optional Mockttp dependency for TLS fingerprint mirroring, is not built and not packaged. Mockttp works without it, and Wirescry doesn't use that feature.

## License

Wirescry's free app is open source under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). Copyright © 2026 Bob Casazza.

Wirescry Pro features are developed separately and aren't covered by this license. Released builds of Wirescry include them, locked until a Pro license is active.

Contributions will need a contributor license agreement, so the project can keep offering combined builds with Pro. Details will be here before outside contributions are accepted.
