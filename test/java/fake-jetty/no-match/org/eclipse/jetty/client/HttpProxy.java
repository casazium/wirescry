/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package org.eclipse.jetty.client;

/** A stand-in for Jetty's HttpProxy (see ../README.md). */
public class HttpProxy {
  private final String host;
  private final int port;

  public HttpProxy(String host, int port) {
    this.host = host;
    this.port = port;
  }

  @Override
  public String toString() {
    return "HttpProxy " + host + ":" + port;
  }
}
