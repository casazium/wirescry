/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Whether Wirescry's proxy replaces the JDK default proxy selector's answer. Called by the code
 * the weaver puts at the end of sun.net.spi.DefaultProxySelector.select (com.wirescry.agent.weaver
 * .ProxyAdvice), so it reaches HttpURLConnection, Java's HttpClient (even one built before an
 * attach: it asks for each request) and OkHttp.
 *
 * <p>Wirescry's proxy, at 127.0.0.1 on the control file's port, replaces the answer only when all
 * of these hold: the agent is on; the scheme is http or https; the JDK chose to connect directly;
 * the host isn't this computer (loopback, `0.0.0.0` or `::`); and the host isn't in the program's
 * own `http.nonProxyHosts`. So a proxy the program's settings name (a company proxy, SOCKS, or the
 * system's) stands, as does every other scheme (`socket` is JDBC and other raw sockets). A program
 * that sets its own selector, or a proxy or Proxy.NO_PROXY per connection, never asks the JDK's.
 *
 * <p>The JDK reads `http.nonProxyHosts` only when it has a proxy to skip, so with none set it
 * would never apply: this applies it, with the JDK's own pattern rules (Java 9 and later; Java 8's
 * rules match fewer hosts, so there a host can be left alone that Java 8 itself would proxy).
 * The advice passes the value the JDK itself reads: the program's setting, else the JDK's
 * net.properties file. On macOS the JDK sets it from the system's bypass list (`*.local` and
 * others), so those hosts are left alone there.
 *
 * <p>Not covered: hosts the operating system's own bypass list names, for a program that sets
 * `java.net.useSystemProxies` and has no system proxy for that host.
 */
public final class Proxies {
  /** Wirescry's proxy for the last port, made once per port. */
  private static volatile Proxy last;

  private Proxies() {}

  /**
   * Wirescry's proxy instead of `jdk` (what the JDK chose), or null to keep the JDK's.
   * `nonProxyHosts` is the JDK's `http.nonProxyHosts`, or null.
   */
  public static List<Proxy> select(URI uri, List<?> jdk, String nonProxyHosts) {
    try {
      if (!Agent.isOn() || !direct(jdk)) return null;
      Control control = Agent.settings();
      // `on` and the settings are read apart: one turning off can be seen half done.
      if (control == null || !control.enabled) return null;
      String scheme = uri.getScheme();
      if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return null;
      String host = host(uri);
      if (host == null || host.isEmpty()) return null;
      host = host.toLowerCase(Locale.ROOT);
      if (thisComputer(host) || excluded(nonProxyHosts, host)) return null;
      // Mutable, like Java 8's own answer (later ones aren't, so callers can't rely on either).
      List<Proxy> mine = new ArrayList<Proxy>(1);
      mine.add(proxy(control.proxyPort));
      return mine;
    } catch (Throwable t) {
      return null;
    }
  }

  /** Whether the JDK's answer is to connect directly: one or more entries, all DIRECT. */
  static boolean direct(List<?> jdk) {
    if (jdk == null || jdk.isEmpty()) return false;
    for (Object p : jdk) {
      if (!(p instanceof Proxy) || ((Proxy) p).type() != Proxy.Type.DIRECT) return false;
    }
    return true;
  }

  /**
   * The URI's host, as the JDK's selector finds it: from the authority when URI can't parse one
   * (a name with `_` in it, say).
   */
  static String host(URI uri) {
    String host = uri.getHost();
    if (host != null) return host;
    String auth = uri.getAuthority();
    if (auth == null) return null;
    int at = auth.indexOf('@');
    if (at >= 0) auth = auth.substring(at + 1);
    int colon = auth.lastIndexOf(':');
    return colon >= 0 ? auth.substring(0, colon) : auth;
  }

  /**
   * Whether `host` (lower case) names this computer: `localhost` and names under it, `127.*` (as
   * the JDK's own default list has it, names included), `0.0.0.0`, or a loopback or any-local
   * IPv6 address (`[::1]`, `[::]` and other spellings). Never looks a name up: an IPv4 address
   * is only this computer by its first part, and InetAddress takes a bracketed host only as an
   * IPv6 literal.
   */
  static boolean thisComputer(String host) {
    String name = host.endsWith(".") ? host.substring(0, host.length() - 1) : host;
    if (name.equals("localhost") || name.endsWith(".localhost")) return true;
    if (name.startsWith("127.") || name.equals("0.0.0.0")) return true;
    if (!host.startsWith("[") || !host.endsWith("]")) return false;
    // A scope (`%en0`) can't make an address loopback, and resolving one is slow.
    int scope = host.indexOf('%');
    String literal = scope < 0 ? host : host.substring(0, scope) + "]";
    try {
      InetAddress address = InetAddress.getByName(literal);
      return address.isLoopbackAddress() || address.isAnyLocalAddress();
    } catch (Exception e) {
      return false;
    }
  }

  /**
   * Whether `patterns` (an `http.nonProxyHosts` value) names `host` (lower case), by the JDK's
   * rules: `|` between patterns, each matched whole and ignoring case, with a `*` at its start or
   * end (or both) matching anything there.
   */
  static boolean excluded(String patterns, String host) {
    if (patterns == null) return false;
    int start = 0;
    while (start <= patterns.length()) {
      int bar = patterns.indexOf('|', start);
      if (bar < 0) bar = patterns.length();
      String p = patterns.substring(start, bar).toLowerCase(Locale.ROOT);
      if (!p.isEmpty() && matches(p, host)) return true;
      start = bar + 1;
    }
    return false;
  }

  private static boolean matches(String p, String host) {
    if (p.equals("*")) return true;
    boolean front = p.startsWith("*");
    boolean back = p.length() > 1 && p.endsWith("*");
    String middle = p.substring(front ? 1 : 0, p.length() - (back ? 1 : 0));
    if (front && back) return host.contains(middle);
    if (front) return host.endsWith(middle);
    if (back) return host.startsWith(middle);
    return host.equals(middle);
  }

  /** Apache's planners whose determineProxy the advice reaches; subclasses aren't asked. */
  static final String APACHE_4 = Hooks.APACHE_4.replace('/', '.');

  static final String APACHE_5 = Hooks.APACHE_5.replace('/', '.');

  /**
   * Wirescry's proxy as the HttpHost Apache HttpClient's DefaultRoutePlanner.determineProxy
   * returns, instead of its null (connect directly), or null to keep that. Called by the code the
   * weaver puts there (com.wirescry.agent.weaver.ApacheAdvice), only when the answer was null.
   *
   * <p>Only for the planner itself, not a subclass: the fixed-proxy planner and the one that asks
   * the JDK's proxy selector (and that one already gets Wirescry's proxy from it) are
   * subclasses, as is any of the program's own. The same rules as {@link #select} decide: the
   * agent on, http or https, not this computer, not in the program's `http.nonProxyHosts`
   * (Apache doesn't read it itself, so this applies the program's own setting; the JDK's
   * net.properties default isn't read here). And never for a request over a Unix domain socket
   * (5.6 and later), nor from 5.x's HTTP/2-only client: neither can go through a proxy.
   *
   * <p>`target` is Apache's HttpHost, `context` its HttpContext. The answer is an HttpHost of the
   * class `target` is, so the one the program uses.
   */
  public static Object apache(Object planner, Object target, Object context) {
    try {
      if (planner == null || target == null || !Agent.isOn()) return null;
      Class<?> type = planner.getClass();
      boolean v4 = APACHE_4.equals(type.getName());
      if (!v4 && !APACHE_5.equals(type.getName())) return null;
      Control control = Agent.settings();
      if (control == null || !control.enabled) return null;
      Class<?> hostType = target.getClass();
      String scheme = (String) hostType.getMethod("getSchemeName").invoke(target);
      if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return null;
      String host = (String) hostType.getMethod("getHostName").invoke(target);
      if (host == null || host.isEmpty()) return null;
      host = host.toLowerCase(Locale.ROOT);
      // A bare IPv6 address, as Apache keeps it: bracketed, as a URI names it.
      if (host.indexOf(':') >= 0 && !host.startsWith("[")) host = "[" + host + "]";
      if (thisComputer(host) || excluded(System.getProperty("http.nonProxyHosts"), host)) return null;
      if (!v4 && (overUnixSocket(type, context) || fromH2OnlyClient())) return null;
      return apacheHost(hostType, v4, control.proxyPort);
    } catch (Throwable t) {
      return null;
    }
  }

  /**
   * Whether a 5.x request goes over a Unix domain socket (RequestConfig.getUnixDomainSocket, 5.6
   * and later). DefaultRoutePlanner asks for a proxy before it checks, and refuses one there
   * ("Proxies are not supported over Unix domain sockets"). Read as the planner reads it:
   * HttpClientContext.cast(context).getRequestConfigOrDefault(). A version without the setting
   * has no sockets. One with it whose request can't be read: yes, better direct than broken.
   */
  static boolean overUnixSocket(Class<?> plannerType, Object context) {
    ClassLoader loader = plannerType.getClassLoader();
    boolean hasSockets;
    try {
      Class.forName("org.apache.hc.client5.http.config.RequestConfig", false, loader).getMethod("getUnixDomainSocket");
      hasSockets = true;
    } catch (Throwable t) {
      hasSockets = false;
    }
    if (!hasSockets) return false;
    // No context: the planner reads the default settings, which name no socket.
    if (context == null) return false;
    Object config;
    try {
      Class<?> contexts =
          Class.forName("org.apache.hc.client5.http.protocol.HttpClientContext", false, plannerType.getClassLoader());
      Class<?> httpContext =
          Class.forName("org.apache.hc.core5.http.protocol.HttpContext", false, plannerType.getClassLoader());
      Object client;
      try {
        client = contexts.getMethod("cast", httpContext).invoke(null, context);
      } catch (NoSuchMethodException e) {
        client = contexts.getMethod("adapt", httpContext).invoke(null, context);
      }
      try {
        config = contexts.getMethod("getRequestConfigOrDefault").invoke(client);
      } catch (NoSuchMethodException e) {
        config = contexts.getMethod("getRequestConfig").invoke(client);
      }
      if (config == null) return false;
      return config.getClass().getMethod("getUnixDomainSocket").invoke(config) != null;
    } catch (Throwable t) {
      return true;
    }
  }

  static final String H2_ONLY_CLIENT = "org.apache.hc.client5.http.impl.async.InternalH2AsyncClient";

  /**
   * Whether 5.x's HTTP/2-only async client (H2AsyncClientBuilder) is asking. It uses this planner
   * too, but can't go through a proxy: its https requests would fail ("HTTP/2 tunneling not
   * supported") where they'd work without the agent. Its plain http ignores a proxy anyway. Read
   * from the caller's stack, only when the answer would otherwise be Wirescry's proxy: with Java
   * 9's StackWalker where there is one (it stops at the first match, and reads no line numbers),
   * else the whole stack.
   */
  static boolean fromH2OnlyClient() {
    Boolean walked = H2Walker.walk();
    if (walked != null) return walked;
    for (StackTraceElement frame : Thread.currentThread().getStackTrace()) {
      if (H2_ONLY_CLIENT.equals(frame.getClassName())) return true;
    }
    return false;
  }

  /** The StackWalker route (Java 9+), by reflection: the agent is built for Java 8. */
  static final class H2Walker {
    private static final Object WALKER;
    private static final java.lang.reflect.Method WALK;
    private static final java.lang.reflect.Method CLASS_NAME;

    static {
      Object walker = null;
      java.lang.reflect.Method walk = null;
      java.lang.reflect.Method className = null;
      try {
        Class<?> type = Class.forName("java.lang.StackWalker");
        walker = type.getMethod("getInstance").invoke(null);
        walk = type.getMethod("walk", java.util.function.Function.class);
        className = Class.forName("java.lang.StackWalker$StackFrame").getMethod("getClassName");
      } catch (Throwable t) {
        walker = null;
      }
      WALKER = walker;
      WALK = walk;
      CLASS_NAME = className;
    }

    private H2Walker() {}

    /** Whether the client is on the stack, or null without a StackWalker. */
    static Boolean walk() {
      if (WALKER == null) return null;
      try {
        return (Boolean)
            WALK.invoke(
                WALKER,
                new java.util.function.Function<java.util.stream.Stream<?>, Boolean>() {
                  @Override
                  public Boolean apply(java.util.stream.Stream<?> frames) {
                    return frames.anyMatch(
                        new java.util.function.Predicate<Object>() {
                          @Override
                          public boolean test(Object frame) {
                            try {
                              return H2_ONLY_CLIENT.equals(CLASS_NAME.invoke(frame));
                            } catch (Exception e) {
                              return false;
                            }
                          }
                        });
                  }
                });
      } catch (Throwable t) {
        return null;
      }
    }
  }

  /**
   * 127.0.0.1 at `port`, as `hostType` (the program's HttpHost), with its address given so nothing
   * is looked up. 4.x takes (InetAddress, String, int, String) from 4.4, (InetAddress, int,
   * String) before (the address's name is the one given here, so it isn't looked up either);
   * 5.x takes (String scheme, InetAddress, String, int). Made each time: kept, it would keep the
   * program's class loader from ever being freed.
   */
  private static Object apacheHost(Class<?> hostType, boolean v4, int port) throws Exception {
    InetAddress loopback = InetAddress.getByAddress("127.0.0.1", new byte[] {127, 0, 0, 1});
    if (!v4) {
      return hostType
          .getConstructor(String.class, InetAddress.class, String.class, int.class)
          .newInstance("http", loopback, "127.0.0.1", port);
    }
    try {
      return hostType
          .getConstructor(InetAddress.class, String.class, int.class, String.class)
          .newInstance(loopback, "127.0.0.1", port, "http");
    } catch (NoSuchMethodException e) {
      return hostType.getConstructor(InetAddress.class, int.class, String.class).newInstance(loopback, port, "http");
    }
  }

  private static Proxy proxy(int port) throws Exception {
    Proxy p = last;
    if (p != null && ((InetSocketAddress) p.address()).getPort() == port) return p;
    // An address, not a name: nothing to look up, and nothing a hosts file can change.
    InetAddress loopback = InetAddress.getByAddress("127.0.0.1", new byte[] {127, 0, 0, 1});
    p = new Proxy(Proxy.Type.HTTP, new InetSocketAddress(loopback, port));
    last = p;
    return p;
  }
}
