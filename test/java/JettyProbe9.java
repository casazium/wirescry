/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.util.concurrent.TimeUnit;
import org.eclipse.jetty.client.HttpClient;
import org.eclipse.jetty.client.HttpProxy;
import org.eclipse.jetty.client.api.Request;
import org.eclipse.jetty.util.ssl.SslContextFactory;

/**
 * A Jetty 9.4 probe for test/java-agent-jetty.test.ts, Java 8+ (built against 9.4.0). As
 * JettyProbe12, with the commands 9.4 has: one client, "default", on the HTTP/1.1 transport,
 * with an SslContextFactory (9.4 needs one for https); and "sub", a subclass of the probe's own.
 *
 * <pre>
 *   route default URL   the destination Jetty makes for URL: "PROXY host:port", "DIRECT", or
 *                       "DIRECT tagged"
 *   get default URL     GET
 *   tag default URL     GET with a tag of the program's own on the request
 *   own PORT URL        GET with a new client whose own proxy is 127.0.0.1:PORT
 *   ownskip PORT URL    the same, the proxy excluding URL's host
 *   fresh URL           GET with a new client
 *   set NAME VALUE      sets a system property
 *   bench N URL         resolves URL's destination N times: nanoseconds per call
 * </pre>
 */
public class JettyProbe9 {
  static HttpClient DEFAULT;
  static HttpClient SUB;

  public static void main(String[] args) throws Exception {
    DEFAULT = started(newClient());
    // A subclass of the probe's own, not public, overriding a getter the hook reads.
    SUB =
        started(
            new HttpClient(newTls()) {
              @Override
              public org.eclipse.jetty.client.HttpClientTransport getTransport() {
                return super.getTransport();
              }
            });
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
        Throwable cause = t;
        while (cause.getCause() != null
            && (cause instanceof java.util.concurrent.ExecutionException || cause instanceof java.lang.reflect.InvocationTargetException)) {
          cause = cause.getCause();
        }
        out = "FAIL " + cause.getClass().getName() + ": " + cause.getMessage();
      }
      System.out.println(out.replace('\n', ' ').replace('\r', ' '));
      System.out.flush();
    }
  }

  static HttpClient newClient() {
    return new HttpClient(newTls());
  }

  @SuppressWarnings("deprecation")
  static SslContextFactory newTls() {
    return new SslContextFactory();
  }

  static HttpClient started(HttpClient client) throws Exception {
    client.start();
    return client;
  }

  static HttpClient client(String name) {
    if ("sub".equals(name)) return SUB;
    if (!"default".equals(name)) throw new IllegalArgumentException("no client " + name);
    return DEFAULT;
  }

  static String run(String[] p) throws Exception {
    switch (p[0]) {
      case "route":
        {
          // As Jetty does for a request it sends: the request's own host (9.4 strips an IPv6
          // address's brackets there) and port.
          Request request = client(p[1]).newRequest(p[2]);
          return route(client(p[1]).getDestination(request.getScheme(), request.getHost(), request.getPort()));
        }
      case "get":
        return get(client(p[1]).newRequest(p[2]));
      case "tag":
        {
          Request r = client(p[1]).newRequest(p[2]);
          r.getClass().getMethod("tag", Object.class).invoke(r, "mine");
          return get(r);
        }
      case "own":
      case "ownskip":
        {
          HttpClient c = newClient();
          HttpProxy proxy = new HttpProxy("127.0.0.1", Integer.parseInt(p[1]));
          if (p[0].equals("ownskip")) {
            URI uri = URI.create(p[2]);
            proxy.getExcludedAddresses().add(uri.getHost() + ":" + (uri.getPort() < 0 ? 80 : uri.getPort()));
          }
          c.getProxyConfiguration().getProxies().add(proxy);
          c.start();
          try {
            return get(c.newRequest(p[2]));
          } finally {
            c.stop();
          }
        }
      case "fresh":
        {
          HttpClient c = started(newClient());
          try {
            return get(c.newRequest(p[1]));
          } finally {
            c.stop();
          }
        }
      case "set":
        System.setProperty(p[1], p.length > 2 ? p[2] : "");
        return "set";
      case "bench":
        {
          int n = Integer.parseInt(p[1]);
          URI uri = URI.create(p[2]);
          long start = System.nanoTime();
          for (int i = 0; i < n; i++) DEFAULT.getDestination(uri.getScheme(), uri.getHost(), 80);
          return "NS " + (System.nanoTime() - start) / n;
        }
      default:
        return "FAIL unknown command";
    }
  }

  static String route(Object destination) throws Exception {
    Object proxy = destination.getClass().getMethod("getProxy").invoke(destination);
    Object origin = destination.getClass().getMethod("getOrigin").invoke(destination);
    // 9.4's first releases have no tags.
    Object tag = null;
    try {
      tag = origin.getClass().getMethod("getTag").invoke(origin);
    } catch (NoSuchMethodException e) {
      // None.
    }
    if (proxy == null) return tag == null ? "DIRECT" : "DIRECT tagged";
    Object address = proxy.getClass().getMethod("getAddress").invoke(proxy);
    return "PROXY "
        + address.getClass().getMethod("getHost").invoke(address)
        + ":"
        + address.getClass().getMethod("getPort").invoke(address);
  }

  static String get(Request request) throws Exception {
    return "OK " + request.timeout(15, TimeUnit.SECONDS).send().getContentAsString();
  }
}
