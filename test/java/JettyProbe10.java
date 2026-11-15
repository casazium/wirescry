/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.eclipse.jetty.client.HttpClient;
import org.eclipse.jetty.client.HttpProxy;
import org.eclipse.jetty.client.ProxyProtocolClientConnectionFactory;
import org.eclipse.jetty.client.api.Request;
import org.eclipse.jetty.client.dynamic.HttpClientTransportDynamic;
import org.eclipse.jetty.client.http.HttpClientConnectionFactory;
import org.eclipse.jetty.io.ClientConnectionFactory;
import org.eclipse.jetty.io.ClientConnector;
import org.eclipse.jetty.util.ssl.SslContextFactory;

/**
 * A Jetty 10 and 11 probe for test/java-agent-jetty.test.ts, Java 11+ (built against 10.0.0). Builds its
 * clients at start (before any attach), prints "ready", then runs one command per line on stdin
 * and prints one line for it: "OK <body>", "FAIL <exception>", or a route. The HTTP/2 clients
 * exist only when Jetty's HTTP/2 jars are on the class path; they're made by name, so the probe
 * runs without them.
 *
 * <pre>
 *   route CLIENT URL    the destination Jetty makes for URL: "PROXY host:port", "DIRECT", or
 *                       "DIRECT tagged" (a tag, but no proxy)
 *   get CLIENT URL      GET with that client
 *   tag CLIENT URL      GET with a tag of the program's own on the request
 *   own PORT URL        GET with a new client whose own proxy is 127.0.0.1:PORT
 *   ownskip PORT URL    the same, the proxy excluding URL's host
 *   fresh URL           GET with a new default client
 *   unix PATH URL       GET over the Unix domain socket at PATH
 *   set NAME VALUE      sets a system property
 *   bench N URL         resolves URL's destination N times on "default": nanoseconds per call
 *   storm THREADS MILLIS URL  THREADS threads resolve URL's destination on "default" again and
 *                       again for MILLIS: "ANSWERS <each distinct route, sorted, |-separated>
 *                       ERRORS <how many threw>"
 *   owntrust FILE PASS URL  GET with a new client whose trust store is the PKCS12 FILE alone
 *   validate FILE PASS URL  the same, the client also checking the chain itself (validatePeerCerts,
 *                       which Jetty reads only with a trust store)
 * </pre>
 *
 * Clients: default (HTTP/1.1 transport), dynamic (the dynamic transport, HTTP/1.1), pp (dynamic,
 * with PROXY protocol), h2first (dynamic, HTTP/2 then HTTP/1.1), h2only (dynamic, HTTP/2 only),
 * h2 (the HTTP/2 transport).
 */
public class JettyProbe10 {
  static final Map<String, HttpClient> CLIENTS = new HashMap<>();

  public static void main(String[] args) throws Exception {
    CLIENTS.put("default", started(new HttpClient()));
    CLIENTS.put("dynamic", started(new HttpClient(new HttpClientTransportDynamic())));
    // A subclass of the probe's own, not public, overriding a getter the hook reads.
    CLIENTS.put(
        "sub",
        started(
            new HttpClient() {
              @Override
              public org.eclipse.jetty.client.HttpClientTransport getTransport() {
                return super.getTransport();
              }
            }));
    CLIENTS.put(
        "pp",
        started(
            new HttpClient(
                new HttpClientTransportDynamic(
                    new ClientConnector(),
                    // HTTP/1.1 behind PROXY protocol. Its own Info: 10's HTTP11 class is private.
                    new ClientConnectionFactory.Info(
                        new ProxyProtocolClientConnectionFactory.V1(new HttpClientConnectionFactory())) {
                      @Override
                      public java.util.List<String> getProtocols(boolean secure) {
                        return java.util.Collections.singletonList("http/1.1");
                      }
                    }))));
    try {
      Class.forName("org.eclipse.jetty.http2.client.HTTP2Client");
      CLIENTS.put("h2first", started(new HttpClient(dynamic(true, true))));
      CLIENTS.put("h2only", started(new HttpClient(dynamic(true, false))));
      Object h2client = Class.forName("org.eclipse.jetty.http2.client.HTTP2Client").getConstructor().newInstance();
      CLIENTS.put(
          "h2",
          started(
              new HttpClient(
                  (org.eclipse.jetty.client.HttpClientTransport)
                      Class.forName("org.eclipse.jetty.http2.client.http.HttpClientTransportOverHTTP2")
                          .getConstructor(h2client.getClass())
                          .newInstance(h2client))));
    } catch (ClassNotFoundException e) {
      // No HTTP/2 jars: those clients aren't made.
    }
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

  static HttpClient started(HttpClient client) throws Exception {
    client.start();
    return client;
  }

  /** The dynamic transport with HTTP/2 (first) and HTTP/1.1 if `h1`. */
  static HttpClientTransportDynamic dynamic(boolean h2, boolean h1) throws Exception {
    Object h2client = Class.forName("org.eclipse.jetty.http2.client.HTTP2Client").getConstructor().newInstance();
    ClientConnectionFactory.Info http2 =
        (ClientConnectionFactory.Info)
            Class.forName("org.eclipse.jetty.http2.client.http.ClientConnectionFactoryOverHTTP2$HTTP2")
                .getConstructor(h2client.getClass())
                .newInstance(h2client);
    return h1
        ? new HttpClientTransportDynamic(new ClientConnector(), http2, HttpClientConnectionFactory.HTTP11)
        : new HttpClientTransportDynamic(new ClientConnector(), http2);
  }

  static HttpClient client(String name) {
    HttpClient c = CLIENTS.get(name);
    if (c == null) throw new IllegalArgumentException("no client " + name);
    return c;
  }

  static String run(String[] p) throws Exception {
    switch (p[0]) {
      case "route":
        return route(client(p[1]).resolveDestination(client(p[1]).newRequest(p[2])));
      case "get":
        return get(client(p[1]).newRequest(p[2]));
      case "tag":
        return get(client(p[1]).newRequest(p[2]).tag("mine"));
      case "own":
      case "ownskip":
        {
          HttpClient c = new HttpClient();
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
          HttpClient c = started(new HttpClient());
          try {
            return get(c.newRequest(p[1]));
          } finally {
            c.stop();
          }
        }
      case "unix":
        return unix(p[1], p[2]);
      case "set":
        System.setProperty(p[1], p.length > 2 ? p[2] : "");
        return "set";
      case "storm":
        {
          final int threads = Integer.parseInt(p[1]);
          final long until = System.currentTimeMillis() + Long.parseLong(p[2]);
          final String url = p[3];
          final java.util.Set<String> answers = java.util.Collections.synchronizedSet(new java.util.TreeSet<String>());
          final java.util.concurrent.atomic.AtomicInteger errors = new java.util.concurrent.atomic.AtomicInteger();
          Thread[] all = new Thread[threads];
          for (int i = 0; i < threads; i++) {
            all[i] =
                new Thread(
                    () -> {
                      while (System.currentTimeMillis() < until) {
                        try {
                          answers.add(ROUTE.apply(url));
                        } catch (Throwable t) {
                          errors.incrementAndGet();
                        }
                      }
                    });
            all[i].start();
          }
          for (Thread t : all) t.join();
          return "ANSWERS " + String.join("|", answers) + " ERRORS " + errors.get();
        }
      case "validate":
      case "owntrust":
        {
          SslContextFactory.Client tls = new SslContextFactory.Client();
          tls.setValidatePeerCerts(p[0].equals("validate"));
          tls.setTrustStorePath(p[1]);
          tls.setTrustStorePassword(p[2]);
          tls.setTrustStoreType("PKCS12");
          HttpClient c = newTlsClient(tls);
          c.start();
          try {
            return get(c.newRequest(p[p.length - 1]));
          } finally {
            c.stop();
          }
        }
      case "bench":
        {
          int n = Integer.parseInt(p[1]);
          HttpClient c = client("default");
          long start = System.nanoTime();
          for (int i = 0; i < n; i++) c.resolveDestination(c.newRequest(p[2]));
          return "NS " + (System.nanoTime() - start) / n;
        }
      default:
        return "FAIL unknown command";
    }
  }

  /** Over a Unix socket: a connector for it (10.0.x later releases on). */
  static String unix(String path, String url) throws Exception {
    ClientConnector connector =
        (ClientConnector)
            ClientConnector.class.getMethod("forUnixDomain", java.nio.file.Path.class).invoke(null, java.nio.file.Paths.get(path));
    HttpClient c =
        started(new HttpClient(new org.eclipse.jetty.client.http.HttpClientTransportOverHTTP(connector)));
    try {
      return get(c.newRequest(url));
    } finally {
      c.stop();
    }
  }

  static HttpClient newTlsClient(SslContextFactory.Client tls) {
    ClientConnector connector = new ClientConnector();
    connector.setSslContextFactory(tls);
    return new HttpClient(new org.eclipse.jetty.client.http.HttpClientTransportOverHTTP(connector));
  }

  /** Routes a URL on "default", for storm. */
  static final java.util.function.Function<String, String> ROUTE =
      url -> {
        try {
          return route(client("default").resolveDestination(client("default").newRequest(url)));
        } catch (Exception e) {
          throw new RuntimeException(e);
        }
      };

  static String route(Object destination) throws Exception {
    Object proxy = destination.getClass().getMethod("getProxy").invoke(destination);
    Object origin = destination.getClass().getMethod("getOrigin").invoke(destination);
    Object tag = origin.getClass().getMethod("getTag").invoke(origin);
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
