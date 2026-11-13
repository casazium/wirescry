/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.weaver;

import net.bytebuddy.asm.Advice;

/**
 * Code put at the end of the JDK's default X.509 trust manager's
 * checkServerTrusted(chain, authType, SSLEngine): Java's HttpClient and other SSLEngine users. See Weaver.
 */
public final class TrustEngineAdvice {
  private TrustEngineAdvice() {}

  @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
  static void exit(
      @Advice.This Object self,
      @Advice.Argument(0) java.security.cert.X509Certificate[] chain,
      @Advice.Argument(1) String authType,
      @Advice.Argument(2) javax.net.ssl.SSLEngine engine,
      @Advice.Thrown(readOnly = false) Throwable thrown)
      throws Exception {
    if (thrown instanceof java.security.cert.CertificateException) {
      Object accepted =
          Class.forName("com.wirescry.agent.impl.Trust", false, ClassLoader.getSystemClassLoader())
              .getMethod(
                  "acceptsEngine", Object.class, java.security.cert.X509Certificate[].class, String.class, javax.net.ssl.SSLEngine.class)
              .invoke(null, self, chain, authType, engine);
      // Last: if anything above throws, the suppression keeps the JDK's own exception.
      if (Boolean.TRUE.equals(accepted)) thrown = null;
    }
  }
}
