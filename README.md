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

- **Browser:** click **Launch** to open Chrome, Chromium, Edge or Brave with a fresh temporary profile that uses the proxy and trusts Leverframe's certificate. The profile is deleted when the browser closes.
- **curl:**

  ```bash
  curl --proxy http://127.0.0.1:8000 --cacert "$HOME/Library/Application Support/Leverframe/ca.pem" https://example.com/
  ```

  On Linux the certificate is in `~/.config/Leverframe/ca.pem`, and on Windows in `%APPDATA%\Leverframe\ca.pem`.

`npm start` runs the production build without packaging it.

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
- **Local API:** listens on `127.0.0.1` only. Each connection needs the secret token generated at launch, an allowed `Origin`, and a loopback `Host` header (which blocks DNS rebinding).
- **Renderer:** `contextIsolation` and `sandbox` on, `nodeIntegration` off, a strict Content Security Policy, and no navigation, new windows or permission requests. Packaged builds serve the UI from `leverframe://app`.

Captured traffic is split in two:

- `RequestStore` (`src/backend/store.ts`) holds each exchange's summary, headers and timing, in memory.
- `BodyStore` (`src/backend/body-store.ts`) holds bodies. Bodies up to 64 KB stay in memory; larger ones are written to `bodies/` in the user data folder, which is emptied on every start and on Clear. Bodies over 100 MB aren't captured, though the traffic still passes through.

The UI fetches headers and bodies only for the exchange you select. Bodies are decoded (gzip, deflate, brotli, zstd) in the backend, and the UI gets at most the first 5 MB.

## Notes

- `tls-impersonate`, an optional Mockttp dependency for TLS fingerprint mirroring, is not built and not packaged. Mockttp works without it, and Leverframe doesn't use that feature.
