/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import com.wirescry.agent.Perms;
import java.io.File;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.net.URL;
import java.net.URLClassLoader;
import java.security.ProtectionDomain;
import java.util.function.BiFunction;

/**
 * The agent's changes to other classes. A plain transformer that only compares names, so a
 * program pays nothing until a class the agent changes is loaded; only then does the weaver load,
 * with Byte Buddy, from its own jar next to this one.
 *
 * <p>The weaver's class loader has the JDK's platform loader (the extension loader on Java 8) as
 * its parent: it sees the JDK and nothing of the program's, and the program never sees it. So
 * this Byte Buddy never meets one the program brings (Mockito, Hibernate and others do). It stays
 * loaded for the program's life, a few MB: if another agent retransforms the class, this
 * transformer runs again and must weave again, or the hook would be lost.
 *
 * <p>For now one class: the JDK's default X.509 trust manager (see Trust). An attached agent
 * retransforms it if it was loaded before, from the control thread ({@link #retransformLoaded}).
 */
final class Hooks implements ClassFileTransformer {
  static final String TRUST_MANAGER = "sun/security/ssl/X509TrustManagerImpl";

  /** "waiting" (class not loaded yet), "ok", "jdk-too-new" or "failed". */
  private volatile String trust = "waiting";
  private BiFunction<String, byte[], byte[]> weaver;
  private boolean weaverFailed;

  @Override
  public byte[] transform(
      ClassLoader loader, String className, Class<?> redefined, ProtectionDomain domain, byte[] bytes) {
    if (!TRUST_MANAGER.equals(className) || loader != null) return null;
    try {
      BiFunction<String, byte[], byte[]> w = weaver();
      if (w == null) {
        trust = "failed";
        return null;
      }
      byte[] woven = w.apply(className, bytes);
      trust = "ok";
      return woven;
    } catch (Throwable t) {
      // Byte Buddy refuses class files newer than it knows.
      String message = String.valueOf(t.getMessage());
      trust = message.contains("not supported") || message.contains("Unsupported class file") ? "jdk-too-new" : "failed";
      return null;
    }
  }

  /** Changes the hooked classes that were loaded before an attach. */
  void retransformLoaded(Instrumentation inst) {
    if (!"waiting".equals(trust)) return;
    try {
      for (Class<?> c : inst.getAllLoadedClasses()) {
        if (c.getClassLoader() == null && TRUST_MANAGER.equals(c.getName().replace('.', '/'))) {
          if (inst.isModifiableClass(c)) inst.retransformClasses(c);
          else trust = "failed";
        }
      }
    } catch (Throwable t) {
      trust = "failed";
    }
  }

  /**
   * For the status file: `trust:waiting`, `trust:ok`, `trust:jdk-too-new`, `trust:failed`, or,
   * once woven, why Wirescry's CA can't be used (see Trust.problem), such as `trust:ca-mismatch`.
   */
  String report(Control control) {
    String state = trust;
    if ("ok".equals(state)) {
      String problem = Trust.problem(control);
      if (problem != null) state = problem;
    }
    return "trust:" + state;
  }

  /** The weaver's jar: the agent's own jar's name with `-weaver` before `.jar`. */
  static File weaverJar(File implJar) {
    String name = implJar.getName();
    return new File(implJar.getParentFile(), name.substring(0, name.length() - ".jar".length()) + "-weaver.jar");
  }

  @SuppressWarnings("unchecked")
  private synchronized BiFunction<String, byte[], byte[]> weaver() {
    if (weaver != null || weaverFailed) return weaver;
    try {
      File impl = new File(Hooks.class.getProtectionDomain().getCodeSource().getLocation().toURI());
      File jar = weaverJar(impl);
      // Its code runs in this program, as the stub checks for the agent's own jar.
      if (!impl.getName().endsWith(".jar") || !Perms.private_(jar)) {
        weaverFailed = true;
        return null;
      }
      URLClassLoader loader =
          new URLClassLoader(new URL[] {jar.toURI().toURL()}, ClassLoader.getSystemClassLoader().getParent());
      weaver =
          (BiFunction<String, byte[], byte[]>)
              Class.forName("com.wirescry.agent.weaver.TrustWeaver", true, loader).newInstance();
    } catch (Throwable t) {
      weaverFailed = true;
    }
    return weaver;
  }
}
