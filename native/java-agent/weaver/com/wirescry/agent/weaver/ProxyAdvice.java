/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.weaver;

import net.bytebuddy.asm.Advice;

/**
 * Code put at the end of the JDK's default proxy selector's select(URI), which
 * HttpURLConnection, Java's HttpClient and OkHttp ask unless a program set its own proxy or
 * selector. The agent's com.wirescry.agent.impl.Proxies decides whether Wirescry's proxy replaces
 * the JDK's answer. Not run when select throws. See Weaver.
 *
 * <p>It first skips, without reflection, what Proxies would leave alone anyway: schemes other
 * than http and https, and answers that aren't DIRECT. It then reads `http.nonProxyHosts` with
 * the JDK's own sun.net.NetProperties, which this JDK class may call: the program's setting, else
 * the JDK's net.properties file, the same value the JDK's own exclusions use.
 */
public final class ProxyAdvice {
  private ProxyAdvice() {}

  @Advice.OnMethodExit(suppress = Throwable.class)
  @SuppressWarnings("unchecked")
  static void exit(
      @Advice.Argument(0) java.net.URI uri,
      @Advice.Return(readOnly = false) java.util.List<java.net.Proxy> proxies)
      throws Exception {
    String scheme = uri.getScheme();
    if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return;
    for (java.net.Proxy p : proxies) {
      if (p.type() != java.net.Proxy.Type.DIRECT) return;
    }
    Object excluded = Class.forName("sun.net.NetProperties").getMethod("get", String.class).invoke(null, "http.nonProxyHosts");
    Object mine =
        Class.forName("com.wirescry.agent.impl.Proxies", false, ClassLoader.getSystemClassLoader())
            .getMethod("select", java.net.URI.class, java.util.List.class, String.class)
            .invoke(null, uri, proxies, excluded);
    // Last: if anything above throws, the suppression keeps the JDK's own answer.
    if (mine != null) proxies = (java.util.List<java.net.Proxy>) mine;
  }
}
