/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

/**
 * Off means direct, for agents loaded at startup. A terminal Wirescry sets up gives Java the JDK's
 * proxy properties (`http.proxyHost=127.0.0.1`, `http.proxyPort=<port>`, and the same for https)
 * as well as the agent, so a program whose agent can't load still reaches Wirescry. But once
 * Wirescry quits, those properties send every request to a closed port. So while the agent is off
 * it clears them, and when it turns on again it puts them back, on Wirescry's port of the moment.
 *
 * <p>It clears them only when Wirescry is gone: quit, crashed, or its files deleted. Turning the
 * startup setting off leaves them, as before the agent: those terminals still send to Wirescry. And
 * when the agent can't tell (its files refused, or unreadable), nothing changes.
 *
 * <p>Only Wirescry's values are touched: the host `127.0.0.1` with Wirescry's port, which is the
 * port the terminal named in the agent's arguments (`terminalPort=`), the control file's, or the
 * one this agent last set. Anything else is the program's own proxy, and stays.
 *
 * <p>The JDK reads these properties for each connection (sun.net.spi.DefaultProxySelector), so a
 * change applies to the next request, including in clients built earlier.
 */
final class ProxyProperties {
  /** What the agent knows of Wirescry (see Agent.wirescry). */
  static final int GONE = 0, RUNNING = 1, UNKNOWN = 2;

  private static final String HOST = "127.0.0.1";
  private static final String[] SCHEMES = {"http", "https"};

  /** The port the terminal set, or 0. */
  private final int terminalPort;
  /** Which schemes' properties this agent cleared, to put back. */
  private final boolean[] cleared = new boolean[SCHEMES.length];
  /** The port this agent last set or saw as Wirescry's, or 0. */
  private int lastPort;

  ProxyProperties(int terminalPort) {
    this.terminalPort = terminalPort;
  }

  /** The `terminalPort=` in the agent's arguments (comma-separated `key=value` pairs), or 0. */
  static int terminalPort(String args) {
    if (args == null) return 0;
    long port = 0;
    for (String pair : Control.split(args, ',')) {
      if (pair.startsWith("terminalPort=")) {
        if (port != 0) return 0;
        port = Control.number(pair.substring("terminalPort=".length()));
        if (port < 1 || port > 65535) return 0;
      }
    }
    return (int) port;
  }

  /**
   * After each read of the control file: `wirescry` is GONE, RUNNING or UNKNOWN, `controlPort` the
   * control file's port (0 if there's no good read).
   */
  void apply(int wirescry, int controlPort) {
    if (wirescry == UNKNOWN) return;
    boolean on = wirescry == RUNNING;
    for (int i = 0; i < SCHEMES.length; i++) {
      String hostKey = SCHEMES[i] + ".proxyHost";
      String portKey = SCHEMES[i] + ".proxyPort";
      try {
        String host = System.getProperty(hostKey);
        String port = System.getProperty(portKey);
        boolean wirescrys =
            HOST.equals(host)
                && port != null
                && (is(port, controlPort) || is(port, terminalPort) || is(port, lastPort));
        if (!on) {
          if (wirescrys) {
            System.clearProperty(hostKey);
            System.clearProperty(portKey);
            cleared[i] = true;
          }
        } else if (controlPort > 0) {
          if (cleared[i]) {
            cleared[i] = false;
            // Unless the program set its own meanwhile.
            if (host == null && port == null) {
              // The port first: a host alone would send requests to port 80 for a moment.
              System.setProperty(portKey, String.valueOf(controlPort));
              System.setProperty(hostKey, HOST);
            }
          } else if (wirescrys && !is(port, controlPort)) {
            // Wirescry moved to another port.
            System.setProperty(portKey, String.valueOf(controlPort));
          }
        }
      } catch (Throwable t) {
        // A SecurityManager that refuses: leave the properties as they are.
      }
    }
    if (on && controlPort > 0) lastPort = controlPort;
  }

  private static boolean is(String value, int port) {
    return port > 0 && value.equals(String.valueOf(port));
  }
}
