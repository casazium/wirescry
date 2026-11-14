/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.Arrays;

/**
 * Runs a main class in a class loader of its own, as an application server or a plugin system
 * would: `Isolated CLASSPATH MAIN ARGS...`, the class path separated as the system's (`:` or
 * `;`). Its parent is the JDK's platform loader (the extension loader on Java 8), so the classes
 * it loads see nothing of the system class path, where the agent is.
 */
public class Isolated {
  public static void main(String[] args) throws Exception {
    String[] entries = args[0].split(File.pathSeparator);
    URL[] urls = new URL[entries.length];
    for (int i = 0; i < entries.length; i++) urls[i] = new File(entries[i]).toURI().toURL();
    URLClassLoader loader = new URLClassLoader(urls, ClassLoader.getSystemClassLoader().getParent());
    Thread.currentThread().setContextClassLoader(loader);
    Class.forName(args[1], true, loader)
        .getMethod("main", String[].class)
        .invoke(null, (Object) Arrays.copyOfRange(args, 2, args.length));
  }
}
