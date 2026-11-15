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
 * does the JDK's: Apache HttpClient's DefaultRoutePlanner, 4.x and 5.x, its determineProxy (see
 * ApacheAdvice), and 5.x's SystemDefaultRoutePlanner, its determineProxy (see
 * ApacheSystemAdvice). The class loader is given too, to read the Apache classes it names.
 */
public final class ProgramWeaver implements Function<Object[], byte[]> {
  public static final String APACHE_4 = "org/apache/http/impl/conn/DefaultRoutePlanner";
  public static final String APACHE_5 = "org/apache/hc/client5/http/impl/routing/DefaultRoutePlanner";
  public static final String APACHE_5_SYSTEM = "org/apache/hc/client5/http/impl/routing/SystemDefaultRoutePlanner";

  /**
   * Weaves a class of the program's: `{internal name, bytes, class loader}`, the loader null for
   * the boot loader. Returns null for a class it doesn't change, including a SystemDefaultRoutePlanner
   * without the determineProxy it hooks (nothing is broken without that hook: see
   * ApacheSystemAdvice). A DefaultRoutePlanner without one throws: Apache's main hook is lost.
   */
  @Override
  public byte[] apply(Object[] request) {
    String internalName = (String) request[0];
    byte[] bytes = (byte[]) request[1];
    ClassLoader loader = (ClassLoader) request[2];
    String host;
    if (APACHE_4.equals(internalName)) host = "org.apache.http.HttpHost";
    else if (APACHE_5.equals(internalName) || APACHE_5_SYSTEM.equals(internalName)) host = "org.apache.hc.core5.http.HttpHost";
    else return null;
    Class<?> advice = APACHE_5_SYSTEM.equals(internalName) ? ApacheSystemAdvice.class : ApacheAdvice.class;
    String name = internalName.replace('/', '.');
    ClassFileLocator target = ClassFileLocator.Simple.of(name, bytes);
    ClassFileLocator mine = ClassFileLocator.ForClassLoader.of(Weaver.class.getClassLoader());
    ClassFileLocator program =
        loader == null ? ClassFileLocator.ForClassLoader.ofBootLoader() : ClassFileLocator.ForClassLoader.of(loader);
    ClassFileLocator all =
        new ClassFileLocator.Compound(target, mine, program, ClassFileLocator.ForClassLoader.ofBootLoader());
    // Lazy: Apache's other classes are read only if needed, and their names come from descriptors.
    TypePool pool = new TypePool.Default.WithLazyResolution(new TypePool.CacheProvider.Simple(), all, TypePool.Default.ReaderMode.FAST);
    TypeDescription type = pool.describe(name).resolve();
    ElementMatcher.Junction<MethodDescription> determineProxy =
        ElementMatchers.<MethodDescription>named("determineProxy")
            .and(ElementMatchers.not(ElementMatchers.isStatic()))
            .and(ElementMatchers.returns(ElementMatchers.named(host)))
            .and(ElementMatchers.takesArgument(0, ElementMatchers.named(host)));
    // Each version has one; a later one could add an overload that calls it, which ApacheAdvice
    // leaves alone (it acts only on an answer of null), and ApacheSystemAdvice too (it changes
    // only Wirescry's own proxy, to null).
    if (type.getDeclaredMethods().filter(determineProxy).isEmpty()) {
      if (advice == ApacheSystemAdvice.class) return null;
      throw new IllegalStateException(name + " has no determineProxy to hook");
    }
    return new ByteBuddy()
        .with(Implementation.Context.Disabled.Factory.INSTANCE)
        .redefine(type, target)
        .visit(Weaver.advice(pool, mine, advice).on(determineProxy))
        .make(pool)
        .getBytes();
  }

}
