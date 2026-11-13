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
