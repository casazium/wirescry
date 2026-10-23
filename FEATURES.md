# Wirescry: feature list

Wirescry is a desktop tool for seeing, debugging and rewriting HTTP traffic, in the same space as HTTP Toolkit. It's built with Electron and TypeScript, with Mockttp as the proxy engine.

- **Repo:** `github.com/casazium/wirescry` (not created yet)
- **Team:** Bob, working full-time, with Claude
- **Timings** are cumulative from the start of work. Double them if working about 20 hours a week.
- **Pro** marks paid features. Everything else is free.

## Stage 1: MVP (free) · ~6–8 weeks

### Foundation
- Electron app in three parts: the window, a separate backend process running the proxy, and a React UI. All TypeScript.
- Local API protected by a secret token and origin checks.
- Each install generates its own certificate authority. It can be reset, and the certificate can be exported. A certificate authority is never shipped with the app.
- Installers for macOS, Windows and Linux, with signing, Apple notarization and auto-update.
- Settings storage and local error logging.

### Proxy
- HTTP/1.1, HTTP/2 and HTTPS decryption, using Mockttp.
- WebSocket connections pass through. Viewing their messages comes in Stage 2.
- Automatic port choice, with a manual override.
- Clear errors when an upstream request fails: DNS, TLS, timeout or refused connection.

### Interception
- Detect and launch Chrome, Chromium, Edge and Brave with a fresh profile that trusts the certificate and has QUIC turned off, so traffic stays on HTTP/2.
- The same for Firefox.
- Manual setup page for anything else: proxy address and certificate download.

### Traffic viewer
- Live list that stays fast with thousands of rows: method, status, host, path, type, size and time.
- Text search and quick filters; pause and clear.
- Detail pane with headers, timing and bodies.
- Body decoding for gzip, deflate, brotli and zstd. Formatted views for JSON, HTML, XML, JavaScript, CSS and images, with a hex view as fallback.
- Large bodies stored on disk, not in memory.
- Copy URL and copy as curl.

## Stage 2: Pro v1 · ~4–5 months total

### Interception
- Terminal interceptor for macOS and Linux shells and Windows PowerShell and cmd, covering Node, Python, Ruby, Go, PHP and curl.
- Java startup settings through the terminal interceptor, using `JAVA_TOOL_OPTIONS`.

### Viewer
- WebSocket message view.
- Advanced filters, for example `status>=400` or `host=api.*`.

### Pro
- **Rules engine**
  - Match on method, URL or regex, host, path, query, headers or body.
  - Actions: mock a response, reply from a file, forward to another host, rewrite headers or body, add a delay, time out, drop the connection, or pass through.
  - Rules can be ordered, switched on and off, grouped, and imported and exported.
  - **Status (October 2026):** first slice built, in development builds only.
    - Done: match on method, host and path (with `*`) or a path regex, query parameters, request headers, and body text or JSON fields; mock a response, reply with a file, pass through, forward to another server, rewrite (request and response headers, status, whole bodies), close the connection, or time out, each optionally delayed; order and switch rules on and off; import and export (imported rules arrive switched off); the traffic list shows which rule handled a request.
    - Still to do: find and replace in bodies and JSON edits (need a streaming-safe approach); groups; rules for WebSockets; body matching beyond 64 KB.
- **Breakpoints:** pause a request or a response, edit it, then resume it or reply by hand.
  - **Status (October 2026):** built, in development builds only. Pause rules hold matching requests and/or responses in a Breakpoints tab (with a count badge) to edit and continue, reply by hand, or close. Limits: 50 paused, 5 minutes each, editable bodies up to 256 KB of text.
  - Still to do: header changes on request bodies over 64 KB (blocked by a Mockttp bug that sends the wrong Content-Length), noticing when a paused client gives up, and pausing WebSocket messages.
- **Request composer:** build and send requests, resend a captured request with edits, and keep a history. It should centre on captured traffic, not compete with standalone API clients.
- **HAR import and export**, plus export as code snippets in common languages.
- **Saved sessions:** reopen earlier captures.
- **Advanced proxy settings:**
  - upstream proxy (HTTP, SOCKS or auto-config file)
  - client certificates and a custom root certificate
  - hosts that pass through undecrypted
  - port range and DNS overrides
- **Extra themes** (light and dark stay free).

### Business
- Accounts and licence backend (PocketBase or Node), with sign-in and licence checks that keep working offline for a while.
- Payments (Paddle or Stripe): checkout, receipts and subscription status.
- Pro features locked in the app until a licence is active.
  - **Status (October 2026):** built in Pro. Ed25519-signed licence keys, checked offline, with a 14-day grace period after expiry and a deterrent against turning the clock back; an offline list of withdrawn licences; a Licence tab and lock screens. Still to do: a production signing key, the licence server and payments, online renewal and revocation, seat or machine limits, and protection against patching (bytecode and integrity checks).
- Website, docs and download page.

## Stage 3: Pro v1.5 · ~6–7 months total

### Android and iOS
- Android manual setup: QR code, certificate download and instructions.
- **Pro:** Android automatic setup over USB. It detects phones and emulators, installs the certificate in the system store (including on Android 14 and later), and routes traffic back through the cable.
- iOS manual setup guide.

### Java and Electron
- **Pro:** Java agent covering OkHttp, Apache HttpClient 4 and 5, Netty, Jetty, Java's built-in client and Spring WebClient. Written in Java with ByteBuddy.
- **Pro:** attach the agent to a running Java program picked from a list.
- **Pro:** the terminal interceptor loads the agent automatically.
- Electron app interceptor: launch any Electron app with its traffic sent through the proxy.

### API understanding
- **Pro:** OpenAPI support: load specs from a file or URL, match requests to endpoints, show the docs inline, and check requests and responses against the spec.
- **Pro:** built-in directory of public API specs.
- **Pro:** gRPC and protobuf decoding, using `.proto` files.

## Stage 4: Full parity · ~8–10 months total

- **Pro:** Android VPN companion app (Kotlin, on the Play Store), paired by QR code.
- **Pro:** Docker interceptor: containers started from the terminal, attaching to running containers, and Docker Compose.
- **Pro:** performance analysis: compression and caching advice, plus size and timing tips.
- **Pro:** teams: seats, team billing and an admin dashboard.
- **Optional:** certificate-pinning bypass with Frida.

## Out of scope for now
- Decrypting HTTP/3. Apps are pushed back to HTTP/2 instead.
- Automatic iOS setup.
- A hosted or cloud version.

## Free tier, in summary
- Browser interception: Chrome-family and Firefox.
- Terminal interception: Node, Python, Ruby, Go, PHP and curl, plus Java startup settings.
- Electron app interception.
- Manual setup for Android, iOS and anything else.
- The full traffic viewer: filters, body decoding, WebSocket messages and copy as curl.
- Light and dark themes.

Everything that changes traffic, automates hard setup or explains APIs is Pro.

## Decisions made
- **Name (October 2026): Wirescry**, renamed from the working name Leverframe before anything was public. Leverframe was dropped because two open-source developer tools (one a local proxy) already used it, it sat close to Lever's live software trademark, and leverframe.com was taken.
  - Do-it-yourself checks for Wirescry (October 2026, not a legal clearance): no US, EU or UK trademark for it or close spellings; nothing on the web; no GitHub projects; npm `wirescry`, wirescry.com and wirescry.dev unregistered. One thing for an attorney: a live US **SCRY** mark covers software and SaaS.
- **Stack:** Electron, TypeScript and React, with Mockttp as the proxy engine.
- **Pro:** Android automatic setup, the Docker interceptor and the request composer.
- **Order:** the Java agent comes in Stage 3, after the terminal interceptor. Java has about 23M developers, a similar number to Python's 24M (SlashData, Q3 2025).
- **Licensing (October 2026): open core.**
  - The free app is open source under AGPL-3.0. Bob owns all of its copyright, so it contains no AGPL code from anyone else (including HTTP Toolkit), and outside contributions need a contributor licence agreement (CLA).
  - Pro features live in a separate private module under a commercial licence. The released app includes both, with Pro locked until a licence is active.
  - Pro protection: Pro ships as compiled V8 bytecode; licences are signed by the server and checked offline with a grace period; Electron's integrity checks and code signing catch patched apps. Server-backed Pro features, such as team sharing, add value that can't be cracked.
  - Before the repo goes public: a lawyer reviews the AGPL-plus-commercial builds and the CLA wording.

## Open questions
- When to make the repo public, after the lawyer's review.
- CLA wording, and which tool collects signatures.
- A trademark attorney's view on Wirescry (especially the SCRY mark), then file in the US (classes 9 and 42), and in the UK or EU within six months if selling there.
- Register wirescry.com and wirescry.dev.
