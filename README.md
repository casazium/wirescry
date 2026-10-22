# Leverframe

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

This opens the Leverframe window with hot reload. The toolbar shows the proxy port (usually `8000`), and requests appear in the list as they pass through.

The list stays fast with thousands of requests and keeps the most recent 10,000. Search with Cmd/Ctrl+F, narrow it with the quick filters (JSON, HTML, Errors and so on), and use **Pause** to let traffic through without recording it. Click a request, or use the arrow keys, to see its headers and bodies.

To send traffic through it:

- **Chrome, Chromium, Edge or Brave:** click **Launch** to open the browser with a fresh temporary profile that uses the proxy and trusts Leverframe's certificate. The profile is deleted when the browser closes.
- **Firefox:** Firefox can't be told to trust a certificate from the command line, so Leverframe keeps its own Firefox profile in the user data folder. The first launch opens a setup page at `http://leverframe.internal/` (answered by the proxy itself) where you trust the certificate once. Later launches go straight to browsing.
- **Anything else:** the **Setup** view shows the proxy address, a **Save certificate…** button, and shell variables for curl, Node.js and Python.
- **curl:**

  ```bash
  curl --proxy http://127.0.0.1:8000 --cacert "$HOME/Library/Application Support/Leverframe/ca.pem" https://example.com/
  ```

  On Linux the certificate is in `~/.config/Leverframe/ca.pem`, and on Windows in `%APPDATA%\Leverframe\ca.pem`.

The **Setup** view also lets you fix the proxy port (it's otherwise picked automatically, starting at 8000) and reset the certificate, which creates a new one and removes the Firefox profile.

`npm start` runs the production build without packaging it.

### When requests fail

If the real server can't be reached, the request's Status shows why: **DNS**, **Refused**, **TLS**, **Timeout**, **Reset**, **No route**, or **Closed** (the client gave up first). The detail pane explains the problem in plain language, with the original error. The client receives a 502 from Leverframe in these cases. Leverframe doesn't impose its own response timeout, so long-polling and other slow responses keep working; a request still waiting just shows `…`.

WebSocket connections pass through and show in the list with status 101 and type `websocket`. Viewing their messages comes later.

### Logs

Errors and warnings from the window, the backend and the UI are written to `leverframe.log` (**Help → Show Log File**):

- macOS: `~/Library/Logs/Leverframe/`
- Windows: `%APPDATA%\Leverframe\logs\`
- Linux: `~/.config/Leverframe/logs/`

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

Builds installers for the current platform into `release/`. Use `package:mac`, `package:win` or `package:linux` for a specific one. Signing, notarization and auto-update are TODOs in [electron-builder.yml](electron-builder.yml).

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
- **Proxy:** only accepts connections from this computer. Mockttp listens on every network interface and has no setting to change that, so Leverframe drops connections from other machines as they arrive. A fixed port is checked on `127.0.0.1` first, so another program already listening there can't silently receive the traffic.
- **Local API:** listens on `127.0.0.1` only. Each connection needs the secret token generated at launch, an allowed `Origin`, and a loopback `Host` header (which blocks DNS rebinding).
- **Renderer:** `contextIsolation` and `sandbox` on, `nodeIntegration` off, a strict Content Security Policy, and no navigation, new windows or permission requests. Packaged builds serve the UI from `leverframe://app`.

Captured traffic is split in two:

- `RequestStore` (`src/backend/store.ts`) holds each exchange's summary, headers and timing, in memory.
- `BodyStore` (`src/backend/body-store.ts`) holds bodies. Bodies up to 64 KB stay in memory; larger ones are written to `bodies/` in the user data folder, which is emptied on every start and on Clear. Bodies over 100 MB aren't captured, though the traffic still passes through.

The UI fetches headers and bodies only for the exchange you select. Bodies are decoded (gzip, deflate, brotli, zstd) in the backend, and the UI gets at most the first 5 MB.

## Notes

- `tls-impersonate`, an optional Mockttp dependency for TLS fingerprint mirroring, is not built and not packaged. Mockttp works without it, and Leverframe doesn't use that feature.
