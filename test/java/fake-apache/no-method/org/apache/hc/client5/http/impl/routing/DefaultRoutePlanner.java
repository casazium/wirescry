/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package org.apache.hc.client5.http.impl.routing;

/** A stand-in with Apache's name and no determineProxy: the hook can't be woven (README.md). */
public class DefaultRoutePlanner {
  public String route(String host) {
    return "DIRECT";
  }
}
