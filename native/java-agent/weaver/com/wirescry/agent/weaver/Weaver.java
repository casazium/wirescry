/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.weaver;

import java.net.Socket;
import java.net.URI;
import java.security.cert.X509Certificate;
import java.util.List;
import java.util.function.BiFunction;
import javax.net.ssl.SSLEngine;
import net.bytebuddy.ByteBuddy;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.description.method.MethodDescription;
import net.bytebuddy.description.type.TypeDescription;
import net.bytebuddy.dynamic.ClassFileLocator;
import net.bytebuddy.dynamic.DynamicType;
import net.bytebuddy.implementation.Implementation;
import net.bytebuddy.matcher.ElementMatcher;
import net.bytebuddy.matcher.ElementMatchers;
import net.bytebuddy.pool.TypePool;

/**
 * Puts the agent's advice into the JDK classes it changes, given each class's bytes. Runs in the
 * agent's weaver class loader, with Byte Buddy, which the program never sees
 * (com.wirescry.agent.impl.Hooks).
 *
 * <ul>
 *   <li>The JDK's X.509 trust manager: one advice per public checkServerTrusted overload, matched
 *       by its exact parameters, so an overload a later JDK adds (such as one for QUIC) is left
 *       alone. See Trust*Advice.
 *   <li>The JDK's default proxy selector: its public select(URI). See ProxyAdvice.
 * </ul>
 *
 * <p>Each method it changes must be there: a JDK without one fails the hook, which the status file
 * then reports, rather than quietly changing nothing.
 *
 * <p>Only method bodies change, with no fields or methods added (Implementation.Context is
 * disabled), so the same bytes work when the class is first loaded and when it's retransformed in
 * a program that's already running.
 *
 * <p>Each advice's code is copied into the JDK class, where only the JDK's own classes can be
 * named: it uses java.* types alone, and reaches the agent's com.wirescry.agent.impl classes
 * through the system class loader by name. Anything that goes wrong in it is suppressed, and the
 * JDK's own answer stands.
 */
public final class Weaver implements BiFunction<String, byte[], byte[]> {
  public static final String TRUST_MANAGER = "sun/security/ssl/X509TrustManagerImpl";
  public static final String PROXY_SELECTOR = "sun/net/spi/DefaultProxySelector";

  @Override
  public byte[] apply(String internalName, byte[] bytes) {
    String name = internalName.replace('/', '.');
    ClassFileLocator target = ClassFileLocator.Simple.of(name, bytes);
    ClassFileLocator mine = ClassFileLocator.ForClassLoader.of(Weaver.class.getClassLoader());
    ClassFileLocator all =
        new ClassFileLocator.Compound(target, mine, ClassFileLocator.ForClassLoader.ofBootLoader());
    TypePool pool = TypePool.Default.of(all);
    TypeDescription type = pool.describe(name).resolve();
    DynamicType.Builder<?> builder =
        new ByteBuddy().with(Implementation.Context.Disabled.Factory.INSTANCE).redefine(type, target);
    if (TRUST_MANAGER.equals(internalName)) {
      builder =
          builder
              .visit(advice(pool, mine, TrustPlainAdvice.class).on(needed(type, checkServerTrusted())))
              .visit(advice(pool, mine, TrustSocketAdvice.class).on(needed(type, checkServerTrusted(Socket.class))))
              .visit(advice(pool, mine, TrustEngineAdvice.class).on(needed(type, checkServerTrusted(SSLEngine.class))));
    } else if (PROXY_SELECTOR.equals(internalName)) {
      builder = builder.visit(advice(pool, mine, ProxyAdvice.class).on(needed(type, select())));
    } else {
      return null;
    }
    return builder.make(pool).getBytes();
  }

  private static Advice advice(TypePool pool, ClassFileLocator locator, Class<?> type) {
    return Advice.to(pool.describe(type.getName()).resolve(), locator);
  }

  /** `method`, after checking `type` declares exactly one method it matches. */
  private static ElementMatcher.Junction<MethodDescription> needed(
      TypeDescription type, ElementMatcher.Junction<MethodDescription> method) {
    int found = type.getDeclaredMethods().filter(method).size();
    if (found != 1) throw new IllegalStateException(type.getName() + " has " + found + " methods to hook, not 1");
    return method;
  }

  /** Public checkServerTrusted(X509Certificate[], String[, third]). */
  private static ElementMatcher.Junction<MethodDescription> checkServerTrusted(Class<?>... third) {
    Class<?>[] parameters = new Class<?>[2 + third.length];
    parameters[0] = X509Certificate[].class;
    parameters[1] = String.class;
    System.arraycopy(third, 0, parameters, 2, third.length);
    return ElementMatchers.named("checkServerTrusted")
        .and(ElementMatchers.isPublic())
        .and(ElementMatchers.takesArguments(parameters));
  }

  /** Public List select(URI). */
  private static ElementMatcher.Junction<MethodDescription> select() {
    return ElementMatchers.named("select")
        .and(ElementMatchers.isPublic())
        .and(ElementMatchers.takesArguments(URI.class))
        .and(ElementMatchers.returns(List.class));
  }
}
