/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
import java.io.BufferedReader;
import java.io.InputStreamReader;
import org.apache.http.HttpHost;
import org.apache.http.client.config.RequestConfig;
import org.apache.http.client.methods.CloseableHttpResponse;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.client.protocol.HttpClientContext;
import org.apache.http.conn.routing.HttpRoute;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClientBuilder;
import org.apache.http.impl.client.HttpClients;
import org.apache.http.impl.conn.DefaultRoutePlanner;
import org.apache.http.impl.conn.DefaultSchemePortResolver;
import org.apache.http.util.EntityUtils;

/**
 * An Apache HttpClient 4.x probe for test/java-agent-apache.test.ts, Java 8+. Builds a default
 * client at start (before any attach), prints "ready", then runs one command per line on stdin
 * and prints one line for it: "OK <body>", "FAIL <exception>", or a route.
 *
 * <pre>
 *   route URL           what a plain DefaultRoutePlanner chooses: "DIRECT" or "PROXY host:port"
 *   early URL           GET with the client built at start
 *   get URL             GET with HttpClients.createDefault() (DefaultRoutePlanner)
 *   system URL          GET with HttpClients.createSystem() (the JDK's proxy selector)
 *   own PORT URL        GET with the request's own proxy, 127.0.0.1:PORT
 *   fixed PORT URL      GET with the builder's proxy, 127.0.0.1:PORT (DefaultProxyRoutePlanner)
 *   subclass URL        GET with a subclass of DefaultRoutePlanner that overrides nothing
 *   set NAME VALUE      sets a system property
 * </pre>
 */
public class ApacheProbe4 {
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
        out = "FAIL " + t.getClass().getName() + ": " + t.getMessage();
      }
      System.out.println(out.replace('\n', ' ').replace('\r', ' '));
      System.out.flush();
    }
  }

  static String run(String[] p) throws Exception {
    switch (p[0]) {
      case "route":
        {
          HttpGet get = new HttpGet(p[1]);
          HttpHost target = HttpHost.create(get.getURI().getScheme() + "://" + get.getURI().getRawAuthority());
          HttpRoute route =
              new DefaultRoutePlanner(DefaultSchemePortResolver.INSTANCE)
                  .determineRoute(target, get, HttpClientContext.create());
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
        try (CloseableHttpClient c = HttpClients.createSystem()) {
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
      case "set":
        System.setProperty(p[1], p.length > 2 ? p[2] : "");
        return "set";
      default:
        return "FAIL unknown command";
    }
  }

  static String get(CloseableHttpClient client, HttpGet get) throws Exception {
    try (CloseableHttpResponse response = client.execute(get)) {
      return "OK " + EntityUtils.toString(response.getEntity());
    }
  }
}
