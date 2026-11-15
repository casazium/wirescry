/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.example.shaded.org.apache.hc.client5.http.impl.routing;

import com.example.shaded.org.apache.hc.core5.http.HttpHost;

/**
 * A stand-in for a renamed ("shaded") copy of Apache's planner, as some libraries bundle: Apache's
 * class and method names under another package. The hook doesn't know this name, so it must leave
 * it alone, and say nothing of it in the status file (README.md).
 */
public class DefaultRoutePlanner {
  protected HttpHost determineProxy(HttpHost target, Object context) {
    return null;
  }

  public String route(String host) {
    HttpHost proxy = determineProxy(new HttpHost("http", null, host, 80), null);
    return proxy == null ? "DIRECT" : "PROXY " + proxy.getHostName() + ":" + proxy.getPort();
  }
}
