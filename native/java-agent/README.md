# Wirescry's Java agent

The agent makes a Java program send its HTTP and HTTPS traffic through Wirescry, either from the start (`-javaagent:`) or by attaching to a program that's already running.

**License:** everything in this folder is under the Apache License 2.0 (see LICENSE). It isn't AGPL, unlike the rest of Wirescry, because the agent runs inside other people's programs.

## Layout

| Folder    | Jar                                  | Runs on | What it does                                                                                                                                                                                                                                                                                  |
| --------- | ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stub/`   | `wirescry-agent.jar`                 | Java 8+ | The jar that `-javaagent:` and the Attach API name. It lives at a path that never changes (`<data folder>/java-agent/`). It reads the name of the implementation jar from the control file, checks file permissions, adds that jar to the system class loader and starts it. It never throws. |
| `impl/`   | `wirescry-agent-impl.jar`            | Java 8+ | The agent itself. It reads the control file every second, writes this JVM's status file, and holds the hooks.                                                                                                                                                                                 |
| `weaver/` | inside the impl jar, under `weaver/` | Java 8+ | Rewrites the classes the hooks change, with Byte Buddy. The program's class loaders can't see anything under `weaver/`; only the agent's own `WeaverLoader` reads it, so this Byte Buddy never meets a program's own.                                                                         |
| `attach/` | `wirescry-attach.jar`                | JDK 11+ | `list` prints the running JVMs. `load` attaches the stub to one.                                                                                                                                                                                                                              |

## Hooks

**Trust (`Hooks`, `Trust`, `weaver/TrustAdvice`).** Code at the end of the JDK's default X.509 trust manager's `checkServerTrusted`. When the JDK's own check rejects a chain, the same check is run, with the same socket or engine, by a second JDK trust manager that trusts only Wirescry's CA. So host name and algorithm checks still apply. The CA comes from the control file (`caPath`) and must match its SHA-256 (`caSha256`). Programs with their own trust store loaded into the JDK's trust manager trust Wirescry too; hand-written trust managers and certificate pinning are left alone.

## Byte Buddy

[Byte Buddy](https://bytebuddy.net) (Apache License 2.0) is pinned by version and SHA-256 in `scripts/build-java-agent.mjs`. It's fetched from Maven Central into `deps/`, and its license and notice are put into the impl jar under `META-INF/byte-buddy/`.

## Building

You need a JDK 17 or later, from `JAVA_HOME` or on PATH. Run:

```bash
node scripts/build-java-agent.mjs
```

The jars are written to `build/`, and the build is reproducible.

## Files

- **`control.properties`** is written by Wirescry and read by every agent. `src/backend/java/agent-files.ts` writes it.
- **`status/<pid>-<id>.properties`** is written by each agent and read by Wirescry.

Both use `key=value` lines and end with `end=1`. Both are written to a temporary file and then renamed into place. Both must be writable by their user only.

The design is in the shared design notes: java-attach-design.md, draft 3.
