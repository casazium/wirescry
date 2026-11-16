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
 * Reactor Netty in class loaders of the probe's own, for test/java-agent-netty.test.ts: as many as
 * asked for, each one it can close and drop, as an application server or plugin host has.
 * `NettyLoaderProbe CLASSPATH`, NettyProbe's classes and Reactor Netty's jars, separated as the
 * system's. Prints "ready", then one line per command on stdin:
 *
 * <pre>
 *   load            a new class loader with Reactor Netty and NettyProbe: "loaded N"
 *   fake DIR        a new class loader for the stand-in Reactor Netty in DIR (the rest of the line,
 *                   spaces and all: see test/java/fake-netty): "loaded N"
 *   route N KIND URL  NettyProbe's `route` in loader N (a request: Reactor Netty's threads start)
 *   decide N HOST PORT  NettyProbe's `decide` in loader N (no request, no threads)
 *   describe N      for a stand-in: HttpConnectionProvider.describe()
 *   drop N          shuts Reactor Netty's event loops in loader N (if it has them), closes the
 *                   loader, and drops every reference to it: "dropped"
 *   gc              whether the dropped loaders were freed: "COLLECTED" or "LEAKED"
 * </pre>
 *
 * Each command that runs Reactor Netty's code runs on a thread of its own, which ends with it: a
 * thread that lives on keeps Netty's thread-locals, and so their class loader.
 */
public class NettyLoaderProbe {
  static final List<URLClassLoader> loaders = new ArrayList<URLClassLoader>();
  static final List<String> kinds = new ArrayList<String>();
  static final List<WeakReference<ClassLoader>> dropped = new ArrayList<WeakReference<ClassLoader>>();

  public static void main(String[] args) throws Exception {
    System.out.println("ready");
    System.out.flush();
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
    String line;
    while ((line = in.readLine()) != null) {
      final String[] p = line.trim().split(" ");
      final String whole = line.trim();
      final String[] arguments = args;
      final String[] out = new String[1];
      Thread thread =
          new Thread() {
            @Override
            public void run() {
              try {
                out[0] = command(p, whole, arguments);
              } catch (Throwable t) {
                Throwable cause = t instanceof InvocationTargetException && t.getCause() != null ? t.getCause() : t;
                out[0] = "FAIL " + cause.getClass().getName() + ": " + cause.getMessage();
              }
            }
          };
      thread.start();
      thread.join();
      System.out.println(out[0].replace('\n', ' ').replace('\r', ' '));
      System.out.flush();
    }
  }

  static URLClassLoader loader(String classpath) throws Exception {
    String[] entries = classpath.split(File.pathSeparator);
    URL[] urls = new URL[entries.length];
    for (int i = 0; i < entries.length; i++) urls[i] = new File(entries[i]).toURI().toURL();
    return new URLClassLoader(urls, ClassLoader.getSystemClassLoader().getParent());
  }

  static String command(String[] p, String line, String[] args) throws Exception {
    if ("load".equals(p[0])) {
      loaders.add(loader(args[0]));
      kinds.add("real");
      return "loaded " + (loaders.size() - 1);
    }
    if ("fake".equals(p[0])) {
      String dir = line.substring("fake ".length());
      loaders.add(new URLClassLoader(new URL[] {new File(dir).toURI().toURL()}, ClassLoader.getSystemClassLoader().getParent()));
      kinds.add(dir.endsWith("shaded") ? "shaded" : "fake");
      return "loaded " + (loaders.size() - 1);
    }
    if ("route".equals(p[0])) {
      ClassLoader loader = loaders.get(Integer.parseInt(p[1]));
      Thread.currentThread().setContextClassLoader(loader);
      return (String)
          Class.forName("NettyProbe", true, loader).getMethod("route", String.class, String.class).invoke(null, p[2], p[3]);
    }
    if ("decide".equals(p[0])) {
      ClassLoader loader = loaders.get(Integer.parseInt(p[1]));
      return (String)
          Class.forName("NettyProbe", true, loader)
              .getMethod("decide", String.class, int.class)
              .invoke(null, p[2], Integer.parseInt(p[3]));
    }
    if ("describe".equals(p[0])) {
      int n = Integer.parseInt(p[1]);
      String prefix = "shaded".equals(kinds.get(n)) ? "shaded." : "";
      return (String)
          Class.forName(prefix + "reactor.netty.http.client.HttpConnectionProvider", true, loaders.get(n))
              .getMethod("describe")
              .invoke(null);
    }
    if ("drop".equals(p[0])) {
      int n = Integer.parseInt(p[1]);
      URLClassLoader loader = loaders.set(n, null);
      if ("real".equals(kinds.get(n))) {
        Class.forName("reactor.netty.http.HttpResources", true, loader).getMethod("disposeLoopsAndConnections").invoke(null);
      }
      loader.close();
      dropped.add(new WeakReference<ClassLoader>(loader));
      return "dropped";
    }
    if ("gc".equals(p[0])) {
      // Netty's own threads (event loops after a shutdown, its global executor) end on their own
      // within a few seconds.
      for (int i = 0; i < 150; i++) {
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
