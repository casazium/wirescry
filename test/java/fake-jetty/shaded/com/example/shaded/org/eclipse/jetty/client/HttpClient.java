/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.example.shaded.org.eclipse.jetty.client;

import com.example.shaded.org.eclipse.jetty.client.http.HttpClientTransportOverHTTP;

/**
 * A stand-in for Jetty 9.4's HttpClient (see ../README.md): describe(host) makes an Origin as Jetty
 * does for a request, and asks the configuration for its proxy, as a destination would.
 */
public class HttpClient {
  private final ProxyConfiguration configuration = new ProxyConfiguration();
  private final HttpClientTransportOverHTTP transport = new HttpClientTransportOverHTTP();

  public ProxyConfiguration getProxyConfiguration() {
    return configuration;
  }

  public HttpClientTransportOverHTTP getTransport() {
    return transport;
  }

  protected Origin createOrigin(String scheme, String host, int port, Object tag) {
    return new Origin(scheme, new Origin.Address(host, port), tag);
  }

  public String describe(String host) {
    Origin origin = createOrigin("http", host, 80, null);
    Object proxy = configuration.match(origin);
    return "tag=" + origin.getTag() + " proxy=" + proxy;
  }
}
