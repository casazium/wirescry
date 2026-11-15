/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.weaver;

import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/**
 * Code put at the end of Apache HttpClient 5.x's SystemDefaultRoutePlanner.determineProxy
 * (org.apache.hc.client5.http.impl.routing), which asks the JDK's proxy selector, and so gets
 * Wirescry's proxy from the agent's JDK hook. Where a request can't go through a proxy at all (a
 * Unix domain socket, 5.x's HTTP/2-only client), it takes Wirescry's proxy back out, so the request
 * goes direct as it would without the agent (com.wirescry.agent.impl.Proxies.apacheSystem). Any
 * other answer stands.
 *
 * <p>Copied into a class of the program's, like ApacheAdvice, so it names only java.* types.
 */
public final class ApacheSystemAdvice {
  private ApacheSystemAdvice() {}

  @Advice.OnMethodExit(suppress = Throwable.class)
  static void exit(
      @Advice.This Object planner,
      @Advice.AllArguments Object[] arguments,
      @Advice.Return(readOnly = false, typing = Assigner.Typing.DYNAMIC) Object proxy)
      throws Exception {
    if (proxy == null || arguments.length == 0) return;
    Object direct =
        Class.forName("com.wirescry.agent.impl.Proxies", false, ClassLoader.getSystemClassLoader())
            .getMethod("apacheSystem", Object.class, Object.class, Object.class, Object.class)
            .invoke(null, planner, arguments[0], proxy, arguments[arguments.length - 1]);
    // Last: if anything above throws, the suppression keeps HttpClient's own answer.
    if (Boolean.TRUE.equals(direct)) proxy = null;
  }
}
