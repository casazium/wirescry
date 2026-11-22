# Wirescry: feature list

Wirescry is a desktop tool for seeing, debugging and rewriting HTTP traffic, in the same space as HTTP Toolkit. It's built with Electron and TypeScript, with Mockttp as the proxy engine.

- **Repo:** `github.com/casazium/wirescry` (public since launch on November 1, 2026, under AGPL-3.0). Pro is in the private `casazium/wirescry-pro`.
- **Team:** Bob, working full-time, with Claude
- **Timings** are cumulative from the start of work. Double them if working about 20 hours a week.
- **Pro** marks paid features. Everything else is free.

## Status

**Checked November 20, 2026, against `main` at v0.1.37 and `wirescry-pro` `main`; updated November 22 for v0.1.39 (redaction, Hide Secrets and the MCP server).** The check covered the source, the two READMEs and the commit history. It did not cover hands-on use. Each item below is marked:

- **Shipped:** in release builds.
- **Partly:** shipped, with the gaps listed.
- **Not started:** no code found.

Stages 1 and 2 are mostly shipped, and most of Stage 3 too. Android, Java and Docker setup shipped in the free app, as [PRICING.md](https://github.com/casazium/wirescry-pro/blob/main/docs/PRICING.md) recommended.

**Left to do, in roadmap order:**
- MCP tools that change traffic (Pro), behind approval in the app
- Rules: find and replace and JSON edits, groups, WebSocket rules, and body matching beyond 64 KB
- Breakpoints: large request bodies, noticing a client that gives up, and WebSocket messages
- Saved sessions
- Advanced proxy settings
- Extra themes
- Monthly plans and team seats
- Android certificate in the system store
- iOS setup guide
- Electron app interceptor
- Swagger 2.0 support
- Directory of public API specs
- Docker: attaching to running containers
- Android VPN app
- Performance analysis
- Teams
- Frida

## Stage 1: MVP (free) · ~6–8 weeks · Shipped

Launched as 0.1.1 on November 1, 2026.

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
- Terminal interceptor for macOS and Linux shells and Windows PowerShell and cmd, covering Node, Python, Ruby, Go, PHP and curl. **Shipped**, with git added. Known gaps: the Python and Ruby built into macOS ignore the certificate setting, and Go on Windows reads only the Windows certificate store.
- Java startup settings through the terminal interceptor, using `JAVA_TOOL_OPTIONS`. **Shipped.**

### Viewer
- WebSocket message view. **Shipped:**
  - shows direction, timing, size and content, with search and a sent/received filter
  - keeps up to 64 KB per message and 64 MB in total
- Advanced filters, for example `status>=400` or `host=api.*`. **Shipped** as the search box's query language:
  - `=`, `!=`, `~`, comparisons and `status=4xx`
  - negation with `-` and quoted terms
  - fields for size, time, gRPC status and rule
- Redaction of secrets (free). **Shipped** in 0.1.39:
  - Export HAR redacts secrets by default (headers, cookies, URLs, and bodies best effort), with a notice of what was redacted; Export HAR Without Redaction writes everything
  - View → Hide Secrets masks the list, details, bodies (Hex too), WebSocket messages and Server-Sent Events on screen; Copy copies what's shown
  - one set of rules, plus values seen in any request's URL or headers, for export, the screen and MCP

### AI agents
- **MCP server for AI coding agents** (free, read-only). **Shipped** in 0.1.39:
  - Streamable HTTP on 127.0.0.1, off by default, with a token; refuses web pages
  - tools to list requests and read headers, bodies, WebSocket messages and Server-Sent Events, always masked
  - Setup section with settings for Claude Code, Cursor and VS Code, recent calls, and an "Agent active" badge
- **MCP tools that change traffic** (Pro): create and toggle rules, set breakpoints, read decoded gRPC and API-spec results, each needing approval in the app. **Not started.**
- **A stdio command** for MCP clients that can't use HTTP. **Not started.**

### Pro
- **Rules engine**: **Partly.**
  - Match on method, URL or regex, host, path, query, headers or body.
  - Actions: mock a response, reply from a file, forward to another host, rewrite headers or body, add a delay, time out, drop the connection, or pass through.
  - Rules can be ordered, switched on and off, grouped, and imported and exported.
  - Shipped:
    - Matching: method, host and path (with `*`) or a path regex, query parameters, request headers, and body text or JSON fields.
    - Actions: mock a response, reply with a file, pass through, forward to another server, rewrite (request and response headers, status, whole bodies), close the connection, or time out, each optionally delayed.
    - Management: rules can be ordered, switched on and off, imported and exported (imported rules arrive switched off).
    - The traffic list shows which rule handled a request, and gRPC rules exist too.
  - Still to do:
    - find and replace in bodies and JSON edits (they need a streaming-safe approach)
    - groups
    - rules for WebSockets
    - body matching beyond 64 KB
- **Breakpoints:** pause a request or a response, edit it, then resume it or reply by hand. **Partly:**
  - Shipped:
    - Pause rules hold matching requests and responses in a Breakpoints tab, with a count badge, to edit and continue, reply by hand, or close.
    - gRPC messages can be paused and edited too.
    - Limits: 50 paused, 5 minutes each, editable bodies up to 256 KB of text.
  - Still to do:
    - header changes on request bodies over 64 KB (blocked by a Mockttp bug that sends the wrong Content-Length)
    - noticing when a paused client gives up
    - pausing WebSocket messages
- **Request composer:** build and send requests, resend a captured request with edits, and keep a history. It should center on captured traffic, not compete with standalone API clients. **Shipped** in 0.1.14:
  - free: basic sending
  - Pro: saved requests, variables, and composing from OpenAPI specs and gRPC schemas
- **HAR import and export**, plus export as code snippets in common languages. **Shipped:**
  - HAR import and export are free
  - Copy as curl is free
  - the composer's "Copy as" (fetch, Python requests, HTTPie) is Pro
- **Saved sessions:** reopen earlier captures. **Not started.** HAR export and import is the workaround.
- **Advanced proxy settings:** **Not started.**
  - upstream proxy (HTTP, SOCKS or auto-config file)
  - client certificates and a custom root certificate
  - hosts that pass through undecrypted
  - port range and DNS overrides
- **Extra themes** (light and dark stay free). **Not started.** Light and dark follow the system.

### Business
- Accounts and license backend (PocketBase or Node), with sign-in and license checks that keep working offline for a while.
- Payments (Paddle or Stripe): checkout, receipts and subscription status.
- Pro features locked in the app until a license is active.
- **Status: Partly.**
  - Shipped, on the Casazium License Server:
    - keys bought through Stripe (live since launch, with a 14-day trial), activated on up to 3 computers
    - checked daily and when Pro starts, and working offline for 14 days
    - a perpetual fallback for versions released while a subscription was paid up
    - a License tab to activate, check and move computers
    - release builds ship Pro's backend as V8 bytecode with Electron's integrity checks on
  - Still to do:
    - monthly plans and team seats
    - activating an ended, paid-up license on a new computer (the License Server refuses ended keys)
- Website, docs and download page. **Shipped** (casazium.com/wirescry and docs.casazium.com/docs/wirescry).

## Stage 3: Pro v1.5 · ~6–7 months total

### Android and iOS
- Android manual setup: QR code, certificate download and instructions. **Shipped** in a different form: **Setup → Android** sets the proxy on a phone or emulator connected over USB or Wi-Fi with adb, copies the certificate to it and opens the steps to install it, checks in Chrome that it's trusted, and puts the proxy back when you stop. Android 7 and later. No QR code.
- **Pro:** Android automatic setup over USB. It detects phones and emulators, installs the certificate in the system store (including on Android 14 and later), and routes traffic back through the cable. **Partly**, and in the free app:
  - Shipped: detecting devices and setting the proxy.
  - Still to do: putting the certificate in the system store. Today it goes in the user store, through Settings, which apps don't trust by default.
- iOS manual setup guide. **Not started**: no docs page.

### Java and Electron
- **Pro:** Java agent covering OkHttp, Apache HttpClient 4 and 5, Netty, Jetty, Java's built-in client and Spring WebClient. Written in Java with ByteBuddy. **Shipped**, in the free app:
  - Clients covered: `HttpURLConnection`, Java's `HttpClient`, OkHttp, Apache HttpClient 4 and 5, Jetty's `HttpClient` 9.4.25 and later, and Reactor Netty 1.0 to 1.3 (so Spring's `WebClient`).
  - Java 8 and later.
- **Pro:** attach the agent to a running Java program picked from a list. **Shipped** in the free app. It needs JDK 17 or later on the computer (11 on Windows).
- **Pro:** the terminal interceptor loads the agent automatically. **Shipped** in the free app.
- Electron app interceptor: launch any Electron app with its traffic sent through the proxy. **Not started.**

### API understanding
- **Pro:** OpenAPI support: load specs from a file or URL, match requests to endpoints, show the docs inline, and check requests and responses against the spec. **Shipped**:
  - OpenAPI 3.0, 3.1 and 3.2, in JSON or YAML
  - up to 20 specs
  - Swagger 2.0 isn't supported yet
- **Pro:** built-in directory of public API specs. **Not started.**
- **Pro:** gRPC and protobuf decoding, using `.proto` files. **Shipped**:
  - Decoding works with `.proto` schemas or server reflection.
  - Calls can be composed, and captured calls edited and resent.
  - gRPC rules and breakpoints are included.

## Stage 4: Full parity · ~8–10 months total

- **Pro:** Android VPN companion app (Kotlin, on the Play Store), paired by QR code. **Not started.**
- **Pro:** Docker interceptor: containers started from the terminal, attaching to running containers, and Docker Compose. **Partly**, and in the free app:
  - Shipped: `docker run` and `docker compose up` from a Wirescry terminal, through a relay for the Docker API. This works with Docker Desktop on macOS, Windows and Linux, and with Docker Engine on Linux.
  - Still to do: attaching to containers that are already running.
- **Pro:** performance analysis: compression and caching advice, plus size and timing tips. **Not started.**
- **Pro:** teams: seats, team billing and an admin dashboard. **Not started.**
- **Optional:** certificate-pinning bypass with Frida. **Not started.**

## Out of scope for now
- Decrypting HTTP/3. Apps are pushed back to HTTP/2 instead.
- Automatic iOS setup.
- A hosted or cloud version.

## Free tier, in summary
- Browser interception: Chrome-family and Firefox.
- Terminal interception: Node, Python, Ruby, Go, PHP, curl and git, plus Java startup settings.
- Java agent setup, including attaching to running programs.
- Docker containers started from a Wirescry terminal.
- Android setup over adb.
- Electron app interception (not started).
- Manual setup for anything else. An iOS guide is not written yet.
- The full traffic viewer: filters, body decoding, WebSocket messages, HAR import and export, and copy as curl.
- Basic request sending in the composer.
- Light and dark themes.

Everything that changes traffic or explains APIs is Pro. Setup automation was planned as Pro but shipped free, as in HTTP Toolkit.

## Decisions made
- **Name (October 2026): Wirescry**, renamed from the working name Leverframe before anything was public. Leverframe was dropped because two open-source developer tools (one a local proxy) already used it, it sat close to Lever's live software trademark, and leverframe.com was taken.
  - Do-it-yourself checks for Wirescry (October 2026, not a legal clearance): no US, EU or UK trademark for it or close spellings; nothing on the web; no GitHub projects; npm `wirescry`, wirescry.com and wirescry.dev unregistered. One thing for an attorney: a live US **SCRY** mark covers software and SaaS.
- **Stack:** Electron, TypeScript and React, with Mockttp as the proxy engine.
- **Pro:** the request composer's saved requests, variables and "Copy as". Android, Java and Docker setup were planned as Pro but shipped in the free app, as [PRICING.md](https://github.com/casazium/wirescry-pro/blob/main/docs/PRICING.md) recommended, since HTTP Toolkit gives them away.
- **Order:** the Java agent comes in Stage 3, after the terminal interceptor. Java has about 23M developers, a similar number to Python's 24M (SlashData, Q3 2025).
- **Licensing (October 2026): open core.**
  - The free app is open source under AGPL-3.0. Bob owns all of its copyright, so it contains no AGPL code from anyone else (including HTTP Toolkit), and outside contributions need a contributor license agreement (CLA).
  - Pro features live in a separate private module under a commercial license. The released app includes both, with Pro locked until a license is active.
  - Pro protection: Pro ships as compiled V8 bytecode; licenses are signed by the server and checked offline with a grace period; Electron's integrity checks and code signing catch patched apps. Server-backed Pro features, such as team sharing, add value that can't be cracked.
- **No lawyer review (October 30, 2026).** Bob decided against a lawyer's review and a formal name clearance search; wirescry.com is registered. The repo went public at launch.

## Open questions
- CLA wording, and which tool collects signatures.
- Whether to file a trademark for Wirescry: US classes 9 and 42, and the UK or EU within six months if selling there.
