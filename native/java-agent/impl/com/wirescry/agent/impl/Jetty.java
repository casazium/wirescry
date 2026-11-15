/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Sends Jetty's HttpClient (9.4 to 12.1) through Wirescry's proxy. Jetty asks no proxy selector:
 * it has a ProxyConfiguration of its own, which it asks once per destination, and keeps a
 * destination per Origin (scheme, host and port, a tag, and in 10 and later the protocols) for
 * the client's life. So the agent decides per request, in two steps:
 *
 * <ol>
 *   <li>{@link #origin}, from the end of HttpClient.createOrigin (JettyOriginAdvice): when the
 *       request should go through Wirescry, the same Origin with a tag naming Wirescry's proxy,
 *       {@code wirescry-proxy@127.0.0.1:<port>}. A different Origin, so a different destination:
 *       turning off sends the next request to the untagged one, direct, and a new port makes a new
 *       one.
 *   <li>{@link #proxy}, from the end of ProxyConfiguration.match (JettyMatchAdvice): for an Origin
 *       with that tag and no proxy of the program's, Wirescry's proxy at the tag's port.
 * </ol>
 *
 * <p>A request is tagged only when all of these hold: the agent is on; the program's
 * ProxyConfiguration is Jetty's own, its hook is installed (Hooks.jettyMatchInstalled), and it
 * lists no proxies (so a host the program's own proxy excludes stays direct); the request has no
 * tag of its own; the scheme is http, https or wss (not ws: Jetty sends a ws URL as the request
 * line through a proxy, which Wirescry doesn't read); the host isn't this computer and isn't in
 * the program's `http.nonProxyHosts`; and the client and Origin can go through an HTTP proxy
 * ({@link #client}, {@link #originAllowed}). Everything else is left as Jetty made it.
 *
 * <p>All of Jetty is reached by reflection, by name, from the class loader of the client: the
 * agent is built for Java 8 against no Jetty, and the program may have several copies.
 */
public final class Jetty {
  static final String TAG = "wirescry-proxy@127.0.0.1:";
  private static final String CLIENT = "org.eclipse.jetty.client.HttpClient";
  private static final String ORIGIN = "org.eclipse.jetty.client.Origin";
  private static final String PROXY_CONFIGURATION = "org.eclipse.jetty.client.ProxyConfiguration";
  private static final String HTTP_PROXY = "org.eclipse.jetty.client.HttpProxy";
  private static final String PROXY_PROTOCOL = "org.eclipse.jetty.client.ProxyProtocolClientConnectionFactory";
  private static final String INFO = "org.eclipse.jetty.io.ClientConnectionFactory$Info";
  private static final String WRAPPER = "org.eclipse.jetty.io.ClientConnectionFactory$Wrapper";
  private static final String CONNECTOR = "org.eclipse.jetty.io.ClientConnector";
  private static final String CONFIGURATOR = "org.eclipse.jetty.io.ClientConnector$Configurator";
  private static final String TRANSPORT = "org.eclipse.jetty.io.Transport";
  /** The HTTP/1.1 transport: 9.4, 10 and 11, then 12. */
  private static final String OVER_HTTP_OLD = "org.eclipse.jetty.client.http.HttpClientTransportOverHTTP";
  private static final String OVER_HTTP_12 = "org.eclipse.jetty.client.transport.HttpClientTransportOverHTTP";
  /** The dynamic transport: 10 and 11, then 12. */
  private static final String DYNAMIC_OLD = "org.eclipse.jetty.client.dynamic.HttpClientTransportDynamic";
  private static final String DYNAMIC_12 = "org.eclipse.jetty.client.transport.HttpClientTransportDynamic";

  /** Each client's answer from {@link #client}, weakly: its transport can't change. */
  private static final Map<Object, Boolean> clients = Collections.synchronizedMap(new WeakHashMap<Object, Boolean>());

  private static final AtomicInteger skipped = new AtomicInteger();

  /**
   * Set when a hook ran but Jetty's classes weren't the shape it needs (a constructor or method
   * missing): the status file then says `jetty:failed` rather than ok.
   */
  static volatile boolean broken;

  private Jetty() {}

  /** How many of the program's clients {@link #client} left alone. */
  static int skipped() {
    return skipped.get();
  }

  /**
   * The Origin to use instead of `origin`, tagged for Wirescry's proxy, or null to keep Jetty's.
   * `client` is Jetty's HttpClient (or a subclass of it).
   */
  public static Object origin(Object client, Object origin) {
    try {
      if (client == null || origin == null || !Agent.isOn()) return null;
      Control control = Agent.settings();
      if (control == null || !control.enabled) return null;
      Class<?> type = origin.getClass();
      if (!ORIGIN.equals(type.getName())) return null;
      if (type.getMethod("getTag").invoke(origin) != null) return null;
      String scheme = String.valueOf(type.getMethod("getScheme").invoke(origin)).toLowerCase(Locale.ROOT);
      if (!"http".equals(scheme) && !"https".equals(scheme) && !"wss".equals(scheme)) return null;
      // Through Jetty's own class: a subclass of the program's may not be public.
      Class<?> jetty = jettyClient(client.getClass());
      if (jetty == null) return null;
      Object configuration = jetty.getMethod("getProxyConfiguration").invoke(client);
      if (configuration == null) return null;
      Class<?> configurationType = configuration.getClass();
      // A subclass is the program's own: left alone, as Apache's planners are.
      if (!PROXY_CONFIGURATION.equals(configurationType.getName())) return null;
      if (!Hooks.jettyMatchInstalled(configurationType)) return null;
      List<?> proxies = (List<?>) configurationType.getMethod("getProxies").invoke(configuration);
      if (proxies == null || !proxies.isEmpty()) return null;
      Object address = type.getMethod("getAddress").invoke(origin);
      String host = (String) address.getClass().getMethod("getHost").invoke(address);
      if (host == null || host.isEmpty()) return null;
      host = host.toLowerCase(Locale.ROOT);
      // A bare IPv6 address (9.4 strips the brackets): bracketed, as a URI names it.
      if (host.indexOf(':') >= 0 && !host.startsWith("[")) host = "[" + host + "]";
      if (Proxies.thisComputer(host) || Proxies.excluded(System.getProperty("http.nonProxyHosts"), host)) return null;
      // The client first: one that can't use a proxy at all is counted, whatever it asks for.
      if (!client(client, jetty)) return null;
      if (!originAllowed(origin, type, scheme)) return null;
      return tagged(origin, type, address, TAG + control.proxyPort);
    } catch (Throwable t) {
      // Jetty's classes aren't the shape the hook reads: every request goes direct, so say so. Not
      // for the JVM's own trouble (out of memory, a deep stack), which says nothing of Jetty.
      if (!(t instanceof VirtualMachineError)) broken = true;
      return null;
    }
  }

  /**
   * Wirescry's proxy, an HttpProxy at 127.0.0.1 on the port the tag names, when `origin` carries
   * the tag {@link #origin} gave it; else null. Made each time, from the Origin's class loader:
   * kept, it would hold that loader. Not the switch's to decide: the tag already did.
   */
  public static Object proxy(Object origin) {
    try {
      if (origin == null) return null;
      Object tag = origin.getClass().getMethod("getTag").invoke(origin);
      if (!(tag instanceof String) || !((String) tag).startsWith(TAG)) return null;
      int port = Integer.parseInt(((String) tag).substring(TAG.length()));
      return Class.forName(HTTP_PROXY, false, origin.getClass().getClassLoader())
          .getConstructor(String.class, int.class)
          .newInstance("127.0.0.1", port);
    } catch (Throwable t) {
      broken = true;
      return null;
    }
  }

  /**
   * Whether this Origin can go through an HTTP proxy, by the protocols Jetty chose for it (10 and
   * later; 9.4's Origin has none, and its HTTP/1.1 transport has only HTTP/1.1): plain http only
   * as HTTP/1.1, since the hop to Wirescry is HTTP/1.1 and h2c would mean a CONNECT to a plain
   * port; https and wss as HTTP/1.1 or HTTP/2 inside the tunnel, never HTTP/3. In 12 its transport
   * must be TCP/IP (not a Unix socket, QUIC or memory).
   */
  static boolean originAllowed(Object origin, Class<?> type, String scheme) throws Exception {
    Method getProtocol = method(type, "getProtocol");
    if (getProtocol != null) {
      Object protocol = getProtocol.invoke(origin);
      if (protocol == null) return false;
      List<?> names = (List<?>) protocol.getClass().getMethod("getProtocols").invoke(protocol);
      if (names == null || names.contains("h3")) return false;
      boolean h1 = names.contains("http/1.1");
      if ("http".equals(scheme) ? !h1 : !h1 && !names.contains("h2")) return false;
    }
    Method getTransport = method(type, "getTransport");
    if (getTransport != null) {
      Object tcp = Class.forName(TRANSPORT, false, type.getClassLoader()).getField("TCP_IP").get(null);
      if (getTransport.invoke(origin) != tcp) return false;
    }
    return true;
  }

  /**
   * Whether `client` can go through an HTTP proxy at all, once per client: its transport exactly
   * Jetty's HTTP/1.1 one or its dynamic one (not HTTP/2-only, FastCGI, HTTP/3, Unix sockets, or
   * a subclass); a dynamic one with an HTTP/1.1 protocol (the hop to Wirescry) and no PROXY
   * protocol factory (it reads the Origin's tag as its own, and fails on Wirescry's); in 10 and 11,
   * a connector that isn't for a Unix socket. Clients left alone are counted for the status file,
   * and the count only grows: a client the program drops stays counted.
   */
  static boolean client(Object client, Class<?> jetty) {
    Boolean known = clients.get(client);
    if (known != null) return known.booleanValue();
    boolean answer;
    try {
      answer = clientAllowed(client, jetty);
    } catch (Throwable t) {
      // As in origin. Not kept: the next request asks again.
      if (t instanceof VirtualMachineError) return false;
      broken = true;
      answer = false;
    }
    if (clients.put(client, Boolean.valueOf(answer)) == null && !answer) skipped.incrementAndGet();
    return answer;
  }

  private static boolean clientAllowed(Object client, Class<?> jetty) throws Exception {
    // The hook that gives the proxy needs this; check it before tagging anything.
    Class.forName(HTTP_PROXY, false, jetty.getClassLoader()).getConstructor(String.class, int.class);
    Object transport = jetty.getMethod("getTransport").invoke(client);
    if (transport == null) return false;
    String name = transport.getClass().getName();
    boolean overHttp = OVER_HTTP_OLD.equals(name) || OVER_HTTP_12.equals(name);
    boolean dynamic = DYNAMIC_OLD.equals(name) || DYNAMIC_12.equals(name);
    if (!overHttp && !dynamic) return false;
    ClassLoader loader = transport.getClass().getClassLoader();
    if (dynamic && !dynamicAllowed(transport, loader)) return false;
    // Where Jetty has a Transport (later 12.0 releases on), a Unix socket shows as the Origin's
    // transport (originAllowed). Before that (10, 11, early 12.0) it's the connector's; 9.4 has
    // no ClientConnector here.
    if (optionalClass(TRANSPORT, loader) == null) {
      Method getConnector = method(transport.getClass(), "getClientConnector");
      if (getConnector != null && !connectorAllowed(getConnector.invoke(transport))) return false;
    }
    return true;
  }

  /** A dynamic transport: an HTTP/1.1 protocol among its own, and no PROXY protocol factory. */
  private static boolean dynamicAllowed(Object transport, ClassLoader loader) throws Exception {
    Class<?> info = Class.forName(INFO, false, loader);
    // The transport's own beans, by the public call (its fields are private, in a named module).
    Collection<?> infos =
        (Collection<?>) transport.getClass().getMethod("getBeans", Class.class).invoke(transport, info);
    if (infos == null || infos.isEmpty()) return false;
    // From the public type: an Info may be of a private class.
    Method getProtocols = info.getMethod("getProtocols", boolean.class);
    Method getFactory = info.getMethod("getClientConnectionFactory");
    Class<?> proxyProtocol = Class.forName(PROXY_PROTOCOL, false, loader);
    Class<?> wrapper = optionalClass(WRAPPER, loader);
    boolean h1 = false;
    for (Object i : infos) {
      List<?> names = (List<?>) getProtocols.invoke(i, Boolean.FALSE);
      if (names != null && names.contains("http/1.1")) h1 = true;
      Object factory = getFactory.invoke(i);
      // 12.1's wrappers name what they wrap; a few steps at most.
      for (int step = 0; factory != null && step < 8; step++) {
        if (proxyProtocol.isInstance(factory)) return false;
        if (wrapper == null || !wrapper.isInstance(factory)) break;
        factory = wrapper.getMethod("getWrapped").invoke(factory);
      }
    }
    return h1;
  }

  /**
   * Jetty 10, 11 and early 12.0: a connector for TCP/IP. One for a Unix socket has a Configurator
   * of its own kind (later 10.0 releases on), which the connector lists as a bean. Without that
   * class (10.0.0 and other early ones), only a connector with no way to make a Unix socket.
   */
  private static boolean connectorAllowed(Object connector) throws Exception {
    if (connector == null || !CONNECTOR.equals(connector.getClass().getName())) return false;
    Class<?> configurator = optionalClass(CONFIGURATOR, connector.getClass().getClassLoader());
    if (configurator == null) {
      for (Method m : connector.getClass().getMethods()) {
        if ("forUnixDomain".equals(m.getName())) return false;
      }
      return true;
    }
    Object bean = connector.getClass().getMethod("getBean", Class.class).invoke(connector, configurator);
    return bean != null && bean.getClass() == configurator;
  }

  /** The same Origin with `tag`, by the constructor this Jetty has. */
  private static Object tagged(Object origin, Class<?> type, Object address, String tag) throws Exception {
    Object scheme = type.getMethod("getScheme").invoke(origin);
    try {
      for (Constructor<?> c : type.getConstructors()) {
        Class<?>[] p = c.getParameterTypes();
        if (p.length == 5 && p[1] == address.getClass() && p[2] == Object.class && TRANSPORT.equals(p[4].getName())) {
          // 12: (scheme, address, tag, protocol, transport)
          return c.newInstance(scheme, address, tag, type.getMethod("getProtocol").invoke(origin), type.getMethod("getTransport").invoke(origin));
        }
      }
      for (Constructor<?> c : type.getConstructors()) {
        Class<?>[] p = c.getParameterTypes();
        if (p.length == 4 && p[1] == address.getClass() && p[2] == Object.class) {
          // 10 and 11: (scheme, address, tag, protocol)
          return c.newInstance(scheme, address, tag, type.getMethod("getProtocol").invoke(origin));
        }
      }
      for (Constructor<?> c : type.getConstructors()) {
        Class<?>[] p = c.getParameterTypes();
        if (p.length == 3 && p[1] == address.getClass() && p[2] == Object.class) {
          // 9.4: (scheme, address, tag)
          return c.newInstance(scheme, address, tag);
        }
      }
    } catch (Exception e) {
      broken = true;
      throw e;
    }
    broken = true;
    return null;
  }

  /** Jetty's HttpClient: `type` or the superclass of it with that name, or null. */
  private static Class<?> jettyClient(Class<?> type) {
    for (Class<?> c = type; c != null; c = c.getSuperclass()) {
      if (CLIENT.equals(c.getName())) return c;
    }
    return null;
  }

  /** A public method of `type` with no arguments, named `name`, or null. */
  private static Method method(Class<?> type, String name) {
    try {
      return type.getMethod(name);
    } catch (NoSuchMethodException e) {
      return null;
    }
  }

  private static Class<?> optionalClass(String name, ClassLoader loader) {
    try {
      return Class.forName(name, false, loader);
    } catch (ClassNotFoundException e) {
      return null;
    }
  }
}
