/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent;

import java.io.File;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.jar.JarFile;

/**
 * Wirescry's Java agent stub: the jar that `-javaagent:` and the Attach API name. It lives at a
 * path that never changes (`<Wirescry's data folder>/java-agent/wirescry-agent.jar`), so a JVM
 * option copied into an IDE keeps working across Wirescry updates.
 *
 * <p>It does as little as it can. It reads the name of the agent's implementation jar from the
 * control file next to it, checks that only this user can change either, puts the jar on the
 * bootstrap class path and starts it. Whatever goes wrong, it returns quietly: a `-javaagent`
 * whose premain throws stops the JVM before main, and Wirescry must never stop a program.
 */
public final class Stub {
  private static final String AGENT_CLASS = "com.wirescry.agent.impl.Agent";
  /** The implementation jar's name, as the control file gives it. Nothing else is loaded. */
  private static final String IMPL_PATTERN = "jars/wirescry-agent-impl-[0-9A-Za-z.+_-]{1,64}\\.jar";

  private Stub() {}

  public static void premain(String args, Instrumentation inst) {
    start(args, inst, "startup");
  }

  public static void agentmain(String args, Instrumentation inst) {
    start(args, inst, "attach");
  }

  private static void start(String args, Instrumentation inst, String route) {
    try {
      Class<?> agent = loadedAgent();
      File dir = null;
      if (agent == null) {
        dir = ownFolder();
        if (dir == null) return;
        File impl = implJar(dir);
        if (impl == null) return;
        inst.appendToBootstrapClassLoaderSearch(new JarFile(impl));
        agent = Class.forName(AGENT_CLASS, true, null);
      } else {
        dir = ownFolder();
      }
      Method start =
          agent.getMethod("start", String.class, Instrumentation.class, String.class, File.class);
      start.invoke(null, args, inst, route, dir);
    } catch (Throwable ignored) {
      // Never stop or disturb the program. Wirescry sees no status file, and says so.
    }
  }

  /** The implementation, if an earlier start in this JVM loaded it. */
  private static Class<?> loadedAgent() {
    try {
      return Class.forName(AGENT_CLASS, false, null);
    } catch (ClassNotFoundException e) {
      return null;
    }
  }

  /** The folder this jar is in, which holds the control file and the implementation jars. */
  private static File ownFolder() throws Exception {
    File jar = new File(Stub.class.getProtectionDomain().getCodeSource().getLocation().toURI());
    File dir = jar.getParentFile();
    return dir != null && dir.isDirectory() ? dir : null;
  }

  /**
   * The implementation jar the control file names, or null. The folder, the control file and the
   * jar must be this user's alone (see Perms), since the jar's code runs in this program.
   */
  static File implJar(File dir) throws Exception {
    File control = new File(dir, "control.properties");
    if (!Perms.private_(dir) || !Perms.private_(control)) return null;
    String name = null;
    for (String line : new String(Files.readAllBytes(control.toPath()), StandardCharsets.UTF_8).split("\n")) {
      if (line.startsWith("impl=")) name = line.substring("impl=".length()).trim();
    }
    if (name == null || !name.matches(IMPL_PATTERN)) return null;
    File jar = new File(dir, name);
    File jars = jar.getParentFile();
    if (!Perms.private_(jars) || !Perms.private_(jar) || !jar.isFile()) return null;
    return jar;
  }
}
