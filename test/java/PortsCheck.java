/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

/**
 * Checks the ports the agent knows as Wirescry's (Agent.wirescryPort), which the Reactor Netty
 * hook asks before it follows a terminal's proxy: the terminal's port kept for good, a control
 * file's 1,024 most recent, nothing else. Run by test/java-agent-netty.test.ts with the agent's
 * classes on the class path; prints "ok <case>" for each case that passes and "FAIL <case>" for
 * each that doesn't.
 */
public final class PortsCheck {
  private static void check(String name, boolean passed) {
    System.out.println((passed ? "ok " : "FAIL ") + name);
  }

  public static void main(String[] args) {
    check("nothing known at first", !Agent.wirescryPort(9000) && !Agent.wirescryPort(1));
    Agent.rememberTerminalPort(9000);
    check("the terminal's port", Agent.wirescryPort(9000));
    for (int p = 1; p <= 1030; p++) Agent.rememberPort(10000 + p);
    check("the 1,024 most recent control ports", Agent.wirescryPort(10007) && Agent.wirescryPort(11030));
    check("older ones dropped", !Agent.wirescryPort(10001) && !Agent.wirescryPort(10006));
    check("the terminal's port never dropped", Agent.wirescryPort(9000));
    // Again: no duplicate takes a place, so nothing more drops.
    for (int i = 0; i < 5; i++) Agent.rememberPort(11030);
    check("a port remembered again takes no place", Agent.wirescryPort(10007));
    Agent.rememberPort(9000);
    check("the terminal's port takes no place either", Agent.wirescryPort(10007));
    check("bad ports never Wirescry's", !Agent.wirescryPort(0) && !Agent.wirescryPort(-1));
    Agent.rememberPort(70000);
    Agent.rememberPort(0);
    check("bad ports not remembered", !Agent.wirescryPort(70000) && Agent.wirescryPort(10007));
    check("another port isn't Wirescry's", !Agent.wirescryPort(8080));
  }
}
