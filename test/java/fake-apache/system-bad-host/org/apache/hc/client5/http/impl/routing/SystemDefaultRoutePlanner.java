/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package org.apache.hc.client5.http.impl.routing;

import org.apache.hc.core5.http.HttpHost;

/**
 * A stand-in with the name of Apache 5.x's SystemDefaultRoutePlanner whose determineProxy answers
 * a proxy at 127.0.0.1, at the port given in the host's name (`route("p8080")`), as an HttpHost
 * without getAddress: the hook reading it throws inside the program, and the answer must stand
 * (README.md).
 */
public class SystemDefaultRoutePlanner {
  protected HttpHost determineProxy(HttpHost target, Object context) {
    return new HttpHost("http", "127.0.0.1", Integer.parseInt(target.getHostName().substring(1)));
  }

  public String route(String port) {
    HttpHost proxy = determineProxy(new HttpHost("https", port, 443), null);
    return proxy == null ? "DIRECT" : "PROXY " + proxy.getHostName() + ":" + proxy.getPort();
  }
}
