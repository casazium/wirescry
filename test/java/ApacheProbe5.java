/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.util.concurrent.TimeUnit;
import org.apache.hc.client5.http.async.methods.SimpleHttpRequest;
import org.apache.hc.client5.http.async.methods.SimpleHttpResponse;
import org.apache.hc.client5.http.async.methods.SimpleRequestBuilder;
import org.apache.hc.client5.http.classic.methods.HttpGet;
import org.apache.hc.client5.http.config.RequestConfig;
import org.apache.hc.client5.http.impl.DefaultSchemePortResolver;
import org.apache.hc.client5.http.impl.async.CloseableHttpAsyncClient;
import org.apache.hc.client5.http.impl.async.H2AsyncClientBuilder;
import org.apache.hc.client5.http.impl.async.HttpAsyncClients;
import org.apache.hc.client5.http.impl.classic.CloseableHttpClient;
import org.apache.hc.client5.http.impl.classic.HttpClientBuilder;
import org.apache.hc.client5.http.impl.classic.HttpClients;
import org.apache.hc.client5.http.impl.routing.DefaultRoutePlanner;
import org.apache.hc.client5.http.protocol.HttpClientContext;
import org.apache.hc.client5.http.HttpRoute;
import org.apache.hc.core5.http.HttpHost;
import org.apache.hc.core5.http.io.entity.EntityUtils;

/**
 * An Apache HttpClient 5.x probe for test/java-agent-apache.test.ts, Java 8+. Builds a default
 * client at start (before any attach), prints "ready", then runs one command per line on stdin
 * and prints one line for it: "OK <body>", "FAIL <exception>", or a route.
 *
 * <pre>
 *   route URL           what a plain DefaultRoutePlanner chooses: "DIRECT" or "PROXY host:port"
 *   early URL           GET with the client built at start
 *   get URL             GET with HttpClients.createDefault() (DefaultRoutePlanner)
 *   system URL          GET with useSystemProperties() (the JDK's proxy selector)
 *   own PORT URL        GET with the request's own proxy, 127.0.0.1:PORT
 *   fixed PORT URL      GET with the builder's proxy, 127.0.0.1:PORT (DefaultProxyRoutePlanner)
 *   subclass URL        GET with a subclass of DefaultRoutePlanner that overrides nothing
 *   async URL           GET with HttpAsyncClients.createDefault()
 *   h2 URL              GET with the HTTP/2-only async client (H2AsyncClientBuilder)
 *   unix PATH URL       GET over the Unix domain socket at PATH (5.6+, on Java 16+)
 *   host SCHEME HOST PORT  what a plain DefaultRoutePlanner chooses for an HttpHost made by hand
 *   set NAME VALUE      sets a system property
 * </pre>
 */
public class ApacheProbe5 {
  static final CloseableHttpClient EARLY = HttpClients.createDefault();

  public static void main(String[] args) throws Exception {
    System.out.println("ready");
    System.out.flush();
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
    String line;
    while ((line = in.readLine()) != null) {
      String[] p = line.trim().split(" ");
      String out;
      try {
        out = run(p);
      } catch (Throwable t) {
        Throwable cause = t.getCause() != null && t instanceof java.util.concurrent.ExecutionException ? t.getCause() : t;
        out = "FAIL " + cause.getClass().getName() + ": " + cause.getMessage();
      }
      System.out.println(out.replace('\n', ' ').replace('\r', ' '));
      System.out.flush();
    }
  }

  static String run(String[] p) throws Exception {
    switch (p[0]) {
      case "route":
        {
          HttpRoute route =
              new DefaultRoutePlanner(DefaultSchemePortResolver.INSTANCE)
                  .determineRoute(HttpHost.create(URI.create(p[1])), HttpClientContext.create());
          HttpHost proxy = route.getProxyHost();
          return proxy == null ? "DIRECT" : "PROXY " + proxy.getHostName() + ":" + proxy.getPort();
        }
      case "early":
        return get(EARLY, new HttpGet(p[1]));
      case "get":
        try (CloseableHttpClient c = HttpClients.createDefault()) {
          return get(c, new HttpGet(p[1]));
        }
      case "system":
        try (CloseableHttpClient c = HttpClientBuilder.create().useSystemProperties().build()) {
          return get(c, new HttpGet(p[1]));
        }
      case "own":
        try (CloseableHttpClient c = HttpClients.createDefault()) {
          HttpGet get = new HttpGet(p[2]);
          get.setConfig(RequestConfig.custom().setProxy(new HttpHost("127.0.0.1", Integer.parseInt(p[1]))).build());
          return get(c, get);
        }
      case "fixed":
        try (CloseableHttpClient c =
            HttpClientBuilder.create().setProxy(new HttpHost("127.0.0.1", Integer.parseInt(p[1]))).build()) {
          return get(c, new HttpGet(p[2]));
        }
      case "subclass":
        try (CloseableHttpClient c =
            HttpClientBuilder.create()
                .setRoutePlanner(
                    // Overrides nothing: DefaultRoutePlanner's own determineProxy runs, for a subclass.
                    new DefaultRoutePlanner(DefaultSchemePortResolver.INSTANCE) {})
                .build()) {
          return get(c, new HttpGet(p[1]));
        }
      case "async":
        try (CloseableHttpAsyncClient c = HttpAsyncClients.createDefault()) {
          c.start();
          return async(c, p[1]);
        }
      case "h2":
        try (CloseableHttpAsyncClient c = H2AsyncClientBuilder.create().build()) {
          c.start();
          return async(c, p[1]);
        }
      case "host":
        {
          HttpRoute route =
              new DefaultRoutePlanner(DefaultSchemePortResolver.INSTANCE)
                  .determineRoute(new HttpHost(p[1], p[2], Integer.parseInt(p[3])), HttpClientContext.create());
          HttpHost proxy = route.getProxyHost();
          return proxy == null ? "DIRECT" : "PROXY " + proxy.getHostName() + ":" + proxy.getPort();
        }
      case "unix":
        try (CloseableHttpClient c = HttpClients.createDefault()) {
          HttpGet get = new HttpGet(p[2]);
          get.setConfig(RequestConfig.custom().setUnixDomainSocket(java.nio.file.Paths.get(p[1])).build());
          return get(c, get);
        }
      case "set":
        System.setProperty(p[1], p.length > 2 ? p[2] : "");
        return "set";
      default:
        return "FAIL unknown command";
    }
  }

  static String get(CloseableHttpClient client, HttpGet get) throws Exception {
    return client.execute(get, response -> "OK " + EntityUtils.toString(response.getEntity()));
  }

  static String async(CloseableHttpAsyncClient client, String url) throws Exception {
    SimpleHttpRequest request = SimpleRequestBuilder.get(url).build();
    SimpleHttpResponse response = client.execute(request, null).get(15, TimeUnit.SECONDS);
    return "OK " + response.getBodyText();
  }
}
