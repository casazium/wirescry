/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import com.wirescry.agent.Perms;
import java.io.File;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.net.ProxySelector;
import java.net.URL;
import java.net.URLClassLoader;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.function.BiFunction;
import java.util.function.Function;

/**
 * The agent's changes to other classes. A plain transformer that only compares names, so a
 * program pays nothing until a class the agent changes is loaded; only then does the weaver load,
 * with Byte Buddy, from its own jar next to this one.
 *
 * <p>The weaver's class loader has the JDK's platform loader (the extension loader on Java 8) as
 * its parent: it sees the JDK and nothing of the program's, and the program never sees it. So
 * this Byte Buddy never meets one the program brings (Mockito, Hibernate and others do). It stays
 * loaded for the program's life, a few MB: if another agent retransforms a class, this
 * transformer runs again and must weave again, or the hook would be lost.
 *
 * <p>Two JDK classes: the default X.509 trust manager (see Trust) and the default proxy selector
 * (see Proxies). And Apache HttpClient's DefaultRoutePlanner, 4.x and 5.x, and 5.x's
 * SystemDefaultRoutePlanner, in whichever class loaders the program loads them (see
 * Proxies.apache and Proxies.apacheSystem). An attached agent retransforms those loaded
 * before it, from the control thread ({@link #retransformLoaded}).
 */
final class Hooks implements ClassFileTransformer {
  static final String TRUST_MANAGER = "sun/security/ssl/X509TrustManagerImpl";
  static final String PROXY_SELECTOR = "sun/net/spi/DefaultProxySelector";
  static final String APACHE_4 = "org/apache/http/impl/conn/DefaultRoutePlanner";
  static final String APACHE_5 = "org/apache/hc/client5/http/impl/routing/DefaultRoutePlanner";
  static final String APACHE_5_SYSTEM = "org/apache/hc/client5/http/impl/routing/SystemDefaultRoutePlanner";

  /** Each hook: "waiting" (class not loaded yet), "ok", "jdk-too-new" or "failed". */
  private volatile String trust = "waiting";

  private volatile String proxy = "waiting";

  /**
   * Apache's planners: null until the program loads one, then "ok", or "failed" (or
   * "jdk-too-new") if any copy couldn't be changed. A program may load several copies, one per
   * class loader.
   */
  private volatile String apache;

  /**
   * Each Apache planner this transformer wove, by class loader (weakly: a loader the program
   * drops is freed) and name: its woven bytes. A planner woven as it loaded isn't woven again at
   * the first poll; and when a later retransform (another agent's) can't weave it again, say
   * because its loader no longer serves the Apache classes the weave reads, these keep the hook.
   */
  private final Map<ClassLoader, Map<String, byte[]>> apacheBytes = new WeakHashMap<ClassLoader, Map<String, byte[]>>();

  private BiFunction<String, byte[], byte[]> weaver;
  private Function<Object[], byte[]> programWeaver;
  private boolean weaverFailed;

  static boolean isApache(String className) {
    return APACHE_4.equals(className) || APACHE_5.equals(className) || APACHE_5_SYSTEM.equals(className);
  }

  @Override
  public byte[] transform(
      ClassLoader loader, String className, Class<?> redefined, ProtectionDomain domain, byte[] bytes) {
    boolean jdk = loader == null && (TRUST_MANAGER.equals(className) || PROXY_SELECTOR.equals(className));
    if (!jdk && !isApache(className)) return null;
    String state;
    byte[] woven = null;
    try {
      if (!loadWeaver()) {
        state = "failed";
      } else {
        woven =
            jdk ? weaver.apply(className, bytes) : programWeaver.apply(new Object[] {className, bytes, loader});
        // 5.x's SystemDefaultRoutePlanner without the method its small hook needs: nothing to do,
        // and nothing to report (see ProgramWeaver).
        if (woven == null && APACHE_5_SYSTEM.equals(className)) return null;
        state = woven == null ? "failed" : "ok";
      }
    } catch (Throwable t) {
      // Byte Buddy refuses class files newer than it knows.
      String message = String.valueOf(t.getMessage());
      state = message.contains("not supported") || message.contains("Unsupported class file") ? "jdk-too-new" : "failed";
    }
    if (TRUST_MANAGER.equals(className)) trust = state;
    else if (PROXY_SELECTOR.equals(className)) proxy = state;
    else woven = apacheWoven(loader, className, woven, state);
    return woven;
  }

  /**
   * Records an Apache planner woven (`bytes`), or not. When not, but it was before (a
   * retransform), the bytes from before stand and so does its "ok". Returns the bytes to use.
   */
  private synchronized byte[] apacheWoven(ClassLoader loader, String className, byte[] bytes, String state) {
    Map<String, byte[]> byName = apacheBytes.get(loader);
    if (bytes != null) {
      if (byName == null) apacheBytes.put(loader, byName = new HashMap<String, byte[]>(2));
      byName.put(className, bytes);
      apache(state);
      return bytes;
    }
    byte[] before = byName == null ? null : byName.get(className);
    if (before != null) return before;
    apache(state);
    return null;
  }

  /** Whether this transformer already wove the Apache planner `c`. */
  private synchronized boolean apacheWoven(Class<?> c) {
    Map<String, byte[]> byName = apacheBytes.get(c.getClassLoader());
    return byName != null && byName.containsKey(c.getName().replace('.', '/'));
  }

  /** One more Apache planner woven, or not: one that failed stays reported. */
  private synchronized void apache(String state) {
    if (apache == null || "ok".equals(apache)) apache = state;
  }

  /**
   * Changes the hooked classes that were loaded before the agent: for an attach, those the program
   * loaded; at startup, those an agent named before this one loaded. Apache's planners this agent
   * already wove are left as they are.
   */
  void retransformLoaded(Instrumentation inst) {
    List<Class<?>> loaded = new ArrayList<Class<?>>();
    try {
      for (Class<?> c : inst.getAllLoadedClasses()) {
        String name = c.getName().replace('.', '/');
        boolean isTrust = c.getClassLoader() == null && TRUST_MANAGER.equals(name) && "waiting".equals(trust);
        boolean isProxy = c.getClassLoader() == null && PROXY_SELECTOR.equals(name) && "waiting".equals(proxy);
        // Not again if woven as it loaded: nothing to gain, and a weave can fail later.
        boolean isApache = isApache(name) && !apacheWoven(c);
        if (!isTrust && !isProxy && !isApache) continue;
        if (inst.isModifiableClass(c)) loaded.add(c);
        else if (isTrust) trust = "failed";
        else if (isProxy) proxy = "failed";
        else apache("failed");
      }
      // One at a time, so one that fails leaves the others.
      for (Class<?> c : loaded) {
        try {
          inst.retransformClasses(c);
        } catch (Throwable t) {
          String name = c.getName().replace('.', '/');
          if (TRUST_MANAGER.equals(name)) trust = "failed";
          else if (PROXY_SELECTOR.equals(name)) proxy = "failed";
          else apache("failed");
        }
      }
    } catch (Throwable t) {
      // Which classes were loaded can't be known: the JDK hooks still waiting can't be done
      // now, and say so. Apache planners not woven yet can't be named, so `apache` stays as it is.
      if ("waiting".equals(trust)) trust = "failed";
      if ("waiting".equals(proxy)) proxy = "failed";
    }
  }

  /**
   * For the status file, one entry per hook:
   *
   * <ul>
   *   <li>`trust:waiting`, `trust:ok`, `trust:jdk-too-new`, `trust:failed`, or, once woven, why
   *       Wirescry's CA can't be used (see Trust.problem), such as `trust:ca-mismatch`.
   *   <li>`proxy:waiting`, `proxy:ok`, `proxy:jdk-too-new`, `proxy:failed`, or, once woven,
   *       `proxy:app-selector` when the program replaced the JDK's selector with its own, which
   *       the hook doesn't reach.
   *   <li>Once the program loads Apache HttpClient: `apache:ok`, `apache:failed` or
   *       `apache:jdk-too-new`.
   * </ul>
   */
  String report(Control control) {
    String t = trust;
    if ("ok".equals(t)) {
      String problem = Trust.problem(control);
      if (problem != null) t = problem;
    }
    String p = proxy;
    if ("ok".equals(p) && !jdkSelector()) p = "app-selector";
    String a = apache;
    return "trust:" + t + ",proxy:" + p + (a == null ? "" : ",apache:" + a);
  }

  /** Whether the program's default proxy selector is still the JDK's. */
  private static boolean jdkSelector() {
    try {
      ProxySelector selector = ProxySelector.getDefault();
      return selector != null && selector.getClass().getName().equals(PROXY_SELECTOR.replace('/', '.'));
    } catch (Throwable t) {
      // Under a SecurityManager that denies it: can't tell, so don't say it's replaced.
      return true;
    }
  }

  /** The weaver's jar: the agent's own jar's name with `-weaver` before `.jar`. */
  static File weaverJar(File implJar) {
    String name = implJar.getName();
    return new File(implJar.getParentFile(), name.substring(0, name.length() - ".jar".length()) + "-weaver.jar");
  }

  /** Loads the weaver's two classes, once. Whether they're there. */
  @SuppressWarnings("unchecked")
  private synchronized boolean loadWeaver() {
    if (weaver != null || weaverFailed) return weaver != null;
    try {
      File impl = new File(Hooks.class.getProtectionDomain().getCodeSource().getLocation().toURI());
      File jar = weaverJar(impl);
      // Its code runs in this program, as the stub checks for the agent's own jar.
      if (!impl.getName().endsWith(".jar") || !Perms.private_(jar)) {
        weaverFailed = true;
        return false;
      }
      URLClassLoader loader =
          new URLClassLoader(new URL[] {jar.toURI().toURL()}, ClassLoader.getSystemClassLoader().getParent());
      Function<Object[], byte[]> program =
          (Function<Object[], byte[]>)
              Class.forName("com.wirescry.agent.weaver.ProgramWeaver", true, loader).newInstance();
      weaver =
          (BiFunction<String, byte[], byte[]>)
              Class.forName("com.wirescry.agent.weaver.Weaver", true, loader).newInstance();
      programWeaver = program;
    } catch (Throwable t) {
      weaverFailed = true;
    }
    return weaver != null;
  }
}
