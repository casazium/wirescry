/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package org.apache.hc.client5.http.impl.routing;

/**
 * A stand-in with the name of Apache 5.x's SystemDefaultRoutePlanner but no determineProxy, as a
 * future release might be: nothing to hook, and nothing to report (README.md).
 */
public class SystemDefaultRoutePlanner {
  public String route(String host) {
    return "DIRECT";
  }
}
