/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.lang.ref.WeakReference;
import java.lang.reflect.InvocationTargetException;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.ArrayList;
import java.util.List;

/**
 * Jetty in class loaders of the probe's own, for test/java-agent-jetty.test.ts: as many as asked
 * for, each one it can stop, close and drop, as an application server or plugin host has.
 * `JettyLoaderProbe CLASSPATH`, Jetty 12's jars separated as the system's. Java 8+ (Jetty 12 needs
 * 17). Prints "ready", then one line per command on stdin:
 *
 * <pre>
 *   load          a new class loader with Jetty, and a started HttpClient from it: "loaded N"
 *   fake DIR      a new class loader for the stand-in Jetty in DIR (the rest of the line, spaces
 *                 and all: see test/java/fake-jetty), and its HttpClient: "loaded N"
 *   route N URL   the destination loader N's client makes for URL: "PROXY host:port", "DIRECT"
 *                 or "DIRECT tagged"
 *   describe N HOST  for a stand-in: its HttpClient.describe(HOST)
 *   drop N        stops loader N's client, closes the loader, and drops every reference to both:
 *                 "dropped"
 *   gc            whether the dropped loaders were freed: "COLLECTED" or "LEAKED"
 * </pre>
 */
public class JettyLoaderProbe {
  static final List<URLClassLoader> loaders = new ArrayList<URLClassLoader>();
  static final List<Object> clients = new ArrayList<Object>();
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
        out = run(p, line.trim(), args);
      } catch (Throwable t) {
        Throwable cause = t instanceof InvocationTargetException && t.getCause() != null ? t.getCause() : t;
        out = "FAIL " + cause.getClass().getName() + ": " + cause.getMessage();
      }
      System.out.println(out.replace('\n', ' ').replace('\r', ' '));
      System.out.flush();
    }
  }

  static URLClassLoader loader(String classpath) throws Exception {
    String[] entries = classpath.split(File.pathSeparator);
    URL[] urls = new URL[entries.length];
    for (int i = 0; i < entries.length; i++) urls[i] = new File(entries[i]).toURI().toURL();
    return new URLClassLoader(urls, ClassLoader.getSystemClassLoader().getParent());
  }

  static String run(String[] p, String line, String[] args) throws Exception {
    if ("load".equals(p[0])) {
      URLClassLoader loader = loader(args[0]);
      Object client = Class.forName("org.eclipse.jetty.client.HttpClient", true, loader).getConstructor().newInstance();
      client.getClass().getMethod("start").invoke(client);
      loaders.add(loader);
      clients.add(client);
      return "loaded " + (loaders.size() - 1);
    }
    if ("fake".equals(p[0])) {
      String dir = line.substring("fake ".length());
      URLClassLoader loader = new URLClassLoader(new URL[] {new File(dir).toURI().toURL()}, ClassLoader.getSystemClassLoader().getParent());
      String name =
          dir.endsWith("shaded")
              ? "com.example.shaded.org.eclipse.jetty.client.HttpClient"
              : "org.eclipse.jetty.client.HttpClient";
      loaders.add(loader);
      clients.add(Class.forName(name, true, loader).getConstructor().newInstance());
      return "loaded " + (loaders.size() - 1);
    }
    if ("route".equals(p[0])) {
      Object client = clients.get(Integer.parseInt(p[1]));
      Object request = client.getClass().getMethod("newRequest", String.class).invoke(client, p[2]);
      Object destination = null;
      for (java.lang.reflect.Method m : client.getClass().getMethods()) {
        if ("resolveDestination".equals(m.getName())
            && m.getParameterTypes().length == 1
            && m.getParameterTypes()[0].isInstance(request)) {
          destination = m.invoke(client, request);
        }
      }
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
    if ("describe".equals(p[0])) {
      Object client = clients.get(Integer.parseInt(p[1]));
      return (String) client.getClass().getMethod("describe", String.class).invoke(client, p[2]);
    }
    if ("drop".equals(p[0])) {
      int n = Integer.parseInt(p[1]);
      Object client = clients.set(n, null);
      try {
        client.getClass().getMethod("stop").invoke(client);
      } catch (NoSuchMethodException e) {
        // A stand-in has nothing to stop.
      }
      URLClassLoader loader = loaders.set(n, null);
      loader.close();
      dropped.add(new WeakReference<ClassLoader>(loader));
      return "dropped";
    }
    if ("gc".equals(p[0])) {
      for (int i = 0; i < 50; i++) {
        System.gc();
        boolean all = true;
        for (WeakReference<ClassLoader> ref : dropped) all &= ref.get() == null;
        if (all) return "COLLECTED";
        Thread.sleep(100);
      }
      return "LEAKED";
    }
    return "FAIL unknown command";
  }
}
