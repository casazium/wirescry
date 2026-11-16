/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.example.shaded.org.eclipse.jetty.client;

import java.util.ArrayList;
import java.util.List;

/** A stand-in for Jetty's ProxyConfiguration (see ../README.md). */
public class ProxyConfiguration {
  private final List<Object> proxies = new ArrayList<Object>();

  public List<Object> getProxies() {
    return proxies;
  }

  /** No proxy of the program's: Jetty's answer for an Origin no proxy matches. */
  public Object match(Origin origin) {
    return null;
  }
}
