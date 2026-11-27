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
 * (see Proxies). And, in whichever class loaders the program loads them: Apache HttpClient's
 * DefaultRoutePlanner, 4.x and 5.x, and 5.x's SystemDefaultRoutePlanner (see Proxies.apache and
 * Proxies.apacheSystem); Jetty's HttpClient and ProxyConfiguration (see Jetty); and Reactor Netty's
 * HttpConnectionProvider (see ReactorNetty). An attached
 * agent retransforms those loaded before it, from the control thread ({@link #retransformLoaded}).
 */
final class Hooks implements ClassFileTransformer {
  static final String TRUST_MANAGER = "sun/security/ssl/X509TrustManagerImpl";
  static final String PROXY_SELECTOR = "sun/net/spi/DefaultProxySelector";
  static final String APACHE_4 = "org/apache/http/impl/conn/DefaultRoutePlanner";
  static final String APACHE_5 = "org/apache/hc/client5/http/impl/routing/DefaultRoutePlanner";
  static final String APACHE_5_SYSTEM = "org/apache/hc/client5/http/impl/routing/SystemDefaultRoutePlanner";
  static final String JETTY_CLIENT = "org/eclipse/jetty/client/HttpClient";
  static final String JETTY_PROXY_CONFIGURATION = "org/eclipse/jetty/client/ProxyConfiguration";
  static final String REACTOR_NETTY = "reactor/netty/http/client/HttpConnectionProvider";

  /** Each JDK hook: "waiting" (class not loaded yet), "ok", "jdk-too-new" or "failed". */
  private volatile String trust = "waiting";

  private volatile String proxy = "waiting";

  /**
   * Apache's planners: null until the program loads one, then "ok", or "failed" (or
   * "jdk-too-new") if any copy couldn't be changed. A program may load several copies, one per
   * class loader.
   */
  private volatile String apache;

  /**
   * Jetty's two classes, as `apache`: null until the program loads one, then "ok" once one is
   * woven (the Origin hook tags nothing until the other is in: see jettyMatchInstalled), "failed",
   * "jdk-too-new", or "not-covered" for 9.4 before 9.4.25. A failure or "not-covered" stays,
   * whichever comes first.
   */
  private volatile String jetty;

  /**
   * Reactor Netty's HttpConnectionProvider, as `apache`: null until the program loads it, then
   * "ok", "failed" or "jdk-too-new".
   */
  private volatile String reactorNetty;

  /**
   * Each class of the program's this transformer wove, by class loader (weakly: a loader the
   * program drops is freed) and name: its woven bytes. A class woven as it loaded isn't woven again
   * at the first poll; and when a later retransform (another agent's) can't weave it again, say
   * because its loader no longer serves the classes the weave reads, these keep the hook.
   */
  private final Map<ClassLoader, Map<String, byte[]>> programBytes = new WeakHashMap<ClassLoader, Map<String, byte[]>>();

  /**
   * The class loaders whose Jetty ProxyConfiguration has its hook installed, weakly. Jetty's
   * Origin hook tags a request for Wirescry only once this hook is in, or the destination it makes
   * would be tagged but direct, and stay so for the client's life (see Jetty.origin). Marked when
   * the class is woven as it loads (the hook's caller then holds the class, so its woven bytes are
   * the ones the JVM installed), or after retransformClasses returns for it; never merely because
   * this transformer made the bytes.
   */
  private static final Map<ClassLoader, Boolean> jettyMatchInstalled = new WeakHashMap<ClassLoader, Boolean>();

  private BiFunction<String, byte[], byte[]> weaver;
  private Function<Object[], byte[]> programWeaver;
  private boolean weaverFailed;

  static boolean isApache(String className) {
    return APACHE_4.equals(className) || APACHE_5.equals(className) || APACHE_5_SYSTEM.equals(className);
  }

  static boolean isJetty(String className) {
    return JETTY_CLIENT.equals(className) || JETTY_PROXY_CONFIGURATION.equals(className);
  }

  /** A class of the program's that ProgramWeaver changes. */
  static boolean isProgram(String className) {
    return isApache(className) || isJetty(className) || REACTOR_NETTY.equals(className);
  }

  /** Whether `configuration`, a Jetty ProxyConfiguration class, has its hook installed. */
  static boolean jettyMatchInstalled(Class<?> configuration) {
    synchronized (jettyMatchInstalled) {
      return jettyMatchInstalled.containsKey(configuration.getClassLoader());
    }
  }

  private static void markJettyMatchInstalled(ClassLoader loader) {
    synchronized (jettyMatchInstalled) {
      jettyMatchInstalled.put(loader, Boolean.TRUE);
    }
  }

  @Override
  public byte[] transform(
      ClassLoader loader, String className, Class<?> redefined, ProtectionDomain domain, byte[] bytes) {
    boolean jdk = loader == null && (TRUST_MANAGER.equals(className) || PROXY_SELECTOR.equals(className));
    if (!jdk && !isProgram(className)) return null;
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
      if (Trace.ON) Trace.note("weave of " + className + " threw: " + t);
      // Byte Buddy refuses class files newer than it knows.
      String message = String.valueOf(t.getMessage());
      // ProgramWeaver.NOT_COVERED: a release the hooks don't cover.
      if (message.startsWith("not-covered: ")) state = "not-covered";
      else state = message.contains("not supported") || message.contains("Unsupported class file") ? "jdk-too-new" : "failed";
    }
    if (TRUST_MANAGER.equals(className)) {
      trust = state;
      if (!"ok".equals(state) && Trace.ON) Trace.note("trust: the trust manager wasn't woven (" + state + ")");
    }
    else if (PROXY_SELECTOR.equals(className)) proxy = state;
    else {
      woven = programWoven(loader, className, woven, state);
      // As it loads: the class that comes of these bytes is the one the hook's caller will hold.
      if (woven != null && redefined == null && JETTY_PROXY_CONFIGURATION.equals(className)) {
        markJettyMatchInstalled(loader);
      }
    }
    return woven;
  }

  /**
   * Records a class of the program's woven (`bytes`), or not. When not, but it was before (a
   * retransform), the bytes from before stand and so does its "ok". Returns the bytes to use.
   */
  private synchronized byte[] programWoven(ClassLoader loader, String className, byte[] bytes, String state) {
    Map<String, byte[]> byName = programBytes.get(loader);
    if (bytes != null) {
      if (byName == null) programBytes.put(loader, byName = new HashMap<String, byte[]>(2));
      byName.put(className, bytes);
      library(className, state);
      return bytes;
    }
    byte[] before = byName == null ? null : byName.get(className);
    if (before != null) return before;
    library(className, state);
    return null;
  }

  /** Whether this transformer already wove the program's class `c`. */
  private synchronized boolean programWoven(Class<?> c) {
    Map<String, byte[]> byName = programBytes.get(c.getClassLoader());
    return byName != null && byName.containsKey(c.getName().replace('.', '/'));
  }

  /** One more of a library's classes woven, or not: one that failed stays reported. */
  private synchronized void library(String className, String state) {
    if (isJetty(className)) {
      if (jetty == null || "ok".equals(jetty)) jetty = state;
    } else if (REACTOR_NETTY.equals(className)) {
      if (reactorNetty == null || "ok".equals(reactorNetty)) reactorNetty = state;
    } else if (apache == null || "ok".equals(apache)) {
      apache = state;
    }
  }

  /**
   * Changes the hooked classes that were loaded before the agent: for an attach, those the program
   * loaded; at startup, those an agent named before this one loaded. Classes of the program's this
   * agent already wove are left as they are. Jetty's ProxyConfiguration goes before its HttpClient,
   * so no request is tagged for a proxy the other hook can't yet give (see jettyMatchInstalled).
   */
  void retransformLoaded(Instrumentation inst) {
    List<Class<?>> loaded = new ArrayList<Class<?>>();
    try {
      for (Class<?> c : inst.getAllLoadedClasses()) {
        String name = c.getName().replace('.', '/');
        boolean isTrust = c.getClassLoader() == null && TRUST_MANAGER.equals(name) && "waiting".equals(trust);
        boolean isProxy = c.getClassLoader() == null && PROXY_SELECTOR.equals(name) && "waiting".equals(proxy);
        // Not again if woven as it loaded: nothing to gain, and a weave can fail later.
        // Jetty's ProxyConfiguration: again unless its hook is known to be in. Another agent's
        // retransform may have woven it before this runs, without telling whether the JVM took it.
        boolean program =
            isProgram(name)
                && (JETTY_PROXY_CONFIGURATION.equals(name) ? !jettyMatchInstalled(c) : !programWoven(c));
        if (!isTrust && !isProxy && !program) continue;
        if (inst.isModifiableClass(c)) loaded.add(JETTY_PROXY_CONFIGURATION.equals(name) ? 0 : loaded.size(), c);
        else if (isTrust) {
          trust = "failed";
          Trace.note("trust: the loaded trust manager can't be changed");
        }
        else if (isProxy) proxy = "failed";
        else library(name, "failed");
      }
      // One at a time, so one that fails leaves the others.
      for (Class<?> c : loaded) {
        String name = c.getName().replace('.', '/');
        try {
          inst.retransformClasses(c);
          if (JETTY_PROXY_CONFIGURATION.equals(name) && programWoven(c)) markJettyMatchInstalled(c.getClassLoader());
        } catch (Throwable t) {
          if (TRUST_MANAGER.equals(name)) {
            trust = "failed";
            if (Trace.ON) Trace.note("trust: retransforming the trust manager failed: " + t);
          } else if (PROXY_SELECTOR.equals(name)) proxy = "failed";
          else library(name, "failed");
        }
      }
    } catch (Throwable t) {
      // Which classes were loaded can't be known: the JDK hooks still waiting can't be done
      // now, and say so. Library classes not woven yet can't be named, so their states stay.
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
   *   <li>Once the program loads Reactor Netty's HttpClient: `reactor-netty:ok`,
   *       `reactor-netty:failed` (also when the hook ran but Reactor Netty's classes weren't the
   *       shape it needs), `reactor-netty:jdk-too-new`, or `reactor-netty:no-proxy-handler` when the
   *       program lacks Netty's proxy support (netty-handler-proxy), so its requests go direct.
   *   <li>Once the program loads Jetty's HttpClient: `jetty:ok`, `jetty:failed` (also when a
   *       hook ran but Jetty's classes weren't the shape it needs), `jetty:jdk-too-new`, or
   *       `jetty:not-covered` for a release older than the hooks cover (9.4 before 9.4.25). And
   *       `jetty-skipped:N` when N of the program's Jetty clients, since it started, were left
   *       alone whole (see Jetty.client): a transport that can't go through Wirescry's proxy, PROXY
   *       protocol, or a connector for a Unix socket. Requests left alone one by one (h2c first for
   *       plain http, or a Unix socket or QUIC chosen per request in 12) aren't counted.
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
    String j = jetty;
    if ("ok".equals(j) && Jetty.broken) j = "failed";
    int skipped = Jetty.skipped();
    String r = reactorNetty;
    if ("ok".equals(r) && ReactorNetty.broken) r = "failed";
    else if ("ok".equals(r) && ReactorNetty.noProxyHandler) r = "no-proxy-handler";
    return "trust:" + t + ",proxy:" + p + (a == null ? "" : ",apache:" + a) + (j == null ? "" : ",jetty:" + j)
        + (j == null || skipped == 0 ? "" : ",jetty-skipped:" + skipped)
        + (r == null ? "" : ",reactor-netty:" + r);
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
        if (Trace.ON) Trace.note("weaver not loaded: " + jar + " isn't the agent's own, or isn't private");
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
      if (Trace.ON) Trace.note("weaver not loaded: " + t);
      weaverFailed = true;
    }
    return weaver != null;
  }
}
