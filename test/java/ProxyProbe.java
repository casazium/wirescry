/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.SocketAddress;
import java.net.URI;
import java.net.URL;
import java.util.Collections;
import java.util.List;

/**
 * A proxy probe for test/java-agent-proxy.test.ts, Java 8+. Prints "ready", then runs one command
 * per line on stdin and prints one line for it. Nothing touches the JDK's proxy selector before
 * the first command, so a test can attach the agent before or after the selector loads.
 *
 * <pre>
 *   select URI        what ProxySelector.getDefault() chooses: "DIRECT", "HTTP host:port" or
 *                     "SOCKS host:port", space-separated
 *   get URL           HttpURLConnection with the default selector: "OK <body>" or "FAIL ..."
 *   direct URL        the same with Proxy.NO_PROXY
 *   via PORT URL      the same with an HTTP proxy at 127.0.0.1:PORT
 *   own               replaces the default selector with one that always says DIRECT
 *   clear NAME        clears a system property (macOS sets http.nonProxyHosts in every JVM)
 *   set NAME VALUE    sets a system property
 *   prop NAME         a system property's value, or "null"
 * </pre>
 */
public class ProxyProbe {
  public static void main(String[] args) throws Exception {
    System.setProperty("http.keepAlive", "false");
    System.out.println("ready");
    System.out.flush();
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
    String line;
    while ((line = in.readLine()) != null) {
      String result;
      try {
        result = run(line.trim().split(" "));
      } catch (Exception e) {
        Throwable root = e;
        while (root.getCause() != null && root.getCause() != root) root = root.getCause();
        result = "FAIL " + root.getClass().getName() + ": " + String.valueOf(root.getMessage()).replace('\n', ' ');
      }
      System.out.println(result);
      System.out.flush();
    }
  }

  static String run(String[] c) throws Exception {
    if (c[0].equals("select")) {
      StringBuilder s = new StringBuilder();
      for (Proxy p : ProxySelector.getDefault().select(new URI(c[1]))) {
        if (s.length() > 0) s.append(' ');
        if (p.type() == Proxy.Type.DIRECT) {
          s.append("DIRECT");
        } else {
          InetSocketAddress a = (InetSocketAddress) p.address();
          s.append(p.type()).append(' ').append(a.getHostString()).append(':').append(a.getPort());
        }
      }
      return s.toString();
    }
    if (c[0].equals("get")) return get((HttpURLConnection) new URL(c[1]).openConnection());
    if (c[0].equals("direct")) return get((HttpURLConnection) new URL(c[1]).openConnection(Proxy.NO_PROXY));
    if (c[0].equals("via")) {
      Proxy proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", Integer.parseInt(c[1])));
      return get((HttpURLConnection) new URL(c[2]).openConnection(proxy));
    }
    if (c[0].equals("prop")) return String.valueOf(System.getProperty(c[1]));
    if (c[0].equals("set")) {
      System.setProperty(c[1], c[2]);
      return "set";
    }
    if (c[0].equals("clear")) {
      System.clearProperty(c[1]);
      return "cleared";
    }
    if (c[0].equals("own")) {
      ProxySelector.setDefault(
          new ProxySelector() {
            @Override
            public List<Proxy> select(URI uri) {
              return Collections.singletonList(Proxy.NO_PROXY);
            }

            @Override
            public void connectFailed(URI uri, SocketAddress sa, java.io.IOException e) {}
          });
      return "set";
    }
    return "FAIL unknown command";
  }

  static String get(HttpURLConnection connection) throws Exception {
    connection.setConnectTimeout(5000);
    connection.setReadTimeout(5000);
    int status = connection.getResponseCode();
    if (status != 200) return "FAIL status " + status;
    ByteArrayOutputStream body = new ByteArrayOutputStream();
    try (InputStream in = connection.getInputStream()) {
      byte[] buffer = new byte[4096];
      for (int n; (n = in.read(buffer)) > 0; ) body.write(buffer, 0, n);
    }
    connection.disconnect();
    return "OK " + new String(body.toByteArray(), "UTF-8");
  }
}
