/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.weaver;

import java.util.function.Function;
import net.bytebuddy.ByteBuddy;
import net.bytebuddy.description.method.MethodDescription;
import net.bytebuddy.description.type.TypeDescription;
import net.bytebuddy.dynamic.ClassFileLocator;
import net.bytebuddy.implementation.Implementation;
import net.bytebuddy.matcher.ElementMatcher;
import net.bytebuddy.matcher.ElementMatchers;
import net.bytebuddy.pool.TypePool;

/**
 * Weaves classes of the program's own, in whatever class loader the program loaded them, as Weaver
 * does the JDK's:
 *
 * <ul>
 *   <li>Apache HttpClient's DefaultRoutePlanner, 4.x and 5.x, its determineProxy (see
 *       ApacheAdvice), and 5.x's SystemDefaultRoutePlanner, its determineProxy (see
 *       ApacheSystemAdvice).
 *   <li>Jetty's HttpClient, its createOrigin (see JettyOriginAdvice), and its ProxyConfiguration,
 *       its match(Origin) (see JettyMatchAdvice), 9.4 to 12.1.
 *   <li>Reactor Netty's HttpConnectionProvider, its acquire (see ReactorNettyAdvice), 1.0 to 1.3.
 * </ul>
 *
 * The class loader is given too, to read the classes the methods name.
 */
public final class ProgramWeaver implements Function<Object[], byte[]> {
  public static final String APACHE_4 = "org/apache/http/impl/conn/DefaultRoutePlanner";
  public static final String APACHE_5 = "org/apache/hc/client5/http/impl/routing/DefaultRoutePlanner";
  public static final String APACHE_5_SYSTEM = "org/apache/hc/client5/http/impl/routing/SystemDefaultRoutePlanner";
  public static final String JETTY_CLIENT = "org/eclipse/jetty/client/HttpClient";
  public static final String JETTY_PROXY_CONFIGURATION = "org/eclipse/jetty/client/ProxyConfiguration";
  private static final String JETTY_ORIGIN = "org.eclipse.jetty.client.Origin";
  public static final String REACTOR_NETTY = "reactor/netty/http/client/HttpConnectionProvider";
  /** How an exception's message starts for a release of a library the hooks don't cover. */
  public static final String NOT_COVERED = "not-covered: ";

  /**
   * Weaves a class of the program's: `{internal name, bytes, class loader}`, the loader null for
   * the boot loader. Returns null for a class it doesn't change, including a SystemDefaultRoutePlanner
   * without the determineProxy it hooks (nothing is broken without that hook: see
   * ApacheSystemAdvice). Any other class without the method its hook needs throws: that library's
   * hook is lost, which the status file reports.
   */
  @Override
  public byte[] apply(Object[] request) {
    String internalName = (String) request[0];
    byte[] bytes = (byte[]) request[1];
    ClassLoader loader = (ClassLoader) request[2];
    ElementMatcher.Junction<MethodDescription> method;
    Class<?> advice;
    if (APACHE_4.equals(internalName) || APACHE_5.equals(internalName) || APACHE_5_SYSTEM.equals(internalName)) {
      String host = APACHE_4.equals(internalName) ? "org.apache.http.HttpHost" : "org.apache.hc.core5.http.HttpHost";
      advice = APACHE_5_SYSTEM.equals(internalName) ? ApacheSystemAdvice.class : ApacheAdvice.class;
      method =
          ElementMatchers.<MethodDescription>named("determineProxy")
              .and(ElementMatchers.not(ElementMatchers.isStatic()))
              .and(ElementMatchers.returns(ElementMatchers.named(host)))
              .and(ElementMatchers.takesArgument(0, ElementMatchers.named(host)));
    } else if (JETTY_CLIENT.equals(internalName)) {
      // One in each line, its arguments differing: (String, String, int, Object) in 9.4,
      // (HttpRequest, Origin.Protocol) in 10 and 11, (Request, Origin.Protocol) in 12.
      advice = JettyOriginAdvice.class;
      method =
          ElementMatchers.<MethodDescription>named("createOrigin")
              .and(ElementMatchers.not(ElementMatchers.isStatic()))
              .and(ElementMatchers.returns(ElementMatchers.named(JETTY_ORIGIN)));
    } else if (JETTY_PROXY_CONFIGURATION.equals(internalName)) {
      advice = JettyMatchAdvice.class;
      method =
          ElementMatchers.<MethodDescription>named("match")
              .and(ElementMatchers.not(ElementMatchers.isStatic()))
              .and(ElementMatchers.takesArguments(1))
              .and(ElementMatchers.takesArgument(0, ElementMatchers.named(JETTY_ORIGIN)));
    } else if (REACTOR_NETTY.equals(internalName)) {
      // acquire(TransportConfig, ConnectionObserver, Supplier, AddressResolverGroup), the same in
      // every release from 1.0.0.
      advice = ReactorNettyAdvice.class;
      method =
          ElementMatchers.<MethodDescription>named("acquire")
              .and(ElementMatchers.not(ElementMatchers.isStatic()))
              .and(ElementMatchers.takesArguments(4))
              .and(ElementMatchers.takesArgument(0, ElementMatchers.named("reactor.netty.transport.TransportConfig")))
              .and(ElementMatchers.takesArgument(3, ElementMatchers.named("io.netty.resolver.AddressResolverGroup")));
    } else {
      return null;
    }
    String name = internalName.replace('/', '.');
    ClassFileLocator target = ClassFileLocator.Simple.of(name, bytes);
    ClassFileLocator mine = ClassFileLocator.ForClassLoader.of(Weaver.class.getClassLoader());
    ClassFileLocator program =
        loader == null ? ClassFileLocator.ForClassLoader.ofBootLoader() : ClassFileLocator.ForClassLoader.of(loader);
    ClassFileLocator all =
        new ClassFileLocator.Compound(target, mine, program, ClassFileLocator.ForClassLoader.ofBootLoader());
    // Lazy: the library's other classes are read only if needed, and their names come from descriptors.
    TypePool pool = new TypePool.Default.WithLazyResolution(new TypePool.CacheProvider.Simple(), all, TypePool.Default.ReaderMode.FAST);
    TypeDescription type = pool.describe(name).resolve();
    // Each version has one; a later one could add an overload that calls it. Apache's advice
    // leaves that alone (it acts only on an answer of null), as Jetty's do (an Origin already
    // tagged, or a proxy already found, is left as it is).
    if (type.getDeclaredMethods().filter(method).isEmpty()) {
      if (advice == ApacheSystemAdvice.class) return null;
      // Jetty 9.4 before 9.4.25 makes destinations by scheme, host and port alone, with no tag
      // (and no createOrigin) to tell Wirescry's apart: a release the hook doesn't cover.
      if (advice == JettyOriginAdvice.class) throw new IllegalStateException(NOT_COVERED + name);
      throw new IllegalStateException(name + " has no method to hook");
    }
    return new ByteBuddy()
        .with(Implementation.Context.Disabled.Factory.INSTANCE)
        .redefine(type, target)
        .visit(Weaver.advice(pool, mine, advice).on(method))
        .make(pool)
        .getBytes();
  }
}
