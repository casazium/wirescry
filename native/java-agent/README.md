# Wirescry's Java agent

The agent makes a Java program send its HTTP and HTTPS traffic through Wirescry, either from the start (`-javaagent:`) or by attaching to a program that's already running.

**License:** everything in this folder is under the Apache License 2.0 (see LICENSE). It isn't AGPL, unlike the rest of Wirescry, because the agent runs inside other people's programs.

## Layout

| Folder    | Jar                       | Runs on | What it does                                                                                                                                                                                                                                                        |
| --------- | ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stub/`   | `wirescry-agent.jar`      | Java 8+ | The jar that `-javaagent:` and the Attach API name. It lives at a path that never changes (`<data folder>/java-agent/`). It reads the name of the implementation jar from the control file, checks file permissions, loads that jar and starts it. It never throws. |
| `impl/`   | `wirescry-agent-impl.jar` | Java 8+ | The agent itself, added to the system class loader. It reads the control file every second and writes this JVM's status file.                                                                                                                                       |
| `attach/` | `wirescry-attach.jar`     | JDK 11+ | `list` prints the running JVMs. `load` attaches the stub to one.                                                                                                                                                                                                    |

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
