/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import java.io.File;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.security.ProtectionDomain;
import java.util.function.BiFunction;
import java.util.jar.JarFile;

/**
 * The agent's changes to other classes. A plain transformer that only compares names, so a
 * program pays nothing until a class the agent changes is loaded; only then does the weaver (and
 * Byte Buddy, in its own class loader) load.
 *
 * <p>For now one class: the JDK's default X.509 trust manager (see Trust). Classes already loaded
 * when the agent was attached are retransformed by {@link #retransformLoaded}, from the control
 * thread, never before main.
 */
final class Hooks implements ClassFileTransformer {
  static final String TRUST_MANAGER = "sun/security/ssl/X509TrustManagerImpl";

  /** "waiting" (class not loaded yet), "ok" or "failed". */
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
      trust = "failed";
      return null;
    }
  }

  /** Changes the classes the agent hooks that were loaded before it was. */
  void retransformLoaded(Instrumentation inst) {
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

  /** For the status file: `trust:ok`, `trust:waiting` or `trust:failed`. */
  String report() {
    return "trust:" + trust;
  }

  @SuppressWarnings("unchecked")
  private synchronized BiFunction<String, byte[], byte[]> weaver() {
    if (weaver != null || weaverFailed) return weaver;
    try {
      File jar = new File(Hooks.class.getProtectionDomain().getCodeSource().getLocation().toURI());
      WeaverLoader loader = new WeaverLoader(new JarFile(jar));
      weaver =
          (BiFunction<String, byte[], byte[]>)
              Class.forName("com.wirescry.agent.weaver.TrustWeaver", true, loader).newInstance();
    } catch (Throwable t) {
      weaverFailed = true;
    }
    return weaver;
  }
}
