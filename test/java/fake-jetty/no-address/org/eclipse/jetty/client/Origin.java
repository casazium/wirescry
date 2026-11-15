/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package org.eclipse.jetty.client;

/** A stand-in for Jetty 9.4's Origin (see ../README.md). */
public class Origin {
  private final String scheme;
  private final Address address;
  private final Object tag;

  public Origin(String scheme, Address address, Object tag) {
    this.scheme = scheme;
    this.address = address;
    this.tag = tag;
  }

  public String getScheme() {
    return scheme;
  }

  // No getAddress(): the hook can't read the host, and fails as it runs.
  public Address address() {
    return address;
  }

  public Object getTag() {
    return tag;
  }

  public static class Address {
    private final String host;
    private final int port;

    public Address(String host, int port) {
      this.host = host;
      this.port = port;
    }

    public String getHost() {
      return host;
    }

    public int getPort() {
      return port;
    }
  }
}
