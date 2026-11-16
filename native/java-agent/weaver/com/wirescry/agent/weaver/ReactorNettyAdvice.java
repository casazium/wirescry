/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.weaver;

import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/**
 * Code put at the start of Reactor Netty's HttpConnectionProvider.acquire(config, observer, remote,
 * resolver) (1.0 to 1.3), which every HTTP connection attempt passes through. When
 * com.wirescry.agent.impl.ReactorNetty.acquire says so, the attempt goes on with another config (a
 * copy with Wirescry's proxy, or without Wirescry's once it's gone) and resolver.
 *
 * <p>Copied into Reactor Netty's class, so it names only java.* types, and reaches the agent's
 * ReactorNetty through the system class loader by name, as ApacheAdvice does. Anything that goes
 * wrong is suppressed, and the arguments stand.
 */
public final class ReactorNettyAdvice {
  private ReactorNettyAdvice() {}

  @Advice.OnMethodEnter(suppress = Throwable.class)
  static void enter(
      @Advice.Argument(value = 0, readOnly = false, typing = Assigner.Typing.DYNAMIC) Object config,
      @Advice.Argument(2) Object remote,
      @Advice.Argument(value = 3, readOnly = false, typing = Assigner.Typing.DYNAMIC) Object resolver)
      throws Exception {
    if (config == null) return;
    Object[] mine =
        (Object[])
            Class.forName("com.wirescry.agent.impl.ReactorNetty", false, ClassLoader.getSystemClassLoader())
                .getMethod("acquire", Object.class, Object.class, Object.class)
                .invoke(null, config, remote, resolver);
    // Last: if anything above throws, the suppression keeps the arguments as they were. The two
    // values are of the method's own types (ReactorNetty checks the resolver before answering), so
    // the second assignment can't fail after the first.
    if (mine != null) {
      config = mine[0];
      resolver = mine[1];
    }
  }
}
