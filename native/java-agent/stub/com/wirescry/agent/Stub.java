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
 * control file next to it, checks that only this user can change either, adds the jar to the
 * system class loader (where this jar is too) and starts it. Not the bootstrap class path:
 * appending there turns off class-data sharing for the program's own classes, and HotSpot prints a
 * warning in every program it runs. Hooks in JDK classes find the agent through the system class
 * loader instead. Whatever goes wrong, it returns quietly: a `-javaagent`
 * whose premain throws stops the JVM before main, and Wirescry must never stop a program.
 *
 * <p>This jar is replaced only when it differs, and a JVM may run an old copy for a long time, so
 * what it relies on is frozen: the control file's `impl=` line, the jar name rule below, and the
 * implementation's {@code Agent.start(String, Instrumentation, String, File)}, and {@code
 * Perms.private_(File)}, which the implementation uses from this jar.
 */
public final class Stub {
  private static final String AGENT_CLASS = "com.wirescry.agent.impl.Agent";
  private static final String IMPL_PREFIX = "jars/wirescry-agent-impl-";

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
        // The JVM adds the jar by its path; this JarFile only names it.
        try (JarFile jar = new JarFile(impl)) {
          inst.appendToSystemClassLoaderSearch(jar);
        }
        agent = Class.forName(AGENT_CLASS, true, ClassLoader.getSystemClassLoader());
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
      return Class.forName(AGENT_CLASS, false, ClassLoader.getSystemClassLoader());
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
    String text = new String(Files.readAllBytes(control.toPath()), StandardCharsets.UTF_8);
    String name = null;
    int start = 0;
    while (start < text.length()) {
      int end = text.indexOf('\n', start);
      if (end < 0) end = text.length();
      String line = text.substring(start, end).trim();
      if (line.startsWith("impl=")) {
        if (name != null) return null;
        name = line.substring("impl=".length());
      }
      start = end + 1;
    }
    if (!implName(name)) return null;
    File jar = new File(dir, name);
    File jars = jar.getParentFile();
    if (!Perms.private_(jars) || !Perms.private_(jar) || !jar.isFile()) return null;
    return jar;
  }

  /**
   * Whether `name` is `jars/wirescry-agent-impl-<1 to 64 of 0-9 A-Z a-z . + _ ->.jar`: nothing that
   * leaves the jars folder. Checked by hand: a regular expression here would be the program's first,
   * before its main.
   */
  static boolean implName(String name) {
    if (name == null || !name.startsWith(IMPL_PREFIX) || !name.endsWith(".jar")) return false;
    String middle = name.substring(IMPL_PREFIX.length(), name.length() - ".jar".length());
    if (middle.isEmpty() || middle.length() > 64) return false;
    for (int i = 0; i < middle.length(); i++) {
      char c = middle.charAt(i);
      boolean ok =
          (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
              || c == '.' || c == '+' || c == '_' || c == '-';
      if (!ok) return false;
    }
    return true;
  }
}
