/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package org.eclipse.jetty.client;

/** A stand-in for Jetty's HttpProxy (see ../README.md). */
public class HttpProxy {
  private final String host;
  private final int port;

  // Not (String, int): the hook can't make Wirescry's proxy, so it must tag nothing.
  public HttpProxy(String hostAndPort) {
    this.host = hostAndPort.substring(0, hostAndPort.lastIndexOf(':'));
    this.port = Integer.parseInt(hostAndPort.substring(hostAndPort.lastIndexOf(':') + 1));
  }

  @Override
  public String toString() {
    return "HttpProxy " + host + ":" + port;
  }
}
