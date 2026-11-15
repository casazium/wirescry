/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import org.apache.http.HttpHost;
import org.apache.http.client.config.RequestConfig;
import org.apache.http.client.methods.CloseableHttpResponse;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.client.protocol.HttpClientContext;
import org.apache.http.conn.routing.HttpRoute;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClients;
import org.apache.http.impl.conn.DefaultRoutePlanner;
import org.apache.http.impl.conn.DefaultSchemePortResolver;
import org.apache.http.message.BasicHttpRequest;
import org.apache.http.util.EntityUtils;

/**
 * An Apache HttpClient 4.x probe for the version matrix in test/java-agent-apache.test.ts, using
 * only what 4.3 has, so one build runs against every 4.x release from 4.3. Java 8+. Prints
 * "ready", then one line per command on stdin: "OK <body>", "FAIL <exception>", or a route.
 *
 * <pre>
 *   route URL    what a plain DefaultRoutePlanner chooses: "DIRECT" or "PROXY host:port"
 *   get URL      GET with HttpClients.createDefault()
 *   system URL   GET with HttpClients.createSystem() (the JDK's proxy selector)
 *   own PORT URL GET with the request's own proxy, 127.0.0.1:PORT
 *   set NAME [VALUE]  sets a system property
 * </pre>
 */
public class ApacheBasic4 {
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
          URI uri = URI.create(p[1]);
          HttpRoute route =
              new DefaultRoutePlanner(DefaultSchemePortResolver.INSTANCE)
                  .determineRoute(
                      new HttpHost(uri.getHost(), uri.getPort(), uri.getScheme()),
                      new BasicHttpRequest("GET", p[1]),
                      HttpClientContext.create());
          HttpHost proxy = route.getProxyHost();
          return proxy == null ? "DIRECT" : "PROXY " + proxy.getHostName() + ":" + proxy.getPort();
        }
      case "get":
        return get(HttpClients.createDefault(), new HttpGet(p[1]));
      case "own":
        {
          HttpGet get = new HttpGet(p[2]);
          get.setConfig(RequestConfig.custom().setProxy(new HttpHost("127.0.0.1", Integer.parseInt(p[1]))).build());
          return get(HttpClients.createDefault(), get);
        }
      case "system":
        return get(HttpClients.createSystem(), new HttpGet(p[1]));
      case "set":
        System.setProperty(p[1], p.length > 2 ? p[2] : "");
        return "set";
      default:
        return "FAIL unknown command";
    }
  }

  static String get(CloseableHttpClient client, HttpGet get) throws Exception {
    try {
      CloseableHttpResponse response = client.execute(get);
      try {
        return "OK " + EntityUtils.toString(response.getEntity());
      } finally {
        response.close();
      }
    } finally {
      client.close();
    }
  }
}
