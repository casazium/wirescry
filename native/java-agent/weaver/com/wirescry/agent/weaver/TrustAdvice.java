/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.weaver;

import net.bytebuddy.asm.Advice;

/**
 * Code put at the end of the JDK's default X.509 trust manager's checkServerTrusted (all three
 * public overloads). When the JDK's own check has rejected a chain, it asks the agent's
 * com.wirescry.agent.impl.Trust whether the same check, run against Wirescry's CA alone, accepts
 * it; if so, the rejection is cleared. The JDK's check always runs first and is never skipped.
 *
 * <p>Byte Buddy copies this method's body into the JDK class, where only the JDK's own classes
 * can be named: so it uses java.* types alone, and reaches the agent through the system class
 * loader by name. Anything that goes wrong in it is suppressed, and the JDK's answer stands.
 */
public final class TrustAdvice {
  private TrustAdvice() {}

  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(
      @Advice.This Object self,
      @Advice.AllArguments Object[] args,
      @Advice.Thrown(readOnly = false) Throwable thrown)
      throws Exception {
    if (thrown instanceof java.security.cert.CertificateException) {
      Object accepted =
          Class.forName("com.wirescry.agent.impl.Trust", false, ClassLoader.getSystemClassLoader())
              .getMethod("accepts", Object.class, Object[].class)
              .invoke(null, self, args);
      if (Boolean.TRUE.equals(accepted)) thrown = null;
    }
  }
}
