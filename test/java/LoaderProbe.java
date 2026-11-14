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
 *   load 4|5      a new class loader with Apache 4.x or 5.x, and a DefaultRoutePlanner from it:
 *                 "loaded N", N its number from 0
 *   fake DIR      a new class loader for the classes in DIR (the rest of the line, spaces and all) (a stand-in Apache, see
 *                 test/java/fake-apache), and its DefaultRoutePlanner: "loaded N"
 *   route N URL   what loader N's planner chooses: "DIRECT" or "PROXY host:port". For a stand-in,
 *                 its own route(host) answers
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
          int v = Integer.parseInt(p[1]);
          URLClassLoader loader = new URLClassLoader(urls(v == 5 ? args[0] : args[1]), ClassLoader.getSystemClassLoader().getParent());
          String pkg = v == 5 ? "org.apache.hc.client5.http." : "org.apache.http.";
          Class<?> resolver = loader.loadClass(pkg + (v == 5 ? "impl.DefaultSchemePortResolver" : "impl.conn.DefaultSchemePortResolver"));
          Class<?> spr = loader.loadClass(pkg + (v == 5 ? "SchemePortResolver" : "conn.SchemePortResolver"));
          Object planner =
              loader
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
        {
          URLClassLoader loader =
              new URLClassLoader(new URL[] {new File(rest(p, 1)).toURI().toURL()}, ClassLoader.getSystemClassLoader().getParent());
          Object planner = loader.loadClass("org.apache.hc.client5.http.impl.routing.DefaultRoutePlanner").newInstance();
          loaders.add(loader);
          planners.add(planner);
          versions.add(0);
          return "loaded " + (loaders.size() - 1);
        }
      case "route":
        return route(Integer.parseInt(p[1]), p[2]);
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
