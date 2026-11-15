/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.example.shaded.org.apache.hc.core5.http;

import java.net.InetAddress;

/** The shaded stand-in's HttpHost (see its DefaultRoutePlanner). */
public class HttpHost {
  private final String hostname;
  private final int port;

  public HttpHost(String scheme, InetAddress address, String hostname, int port) {
    this.hostname = hostname;
    this.port = port;
  }

  public String getHostName() {
    return hostname;
  }

  public int getPort() {
    return port;
  }
}
