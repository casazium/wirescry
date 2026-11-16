/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package org.eclipse.jetty.client;

import java.util.ArrayList;
import java.util.List;

/** A stand-in for Jetty's ProxyConfiguration (see ../README.md). */
public class ProxyConfiguration {
  private final List<Object> proxies = new ArrayList<Object>();

  public List<Object> getProxies() {
    return proxies;
  }

  // No match(Origin): the weave of this class fails.
}
