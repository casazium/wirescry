/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package org.apache.hc.core5.http;

/** A stand-in HttpHost without the (String, InetAddress, String, int) constructor (README.md). */
public final class HttpHost {
  private final String scheme;
  private final String host;

  public HttpHost(String scheme, String host) {
    this.scheme = scheme;
    this.host = host;
  }

  public String getSchemeName() {
    return scheme;
  }

  public String getHostName() {
    return host;
  }
}
