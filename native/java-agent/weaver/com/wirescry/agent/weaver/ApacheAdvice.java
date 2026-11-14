/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.weaver;

import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/**
 * Code put at the end of Apache HttpClient's DefaultRoutePlanner.determineProxy, 4.x
 * (org.apache.http.impl.conn) and 5.x (org.apache.hc.client5.http.impl.routing). HttpClient asks
 * it for a proxy only when the request's own RequestConfig names none, and the base class answers
 * null: connect directly. Its subclasses for a fixed proxy and for the system's proxy selector
 * override it, and are left alone (com.wirescry.agent.impl.Proxies.apache checks the class).
 *
 * <p>Copied into a class of the program's, where Apache's classes are named, so it names only
 * java.* types: the planner and the target as Object, the answer typed dynamically. The agent's
 * Proxies is reached through the system class loader by name, as from the JDK's classes. See
 * Weaver.
 */
public final class ApacheAdvice {
  private ApacheAdvice() {}

  @Advice.OnMethodExit(suppress = Throwable.class)
  static void exit(
      @Advice.This Object planner,
      @Advice.Argument(0) Object target,
      @Advice.Return(readOnly = false, typing = Assigner.Typing.DYNAMIC) Object proxy)
      throws Exception {
    if (proxy != null || target == null) return;
    Object mine =
        Class.forName("com.wirescry.agent.impl.Proxies", false, ClassLoader.getSystemClassLoader())
            .getMethod("apache", Object.class, Object.class)
            .invoke(null, planner, target);
    // Last: if anything above throws, the suppression keeps HttpClient's own answer.
    if (mine != null) proxy = mine;
  }
}
