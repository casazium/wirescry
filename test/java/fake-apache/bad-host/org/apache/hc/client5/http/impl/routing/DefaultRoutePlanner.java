/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package org.apache.hc.client5.http.impl.routing;

import org.apache.hc.core5.http.HttpHost;

/**
 * A stand-in with Apache's name and determineProxy, whose HttpHost the hook can't build its proxy
 * with: the hook throws inside it (README.md).
 */
public class DefaultRoutePlanner {
  protected HttpHost determineProxy(HttpHost target, Object context) {
    return null;
  }

  public String route(String host) {
    HttpHost proxy = determineProxy(new HttpHost("http", host), null);
    return proxy == null ? "DIRECT" : "PROXY " + proxy.getHostName();
  }
}
