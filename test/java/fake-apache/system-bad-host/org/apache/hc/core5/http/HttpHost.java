/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package org.apache.hc.core5.http;

/** The system-bad-host stand-in's HttpHost: no getAddress (see its SystemDefaultRoutePlanner). */
public class HttpHost {
  private final String scheme;
  private final String hostname;
  private final int port;

  public HttpHost(String scheme, String hostname, int port) {
    this.scheme = scheme;
    this.hostname = hostname;
    this.port = port;
  }

  public String getSchemeName() {
    return scheme;
  }

  public String getHostName() {
    return hostname;
  }

  public int getPort() {
    return port;
  }
}
