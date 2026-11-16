/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.util.Locale;
import java.util.function.Predicate;
import java.util.function.Supplier;

/**
 * Sends Reactor Netty's HttpClient (1.0 to 1.3, and so Spring's WebClient on it) through
 * Wirescry's proxy. Reactor Netty asks no proxy selector: a client has a proxy only if the program
 * gave it one. Every connection attempt, redirects and retries included, passes through
 * HttpConnectionProvider.acquire(config, observer, remote, resolver), with the request's own copy
 * of the settings already made (TLS chosen, the program's proxy applied). ReactorNettyAdvice, at
 * the start of that method, asks {@link #acquire} for a config and resolver to use instead.
 *
 * <p>When the program chose no proxy, and the request can go through one, the answer is a copy of
 * the config with Wirescry's proxy, and Netty's no-op resolver when the program chose none of its
 * own, so the host name reaches Wirescry rather than being looked up here. The program's config
 * is never written: Reactor Netty shares it between requests. A copy with a proxy makes its own
 * pool of connections (the pool's key includes the proxy), so turning off sends the next attempt to
 * the direct pool, and a new port to a new one.
 *
 * <p>Left alone: a program's own proxy; requests to this computer and to hosts in
 * `http.nonProxyHosts`; plain http with h2c (an upgrade inside the tunnel) or h2c alone; anything
 * with HTTP/3 (QUIC can't go through an HTTP proxy); addresses that aren't host and port (a Unix
 * socket); and programs without Netty's proxy support (netty-handler-proxy, optional), counted
 * apart for the status file.
 *
 * <p>One proxy of the program's is Wirescry's own: a terminal Wirescry set up gives the JDK's proxy
 * properties, which `proxyWithSystemProperties()` reads once, when the client is built. After
 * Wirescry quits, that client would send every request to a closed port, and after Wirescry moves
 * to another port, to the old one. So a provider at 127.0.0.1 on a port that has been Wirescry's
 * ({@link Agent#wirescryPort}) follows Wirescry: dropped once it's gone, moved when it moves.
 *
 * <p>All of Reactor Netty is reached by reflection, from the config's class loader, through what
 * {@link #lib} found for that copy of the library.
 */
public final class ReactorNetty {
  private static final String CONFIG = "reactor.netty.http.client.HttpClientConfig";
  private static final String TRANSPORT_CONFIG = "reactor.netty.transport.ClientTransportConfig";
  private static final String PROXY_PROVIDER = "reactor.netty.transport.ProxyProvider";
  private static final String PROXY_HANDLER = "io.netty.handler.proxy.HttpProxyHandler";

  /**
   * Set when the hook ran but Reactor Netty's classes weren't the shape it needs (a constructor or
   * method missing): the status file then says `reactor-netty:failed` rather than ok.
   */
  static volatile boolean broken;

  /** Set when a program's Reactor Netty has no proxy support (netty-handler-proxy isn't there). */
  static volatile boolean noProxyHandler;

  private ReactorNetty() {}

  /** What the hook needs of one copy of Reactor Netty, found once per HttpClientConfig class. */
  private static final ClassValue<Lib> LIBS =
      new ClassValue<Lib>() {
        @Override
        protected Lib computeValue(Class<?> type) {
          try {
            return new Lib(type);
          } catch (VirtualMachineError e) {
            // Out of memory, or a deep stack: nothing about Reactor Netty. Thrown, so nothing is
            // kept and the next request reads the library again (acquire's catch takes it).
            throw e;
          } catch (Throwable t) {
            broken = true;
            return null;
          }
        }
      };

  /** The answer for every address: always through the proxy (its caller already decided). */
  static final class AlwaysProxy implements Predicate<SocketAddress> {
    @Override
    public boolean test(SocketAddress address) {
      // ProxyProvider's predicate says which hosts go direct: none.
      return false;
    }
  }

  private static final AlwaysProxy ALWAYS_PROXY = new AlwaysProxy();

  /**
   * What the hook needs of one copy of Reactor Netty. Without Netty's proxy support
   * (netty-handler-proxy), only the config's own methods: ProxyProvider's name that library's
   * classes, so reading them would fail. What only the rule for Wirescry's own proxy needs is
   * optional ({@link #terminal}): a release without it still has the main rule.
   */
  static final class Lib {
    final Method hasProxy, protocols, sslProvider;
    /** Whether netty-handler-proxy is there. */
    final boolean proxyHandler;
    final Constructor<?> copy;
    final Method setProxy, resolver, nameResolverProvider, proxyProvider;
    /** The resolvers acquire takes (AddressResolverGroup), from the library's loader. */
    final Class<?> resolverType;
    final Object noop;
    /**
     * The default name resolver runOn puts in a config the program gave none (one object, shared),
     * or null if this release has none to read: then any resolver set counts as the program's.
     */
    final Object defaultNameResolverProvider;
    final Method builder, type, host, port, predicate, build;
    final Object http;
    /** Whether the rule for Wirescry's own proxy can run: the getters below are there. */
    final boolean terminal;
    final Method providerType, providerAddress, providerPredicate;
    /** Null on 1.0.0, which has no public one. */
    final Method defaultResolver;
    final Object jdkResolver;

    Lib(Class<?> config) throws Exception {
      ClassLoader loader = config.getClassLoader();
      Class<?> transport = Class.forName(TRANSPORT_CONFIG, false, loader);
      hasProxy = transport.getMethod("hasProxy");
      protocols = config.getMethod("protocols");
      sslProvider = config.getMethod("sslProvider");
      boolean handler;
      try {
        Class.forName(PROXY_HANDLER, false, loader);
        handler = true;
      } catch (ClassNotFoundException e) {
        handler = false;
      }
      proxyHandler = handler;
      if (!handler) {
        copy = null;
        setProxy = resolver = nameResolverProvider = proxyProvider = defaultResolver = null;
        resolverType = null;
        noop = jdkResolver = defaultNameResolverProvider = http = null;
        builder = type = host = port = predicate = build = null;
        providerType = providerAddress = providerPredicate = null;
        terminal = false;
        return;
      }
      Class<?> provider = Class.forName(PROXY_PROVIDER, false, loader);
      copy = config.getDeclaredConstructor(config);
      copy.setAccessible(true);
      setProxy = config.getDeclaredMethod("proxyProvider", provider);
      setProxy.setAccessible(true);
      resolver = transport.getMethod("resolver");
      nameResolverProvider = transport.getMethod("getNameResolverProvider");
      proxyProvider = transport.getMethod("proxyProvider");
      resolverType = Class.forName("io.netty.resolver.AddressResolverGroup", false, loader);
      noop = Class.forName("io.netty.resolver.NoopAddressResolverGroup", false, loader).getField("INSTANCE").get(null);
      // By identity: equal providers aren't the same choice (before 1.3, equality leaves out a
      // hosts-file resolver the program set).
      Object names;
      try {
        java.lang.reflect.Field f = transport.getDeclaredField("DEFAULT_NAME_RESOLVER_PROVIDER");
        f.setAccessible(true);
        names = f.get(null);
      } catch (NoSuchFieldException e) {
        names = null;
      }
      defaultNameResolverProvider = names;
      // ProxyProvider.builder().type(HTTP).host(h).port(p).nonProxyHostsPredicate(q).build(), by
      // the public interfaces (the builder's class isn't public).
      builder = provider.getMethod("builder");
      type = Class.forName(PROXY_PROVIDER + "$TypeSpec", false, loader).getMethod("type", Class.forName(PROXY_PROVIDER + "$Proxy", false, loader));
      host = Class.forName(PROXY_PROVIDER + "$AddressSpec", false, loader).getMethod("host", String.class);
      Class<?> b = Class.forName(PROXY_PROVIDER + "$Builder", false, loader);
      port = b.getMethod("port", int.class);
      predicate = b.getMethod("nonProxyHostsPredicate", Predicate.class);
      build = b.getMethod("build");
      http = Class.forName(PROXY_PROVIDER + "$Proxy", false, loader).getField("HTTP").get(null);
      Method t = null, a = null, q = null, d = null;
      Object jdk = null;
      try {
        t = provider.getMethod("getType");
        q = provider.getMethod("getNonProxyHostsPredicate");
        // getSocketAddress from 1.2.0; getAddress before it (marked for removal after).
        try {
          a = provider.getMethod("getSocketAddress");
        } catch (NoSuchMethodException e) {
          a = provider.getMethod("getAddress");
        }
        jdk = Class.forName("io.netty.resolver.DefaultAddressResolverGroup", false, loader).getField("INSTANCE").get(null);
        try {
          d = config.getMethod("defaultAddressResolverGroup");
        } catch (NoSuchMethodException e) {
          d = null;
        }
      } catch (NoSuchMethodException e) {
        t = null;
      } catch (NoSuchFieldException e) {
        t = null;
      } catch (ClassNotFoundException e) {
        t = null;
      }
      terminal = t != null;
      providerType = t;
      providerAddress = a;
      providerPredicate = q;
      defaultResolver = d;
      jdkResolver = jdk;
    }

    Object provider(int proxyPort, Predicate<SocketAddress> direct) throws Exception {
      Object spec = type.invoke(builder.invoke(null), http);
      Object b = port.invoke(host.invoke(spec, "127.0.0.1"), proxyPort);
      return build.invoke(predicate.invoke(b, direct));
    }

    /**
     * A copy of `config` with `provider` (null: none). Only the field matters after acquire: the
     * channel initializer and the pool's key read it, not the supplier it may have come from.
     */
    Object copy(Object config, Object provider) throws Exception {
      Object c = copy.newInstance(config);
      setProxy.invoke(c, provider);
      return c;
    }

    /**
     * The pair to hand back, checked: acquire's resolver must be one of this library's, or the
     * advice would set the config and then fail on the resolver, leaving half a change.
     */
    Object[] pair(Object config, Object resolver) {
      return resolverType.isInstance(resolver) ? new Object[] {config, resolver} : null;
    }
  }

  /**
   * `{config, resolver}` for HttpConnectionProvider.acquire to use instead of its own, or null to
   * keep them. `config` is the request's HttpClientConfig, `remote` the Supplier of its address.
   */
  public static Object[] acquire(Object config, Object remote, Object resolver) {
    try {
      if (config == null || !CONFIG.equals(config.getClass().getName())) return null;
      Lib lib = LIBS.get(config.getClass());
      if (lib == null) return null;
      if (((Boolean) lib.hasProxy.invoke(config)).booleanValue()) {
        return lib.proxyHandler && lib.terminal ? followWirescry(lib, config, resolver) : null;
      }
      if (!Agent.isOn()) return null;
      Control control = Agent.settings();
      if (control == null || !control.enabled || control.proxyPort <= 0) return null;
      if (!protocolsAllowed(lib, config)) return null;
      if (!(remote instanceof Supplier)) return null;
      String host = hostOf(programValue((Supplier<?>) remote));
      if (host == null || Proxies.thisComputer(host) || excluded(host)) return null;
      if (!lib.proxyHandler) {
        noProxyHandler = true;
        return null;
      }
      Object copy = lib.copy(config, lib.provider(control.proxyPort, ALWAYS_PROXY));
      return lib.pair(copy, programResolver(lib, config) ? resolver : lib.noop);
    } catch (Throwable t) {
      // Reactor Netty's classes aren't the shape the hook reads: requests go direct, so say so. Not
      // for the JVM's own trouble (out of memory, a deep stack), which says nothing of Reactor.
      if (!(t instanceof VirtualMachineError)) broken = true;
      return null;
    }
  }

  /**
   * What a supplier of the program's (or one that may call the program's) answers, or null when it
   * throws: that's the program's trouble, not a sign of Reactor Netty's shape, so the request is
   * left alone without reporting the hook broken.
   */
  private static Object programValue(Supplier<?> supplier) {
    try {
      return supplier.get();
    } catch (VirtualMachineError e) {
      throw e;
    } catch (Throwable t) {
      return null;
    }
  }

  /** Whether the program's `http.nonProxyHosts` names `host`; true when it can't be read. */
  private static boolean excluded(String host) {
    try {
      return Proxies.excluded(System.getProperty("http.nonProxyHosts"), host);
    } catch (SecurityException e) {
      return true;
    }
  }

  /**
   * For a program with a proxy: when it's Wirescry's (HTTP, at 127.0.0.1, on a port Wirescry has
   * had), and Wirescry is gone, the config without it (and the resolver Reactor Netty would use
   * then); when Wirescry runs on another port, the config with that port, keeping the program's
   * hosts that go direct (Reactor Netty asks that rule itself, as it connects). Otherwise null.
   */
  private static Object[] followWirescry(Lib lib, Object config, Object resolver) throws Exception {
    Object provider = lib.proxyProvider.invoke(config);
    if (provider == null || lib.providerType.invoke(provider) != lib.http) return null;
    // A proxy on another kind of address (a Unix socket) can't be Wirescry's; on 1.2 and later
    // getAddress would throw for one, hence getSocketAddress first.
    Object address = programValue((Supplier<?>) lib.providerAddress.invoke(provider));
    if (!(address instanceof InetSocketAddress)) return null;
    InetSocketAddress proxy = (InetSocketAddress) address;
    if (!"127.0.0.1".equals(proxy.getHostString()) || !Agent.wirescryPort(proxy.getPort())) return null;
    int wirescry = Agent.wirescryState();
    if (wirescry == ProxyProperties.GONE) {
      Object copy = lib.copy(config, null);
      // proxyWithSystemProperties set the no-op resolver (there was no other): look up hosts again.
      Object own = lib.resolver.invoke(config);
      return lib.pair(copy, own == lib.noop ? defaultResolver(lib, config) : resolver);
    }
    if (wirescry != ProxyProperties.RUNNING) return null;
    Control control = Agent.settings();
    if (control == null || control.proxyPort <= 0 || control.proxyPort == proxy.getPort()) return null;
    // The program's own rule for which hosts go direct (localhost, its http.nonProxyHosts) is kept.
    @SuppressWarnings("unchecked")
    Predicate<SocketAddress> direct = (Predicate<SocketAddress>) lib.providerPredicate.invoke(provider);
    return lib.pair(lib.copy(config, lib.provider(control.proxyPort, direct)), resolver);
  }

  /**
   * Whether this request's protocols can go through an HTTP proxy: TLS (an SslProvider chosen) as
   * HTTP/1.1 or HTTP/2; plain http as HTTP/1.1 alone (with h2c it would upgrade inside the tunnel,
   * or speak h2c from the start); never with HTTP/3. Reactor Netty has already dropped the
   * protocols that don't fit the scheme.
   */
  private static boolean protocolsAllowed(Lib lib, Object config) throws Exception {
    Object[] protocols = (Object[]) lib.protocols.invoke(config);
    if (protocols == null) return false;
    boolean h1 = false, h2 = false, h2c = false;
    for (Object p : protocols) {
      String name = ((Enum<?>) p).name();
      if ("HTTP11".equals(name)) h1 = true;
      else if ("H2".equals(name)) h2 = true;
      else if ("H2C".equals(name)) h2c = true;
      else return false;
    }
    boolean tls = lib.sslProvider.invoke(config) != null;
    return tls ? h1 || h2 : h1 && !h2c;
  }

  /**
   * Whether the program chose a resolver of its own: not when it named none, nor when the field
   * holds the default name resolver Reactor Netty fills in (runOn sets that very object). Either
   * `.resolver` overload counts, the plain one leaving no NameResolverProvider at all.
   */
  private static boolean programResolver(Lib lib, Object config) throws Exception {
    if (lib.resolver.invoke(config) == null) return false;
    Object names = lib.nameResolverProvider.invoke(config);
    return names == null || names != lib.defaultNameResolverProvider;
  }

  /**
   * The resolver Reactor Netty uses with none set: the config's default, else the JDK's lookups.
   * Without metrics: a terminal client with `.metrics(...)` loses its DNS series once Wirescry is
   * gone.
   */
  private static Object defaultResolver(Lib lib, Object config) throws Exception {
    return lib.defaultResolver != null ? lib.defaultResolver.invoke(config) : lib.jdkResolver;
  }

  /** The host of a host-and-port address, lower case, an IPv6 one bracketed; else null. */
  static String hostOf(Object address) {
    if (!(address instanceof InetSocketAddress)) return null;
    String host = ((InetSocketAddress) address).getHostString();
    if (host == null || host.isEmpty()) return null;
    host = host.toLowerCase(Locale.ROOT);
    // getHostString gives an IPv6 address bare: bracketed, as a URI names it.
    if (host.indexOf(':') >= 0 && !host.startsWith("[")) host = "[" + host + "]";
    return host;
  }
}
