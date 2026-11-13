/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.weaver;

import java.util.function.BiFunction;
import net.bytebuddy.ByteBuddy;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.dynamic.ClassFileLocator;
import net.bytebuddy.implementation.Implementation;
import net.bytebuddy.matcher.ElementMatchers;
import net.bytebuddy.pool.TypePool;

/**
 * Puts TrustAdvice into the JDK's X.509 trust manager's bytes. Runs in the agent's own class
 * loader, with Byte Buddy, which the program never sees (com.wirescry.agent.impl.WeaverLoader).
 *
 * <p>Only method bodies change, with no fields or methods added (Implementation.Context is
 * disabled), so the same bytes work when the class is first loaded and when it's retransformed in
 * a program that's already running.
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
        .visit(
            Advice.to(pool.describe(TrustAdvice.class.getName()).resolve(), mine)
                .on(ElementMatchers.named("checkServerTrusted").and(ElementMatchers.isPublic())))
        .make(pool)
        .getBytes();
  }
}
