# Wirescry's Java agent

The agent makes a Java program send its HTTP and HTTPS traffic through Wirescry, either from the start (`-javaagent:`) or by attaching to a program that's already running.

**License:** everything in this folder is under the Apache License 2.0 (see LICENSE). It isn't AGPL, unlike the rest of Wirescry, because the agent runs inside other people's programs.

## Layout

| Folder    | Jar                                              | Runs on | What it does                                                                                                                                                                                                                                                                                                           |
| --------- | ------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stub/`   | `wirescry-agent.jar`                             | Java 8+ | The jar that `-javaagent:` and the Attach API name. It lives at a path that never changes (`<data folder>/java-agent/`). It reads the name of the implementation jar from the control file, checks file permissions, adds that jar to the system class loader and starts it. It never throws.                          |
| `impl/`   | `wirescry-agent-impl.jar`                        | Java 8+ | The agent itself. It reads the control file every second, writes this JVM's status file, and holds the hooks.                                                                                                                                                                                                          |
| `weaver/` | `wirescry-agent-weaver.jar`, beside the impl jar | Java 8+ | Rewrites the classes the hooks change, with Byte Buddy. Loaded by its own `URLClassLoader` whose parent is the JDK's platform loader, so the program never sees it, and this Byte Buddy never meets a program's own. It loads at the first certificate check or proxy choice (about 150 ms, once) and stays, a few MB. |
| `attach/` | `wirescry-attach.jar`                            | JDK 11+ | `list` prints the running JVMs. `load` attaches the stub to one.                                                                                                                                                                                                                                                       |

## Hooks

**Trust (`Hooks`, `Trust`, `weaver/Trust*Advice`).** Code at the end of the JDK's default X.509 trust manager's three public `checkServerTrusted` overloads.

When the JDK's own check rejects a chain, the same overload is run again, with the same socket or engine, by a second JDK trust manager that trusts only Wirescry's CA. So host name and algorithm checks still apply.

The CA comes from the control file (`caPath`). It must match `caSha256` and be this user's alone. The status file says `trust:waiting`, `trust:ok`, or why not (`trust:ca-missing`, `trust:ca-unsafe`, `trust:ca-mismatch`, `trust:jdk-too-new`, …).

What it reaches:

- Programs with their own trust store, loaded into the JDK's trust manager, trust Wirescry too.
- So do hand-written trust managers that ask the JDK's.

What it leaves alone, or doesn't cover:

- Other hand-written trust managers.
- Certificate pinning.
- Revocation checks a program turns on: Wirescry's certificates name no CRL or OCSP server.
- Programs under a SecurityManager.
- A TLS session resumed after the agent turns off: it skips the check, until the session expires. The session can only resume with the same Wirescry.

**Proxy (`Hooks`, `Proxies`, `weaver/ProxyAdvice`).** Code at the end of the JDK's default proxy selector's `select(URI)`, which `HttpURLConnection`, Java's `HttpClient` and OkHttp ask unless the program set its own proxy or selector.

It replaces the JDK's answer with Wirescry's proxy, `127.0.0.1` on the control file's port, only when all of these hold:

- the agent is on;
- the scheme is `http` or `https`;
- the JDK chose to connect directly;
- the host isn't this computer (`localhost` and names under it, `127.*`, `0.0.0.0`, `[::1]`, `[::]`);
- the host isn't in `http.nonProxyHosts`, as the JDK reads it: the program's setting, else the JDK's `net.properties`.

The status file says `proxy:waiting` (no program code has asked yet), `proxy:ok`, `proxy:app-selector` (the program replaced the default selector, so it may not be reached), `proxy:jdk-too-new` or `proxy:failed`.

What it leaves alone:

- A proxy the program's settings name: a company proxy, SOCKS, or the system's.
- A program's own selector, and a proxy or `Proxy.NO_PROXY` given per connection.
- Other schemes: `socket` (JDBC and other raw sockets) and `ftp`.
- On macOS, the system's bypass list (`*.local` and others), which the JDK copies into `http.nonProxyHosts`.

Not covered:

- With `java.net.useSystemProxies`, hosts the system's bypass list names where the system sets no proxy: the JDK doesn't say why it chose direct.
- On Java 8, `http.nonProxyHosts` is matched with the rules of Java 9 and later, which match more hosts. So a host Java 8 would send to a proxy can be left alone.
- Anything that asks the default selector with an `http` or `https` address is sent to Wirescry, not only HTTP clients. gRPC's default proxy detection may be one; release B checks.

## Startup

With the **Java programs** setting on (Setup), Wirescry's terminals add the agent to `JAVA_TOOL_OPTIONS`, after the proxy and trust-store properties they already set:

```
-javaagent:"<data folder>/java-agent/wirescry-agent.jar=terminalPort=<port>"
```

- **The path** is quoted for its spaces. A path with `=` or a quote can't be used (Java splits at `=` and drops quotes), so the agent is left out and Setup says why.
- **JDK 8's limits:** it ignores the whole variable when it's over 1,024 bytes, and stops after 64 options. The agent is left out when it would go over; the properties stay. A terminal Wirescry opens keeps the user's own value in front, dropping it only if even the properties wouldn't fit. The setup lines for bash, zsh and PowerShell keep it too, with the same checks, counting the user's value in characters and not its options; fish's line keeps it with no check; Command Prompt's replace it. A value already holding Wirescry's trust store option is Wirescry's, and replaced.
- **Off means direct (`ProxyProperties`).** While Wirescry is gone (quit, crashed, or its control file deleted), a startup agent clears `http(s).proxyHost/Port` when they hold Wirescry's values: `127.0.0.1` and the port in `terminalPort=`, the control file's, or the one it last set. Requests then go straight out instead of to a closed port. Turning the setting off leaves them, as before the agent; so does a control file the agent refuses or can't read. A control file older than 20 seconds at the read before `main` counts as Wirescry gone, so a program started after a crash goes direct from its first request. On Java 8 a program walking the system properties while the agent changes them may get a ConcurrentModificationException. When it turns on, it puts them back, on Wirescry's current port, unless the program set its own meanwhile. Attached agents never touch them.
- **Set up twice** (a setup line run in a Wirescry terminal): only the part before Wirescry's options is kept. A user value already over 1,023 bytes gets everything appended, since JDK 8 couldn't have read it anyway. A shell profile that sets `JAVA_TOOL_OPTIONS` replaces Wirescry's whole value in terminals Wirescry opens on macOS and Linux, since it runs after.
- **Containers** started from a Wirescry terminal never get the host's agent: its jar isn't in the container, and a JVM whose agent jar is missing doesn't start. Wirescry removes the option from the container's own value.
- **Once used, always beating:** with the setting turned off later, Wirescry still keeps the control file's heartbeat (with `startup=false`), so terminals opened while it was on don't take Wirescry for gone.
- **Copy JVM option** gives `-javaagent:<stub>` for programs started elsewhere. It has no `terminalPort`, so the agent knows Wirescry's properties there by the control file's port, or the one it last set.
- A program starts without the agent when there's no control file (it names the jar to load), as before the agent.

## Byte Buddy

[Byte Buddy](https://bytebuddy.net) (Apache License 2.0) is pinned by version and SHA-256 in `scripts/build-java-agent.mjs`. It's fetched from Maven Central into `deps/`, and its license and notice are put into the impl jar under `META-INF/byte-buddy/`.

## Building

You need a JDK 17 or later, from `JAVA_HOME` or on PATH, and, the first time, access to Maven Central for Byte Buddy (about 4.5 MB, checked by SHA-256). Rebuild after changing the version in package.json. Run:

```bash
node scripts/build-java-agent.mjs
```

The jars are written to `build/`, and the build is reproducible. The app ships the stub, the implementation and the weaver in its resources (`java-agent/`), and copies them into the data folder when it starts with the **Java programs** setting on (`javaAgentStartup` in settings.json). The release workflow builds them once, on Linux, for every platform. Byte Buddy's and ASM's license texts are kept in `licenses/` for the app's notices; the build checks they match the ones in Byte Buddy's jar.

## Files

- **`control.properties`** is written by Wirescry and read by every agent. `src/backend/java/agent-files.ts` writes it. While the Java programs setting is on, or after it was turned on, `src/backend/java/agent-host.ts` keeps it current: it moves the heartbeat (`seq`) every 5 seconds, follows the port and the CA, and says `enabled=false` on a clean quit, just before the proxy closes. Agents read it within a second, so a request sent in that second may be refused. When Wirescry quits any other way (an update, a crash, Windows logging off), agents on Java 9+ notice Wirescry's process is gone within a second, and those on Java 8 when the heartbeat stops, after about 15 seconds.
- **`jars/`** keeps one implementation and weaver pair per Wirescry build. Each start marks its own pair as used, and deletes pairs no Wirescry has used for a week. JVMs still running one keep the files they have open.
- **`status/<pid>-<id>.properties`** is written by each agent and read by Wirescry.

Both use `key=value` lines and end with `end=1`. Both are written to a temporary file and then renamed into place. Both must be writable by their user only.

The design is in the shared design notes: java-attach-design.md, draft 3.
