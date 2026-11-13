/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.weaver;

import java.net.Socket;
import java.security.cert.X509Certificate;
import java.util.function.BiFunction;
import javax.net.ssl.SSLEngine;
import net.bytebuddy.ByteBuddy;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.description.method.MethodDescription;
import net.bytebuddy.dynamic.ClassFileLocator;
import net.bytebuddy.implementation.Implementation;
import net.bytebuddy.matcher.ElementMatcher;
import net.bytebuddy.matcher.ElementMatchers;
import net.bytebuddy.pool.TypePool;

/**
 * Puts the trust advice into the JDK's X.509 trust manager's bytes: one advice per public
 * checkServerTrusted overload, matched by its exact parameters, so an overload a later JDK adds
 * (such as one for QUIC) is left alone. Runs in the agent's weaver class loader, with Byte Buddy,
 * which the program never sees (com.wirescry.agent.impl.Hooks).
 *
 * <p>Only method bodies change, with no fields or methods added (Implementation.Context is
 * disabled), so the same bytes work when the class is first loaded and when it's retransformed in
 * a program that's already running.
 *
 * <p>Each advice's code is copied into the JDK class, where only the JDK's own classes can be
 * named: it uses java.* types alone, and reaches the agent's com.wirescry.agent.impl.Trust through
 * the system class loader by name. Anything that goes wrong in it is suppressed, and the JDK's own
 * answer stands.
 */
public final class TrustWeaver implements BiFunction<String, byte[], byte[]> {
  @Override
  public byte[] apply(String internalName, byte[] bytes) {
    String name = internalName.replace('/', '.');
    ClassFileLocator target = ClassFileLocator.Simple.of(name, bytes);
    ClassFileLocator mine = ClassFileLocator.ForClassLoader.of(TrustWeaver.class.getClassLoader());
    ClassFileLocator all =
        new ClassFileLocator.Compound(target, mine, ClassFileLocator.ForClassLoader.ofBootLoader());
    TypePool pool = TypePool.Default.of(all);
    return new ByteBuddy()
        .with(Implementation.Context.Disabled.Factory.INSTANCE)
        .redefine(pool.describe(name).resolve(), target)
        .visit(advice(pool, mine, TrustPlainAdvice.class).on(overload()))
        .visit(advice(pool, mine, TrustSocketAdvice.class).on(overload(Socket.class)))
        .visit(advice(pool, mine, TrustEngineAdvice.class).on(overload(SSLEngine.class)))
        .make(pool)
        .getBytes();
  }

  private static Advice advice(TypePool pool, ClassFileLocator locator, Class<?> type) {
    return Advice.to(pool.describe(type.getName()).resolve(), locator);
  }

  /** Public checkServerTrusted(X509Certificate[], String[, third]). */
  private static ElementMatcher.Junction<MethodDescription> overload(Class<?>... third) {
    Class<?>[] parameters = new Class<?>[2 + third.length];
    parameters[0] = X509Certificate[].class;
    parameters[1] = String.class;
    System.arraycopy(third, 0, parameters, 2, third.length);
    return ElementMatchers.named("checkServerTrusted")
        .and(ElementMatchers.isPublic())
        .and(ElementMatchers.takesArguments(parameters));
  }
}
