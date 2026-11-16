/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.weaver;

import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/**
 * Code put at the end of Jetty's HttpClient.createOrigin (9.4 to 12.1). Jetty keeps one
 * destination per Origin, and picks its proxy once, when it makes the destination: so to send a
 * request through Wirescry, and back direct when Wirescry quits, the Origin itself has to differ.
 * When com.wirescry.agent.impl.Jetty.origin says so, this answers the same Origin with a tag naming
 * Wirescry's proxy, which JettyMatchAdvice then reads.
 *
 * <p>Copied into Jetty's class, so it names only java.* types, and reaches the agent's Jetty
 * through the system class loader by name, as ApacheAdvice does. Anything that goes wrong is
 * suppressed, and Jetty's own Origin stands.
 */
public final class JettyOriginAdvice {
  private JettyOriginAdvice() {}

  @Advice.OnMethodExit(suppress = Throwable.class)
  static void exit(
      @Advice.This Object client,
      @Advice.Return(readOnly = false, typing = Assigner.Typing.DYNAMIC) Object origin)
      throws Exception {
    if (origin == null) return;
    Object mine =
        Class.forName("com.wirescry.agent.impl.Jetty", false, ClassLoader.getSystemClassLoader())
            .getMethod("origin", Object.class, Object.class)
            .invoke(null, client, origin);
    // Last: if anything above throws, the suppression keeps Jetty's own Origin.
    if (mine != null) origin = mine;
  }
}
