/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.lang.ref.WeakReference;
import java.lang.reflect.InvocationTargetException;
import java.net.URI;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.ArrayList;
import java.util.List;

/**
 * Apache HttpClient in class loaders of the probe's own, for test/java-agent-apache.test.ts: as
 * many as asked for, 4.x and 5.x side by side, each one it can close and drop, as an application
 * server or plugin host has. `LoaderProbe CLASSPATH5 CLASSPATH4`, each a list of jars separated
 * as the system's. Java 8+. Prints "ready", then one line per command on stdin:
 *
 * <pre>
 *   load 4|5|5s   a new class loader with Apache 4.x or 5.x, and a DefaultRoutePlanner from it
 *                 (5s: 5.x's SystemDefaultRoutePlanner, on the JDK's default selector): "loaded
 *                 N", N its number from 0
 *   fake DIR      a new class loader for the classes in DIR (the rest of the line, spaces and
 *                 all: a stand-in Apache, see test/java/fake-apache), and its
 *                 DefaultRoutePlanner: "loaded N"
 *   shaded DIR    the same for the renamed copy in fake-apache/shaded
 *   fakesys DIR   the same for a stand-in SystemDefaultRoutePlanner (fake-apache/system-*)
 *   route N URL   what loader N's planner chooses: "DIRECT" or "PROXY host:port". For a stand-in,
 *                 its own route(host) answers
 *   bench N COUNT URL [DEPTH]  times COUNT routes by loader N's planner, after as many to warm
 *                 up, DEPTH calls deep (default 0) on the stack: "NS <nanoseconds per route>"
 *   storm N THREADS MILLIS URL [change]  THREADS threads route by loader N's planner at once,
 *                 again and again for MILLIS (pausing a moment every 50, so the agent's own
 *                 thread still runs on a small machine), or with "change", only until a second
 *                 answer appears: "ANSWERS <each distinct answer, sorted, |-separated> ERRORS
 *                 <how many threw>"
 *   close N       closes loader N: it serves no more classes or resources: "closed"
 *   drop N        drops every reference to loader N and its planner: "dropped"
 *   gc            whether the dropped loaders were freed: "COLLECTED" or "LEAKED"
 * </pre>
 */
public class LoaderProbe {
  static final List<URLClassLoader> loaders = new ArrayList<URLClassLoader>();
  static final List<Object> planners = new ArrayList<Object>();
  static final List<Integer> versions = new ArrayList<Integer>();
  static final List<WeakReference<ClassLoader>> dropped = new ArrayList<WeakReference<ClassLoader>>();

  public static void main(String[] args) throws Exception {
    System.out.println("ready");
    System.out.flush();
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
    String line;
    while ((line = in.readLine()) != null) {
      String[] p = line.trim().split(" ");
      String out;
      try {
        out = run(p, args);
      } catch (Throwable t) {
        Throwable cause = t instanceof InvocationTargetException ? t.getCause() : t;
        out = "FAIL " + cause.getClass().getName() + ": " + cause.getMessage();
      }
      System.out.println(out);
      System.out.flush();
    }
  }

  static URL[] urls(String classpath) throws Exception {
    String[] entries = classpath.split(File.pathSeparator);
    URL[] urls = new URL[entries.length];
    for (int i = 0; i < entries.length; i++) urls[i] = new File(entries[i]).toURI().toURL();
    return urls;
  }

  static String run(String[] p, String[] args) throws Exception {
    switch (p[0]) {
      case "load":
        {
          boolean system = p[1].equals("5s");
          int v = system ? 5 : Integer.parseInt(p[1]);
          URLClassLoader loader = new URLClassLoader(urls(v == 5 ? args[0] : args[1]), ClassLoader.getSystemClassLoader().getParent());
          String pkg = v == 5 ? "org.apache.hc.client5.http." : "org.apache.http.";
          Class<?> resolver = loader.loadClass(pkg + (v == 5 ? "impl.DefaultSchemePortResolver" : "impl.conn.DefaultSchemePortResolver"));
          Class<?> spr = loader.loadClass(pkg + (v == 5 ? "SchemePortResolver" : "conn.SchemePortResolver"));
          Object planner =
              system
                  ? loader
                      .loadClass("org.apache.hc.client5.http.impl.routing.SystemDefaultRoutePlanner")
                      .getConstructor(spr, java.net.ProxySelector.class)
                      .newInstance(resolver.getField("INSTANCE").get(null), java.net.ProxySelector.getDefault())
                  : loader
                      .loadClass(v == 5 ? "org.apache.hc.client5.http.impl.routing.DefaultRoutePlanner" : "org.apache.http.impl.conn.DefaultRoutePlanner")
                      .getConstructor(spr)
                      .newInstance(resolver.getField("INSTANCE").get(null));
          loaders.add(loader);
          planners.add(planner);
          versions.add(v);
          // The classes a route needs, loaded now: once closed, the loader can't load more.
          route(loaders.size() - 1, "http://warm-up.test/");
          return "loaded " + (loaders.size() - 1);
        }
      case "fake":
      case "shaded":
      case "fakesys":
        {
          URLClassLoader loader =
              new URLClassLoader(new URL[] {new File(rest(p, 1)).toURI().toURL()}, ClassLoader.getSystemClassLoader().getParent());
          String prefix = p[0].equals("shaded") ? "com.example.shaded." : "";
          String simple = p[0].equals("fakesys") ? "SystemDefaultRoutePlanner" : "DefaultRoutePlanner";
          Object planner = loader.loadClass(prefix + "org.apache.hc.client5.http.impl.routing." + simple).newInstance();
          loaders.add(loader);
          planners.add(planner);
          versions.add(0);
          return "loaded " + (loaders.size() - 1);
        }
      case "route":
        return route(Integer.parseInt(p[1]), p[2]);
      case "bench":
        {
          Router router = router(Integer.parseInt(p[1]), p[3]);
          int count = Integer.parseInt(p[2]);
          return "NS " + deep(router, count, p.length > 4 ? Integer.parseInt(p[4]) : 0);
        }
      case "storm":
        {
          final Router router = router(Integer.parseInt(p[1]), p[4]);
          int threads = Integer.parseInt(p[2]);
          final long until = System.nanoTime() + Long.parseLong(p[3]) * 1000000L;
          final boolean change = p.length > 5 && p[5].equals("change");
          final java.util.Set<String> answers = java.util.Collections.synchronizedSet(new java.util.TreeSet<String>());
          final java.util.concurrent.atomic.AtomicInteger errors = new java.util.concurrent.atomic.AtomicInteger();
          final java.util.concurrent.CountDownLatch go = new java.util.concurrent.CountDownLatch(1);
          List<Thread> started = new ArrayList<Thread>();
          for (int t = 0; t < threads; t++) {
            Thread thread =
                new Thread() {
                  public void run() {
                    try {
                      go.await();
                    } catch (InterruptedException e) {
                      return;
                    }
                    int n = 0;
                    while (System.nanoTime() - until < 0 && !(change && answers.size() > 1)) {
                      try {
                        answers.add(router.route());
                      } catch (Throwable e) {
                        errors.incrementAndGet();
                      }
                      if (++n % 50 == 0) {
                        try {
                          Thread.sleep(1);
                        } catch (InterruptedException e) {
                          return;
                        }
                      }
                    }
                  }
                };
            thread.start();
            started.add(thread);
          }
          go.countDown();
          for (Thread thread : started) thread.join();
          StringBuilder out = new StringBuilder();
          for (String a : answers) out.append(out.length() == 0 ? "" : "|").append(a);
          return "ANSWERS " + out + " ERRORS " + errors.get();
        }
      case "close":
        loaders.get(Integer.parseInt(p[1])).close();
        return "closed";
      case "drop":
        {
          int n = Integer.parseInt(p[1]);
          dropped.add(new WeakReference<ClassLoader>(loaders.get(n)));
          loaders.set(n, null);
          planners.set(n, null);
          return "dropped";
        }
      case "gc":
        for (int i = 0; i < 30 && !allFreed(); i++) {
          System.gc();
          Thread.sleep(100);
        }
        return allFreed() ? "COLLECTED" : "LEAKED";
      default:
        return "FAIL unknown command";
    }
  }

  /** Times `count` routes (after as many to warm up) `depth` calls down: nanoseconds per route. */
  static long deep(Router router, int count, int depth) throws Exception {
    if (depth > 0) return deep(router, count, depth - 1);
    for (int i = 0; i < count; i++) router.route();
    long start = System.nanoTime();
    for (int i = 0; i < count; i++) router.route();
    return (System.nanoTime() - start) / count;
  }

  /** The words from `from` on, as one: a path may have spaces. */
  static String rest(String[] p, int from) {
    StringBuilder s = new StringBuilder(p[from]);
    for (int i = from + 1; i < p.length; i++) s.append(' ').append(p[i]);
    return s.toString();
  }

  static boolean allFreed() {
    for (WeakReference<ClassLoader> ref : dropped) if (ref.get() != null) return false;
    return true;
  }

  /** One planner's route for one URL, everything but the call itself looked up once. */
  interface Router {
    String route() throws Exception;
  }

  static Router router(int n, String url) throws Exception {
    URLClassLoader loader = loaders.get(n);
    final Object planner = planners.get(n);
    int v = versions.get(n);
    final Class<?> hostType = loader.loadClass(v == 5 ? "org.apache.hc.core5.http.HttpHost" : "org.apache.http.HttpHost");
    Class<?> contextType =
        loader.loadClass(v == 5 ? "org.apache.hc.core5.http.protocol.HttpContext" : "org.apache.http.protocol.HttpContext");
    final java.lang.reflect.Method create =
        loader
            .loadClass(v == 5 ? "org.apache.hc.client5.http.protocol.HttpClientContext" : "org.apache.http.client.protocol.HttpClientContext")
            .getMethod("create");
    final URI uri = URI.create(url);
    final java.lang.reflect.Method determine;
    final Object[] fixed;
    if (v == 5) {
      determine = planner.getClass().getMethod("determineRoute", hostType, contextType);
      fixed = new Object[] {hostType.getMethod("create", URI.class).invoke(null, uri)};
    } else {
      Class<?> requestType = loader.loadClass("org.apache.http.HttpRequest");
      determine = planner.getClass().getMethod("determineRoute", hostType, requestType, contextType);
      fixed =
          new Object[] {
            hostType.getConstructor(String.class, int.class, String.class).newInstance(uri.getHost(), uri.getPort(), uri.getScheme()),
            loader.loadClass("org.apache.http.message.BasicHttpRequest").getConstructor(String.class, String.class).newInstance("GET", url)
          };
    }
    final java.lang.reflect.Method proxyOf = determine.getReturnType().getMethod("getProxyHost");
    final java.lang.reflect.Method name = hostType.getMethod("getHostName");
    final java.lang.reflect.Method port = hostType.getMethod("getPort");
    return new Router() {
      public String route() throws Exception {
        Object[] args = java.util.Arrays.copyOf(fixed, fixed.length + 1);
        args[fixed.length] = create.invoke(null);
        Object proxy = proxyOf.invoke(determine.invoke(planner, args));
        return proxy == null ? "DIRECT" : "PROXY " + name.invoke(proxy) + ":" + port.invoke(proxy);
      }
    };
  }

  static String route(int n, String url) throws Exception {
    URLClassLoader loader = loaders.get(n);
    Object planner = planners.get(n);
    int v = versions.get(n);
    if (v == 0) {
      return (String) planner.getClass().getMethod("route", String.class).invoke(planner, URI.create(url).getHost());
    }
    Class<?> hostType = loader.loadClass(v == 5 ? "org.apache.hc.core5.http.HttpHost" : "org.apache.http.HttpHost");
    Class<?> contextType =
        loader.loadClass(v == 5 ? "org.apache.hc.core5.http.protocol.HttpContext" : "org.apache.http.protocol.HttpContext");
    Object context =
        loader
            .loadClass(v == 5 ? "org.apache.hc.client5.http.protocol.HttpClientContext" : "org.apache.http.client.protocol.HttpClientContext")
            .getMethod("create")
            .invoke(null);
    Object route;
    if (v == 5) {
      Object target = hostType.getMethod("create", URI.class).invoke(null, URI.create(url));
      route = planner.getClass().getMethod("determineRoute", hostType, contextType).invoke(planner, target, context);
    } else {
      URI uri = URI.create(url);
      Object target = hostType.getConstructor(String.class, int.class, String.class).newInstance(uri.getHost(), uri.getPort(), uri.getScheme());
      Class<?> requestType = loader.loadClass("org.apache.http.HttpRequest");
      Object request = loader.loadClass("org.apache.http.message.BasicHttpRequest").getConstructor(String.class, String.class).newInstance("GET", url);
      route = planner.getClass().getMethod("determineRoute", hostType, requestType, contextType).invoke(planner, target, request, context);
    }
    Object proxy = route.getClass().getMethod("getProxyHost").invoke(route);
    if (proxy == null) return "DIRECT";
    return "PROXY " + hostType.getMethod("getHostName").invoke(proxy) + ":" + hostType.getMethod("getPort").invoke(proxy);
  }
}
