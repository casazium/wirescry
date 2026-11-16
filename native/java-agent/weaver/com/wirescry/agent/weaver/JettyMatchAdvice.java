/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.weaver;

import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/**
 * Code put at the end of Jetty's ProxyConfiguration.match(Origin) (9.4 to 12.1), which Jetty asks
 * once per destination. When Jetty found no proxy of the program's, and the Origin carries the tag
 * JettyOriginAdvice gave it, this answers Wirescry's proxy at the port the tag names (see
 * com.wirescry.agent.impl.Jetty.proxy). It doesn't read the on/off switch: the tag already holds
 * that decision, made per request.
 *
 * <p>Names only java.* types, as JettyOriginAdvice. Anything that goes wrong is suppressed, and
 * Jetty's own answer stands.
 */
public final class JettyMatchAdvice {
  private JettyMatchAdvice() {}

  @Advice.OnMethodExit(suppress = Throwable.class)
  static void exit(
      @Advice.Argument(0) Object origin,
      @Advice.Return(readOnly = false, typing = Assigner.Typing.DYNAMIC) Object proxy)
      throws Exception {
    if (proxy != null || origin == null) return;
    Object mine =
        Class.forName("com.wirescry.agent.impl.Jetty", false, ClassLoader.getSystemClassLoader())
            .getMethod("proxy", Object.class)
            .invoke(null, origin);
    if (mine != null) proxy = mine;
  }
}
