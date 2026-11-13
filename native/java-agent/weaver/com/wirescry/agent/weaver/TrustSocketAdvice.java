/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.weaver;

import net.bytebuddy.asm.Advice;

/**
 * Code put at the end of the JDK's default X.509 trust manager's
 * checkServerTrusted(chain, authType, Socket): HttpsURLConnection and SSLSocket. See TrustWeaver.
 */
public final class TrustSocketAdvice {
  private TrustSocketAdvice() {}

  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(
      @Advice.This Object self,
      @Advice.Argument(0) java.security.cert.X509Certificate[] chain,
      @Advice.Argument(1) String authType,
      @Advice.Argument(2) java.net.Socket socket,
      @Advice.Thrown(readOnly = false) Throwable thrown)
      throws Exception {
    if (thrown instanceof java.security.cert.CertificateException) {
      Object accepted =
          Class.forName("com.wirescry.agent.impl.Trust", false, ClassLoader.getSystemClassLoader())
              .getMethod(
                  "acceptsSocket", Object.class, java.security.cert.X509Certificate[].class, String.class, java.net.Socket.class)
              .invoke(null, self, chain, authType, socket);
      // Last: if anything above throws, the suppression keeps the JDK's own exception.
      if (Boolean.TRUE.equals(accepted)) thrown = null;
    }
  }
}
