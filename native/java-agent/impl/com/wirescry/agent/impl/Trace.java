/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

/**
 * Notes for tests only: with `-Dwirescry.agent.test.trace=true`, why a hook did nothing (a weave
 * that failed, or a trust check that didn't vouch for a chain) goes to the program's stderr, one
 * line each starting "wirescry-trace: ", so a failure on a test machine says which. Callers check
 * ON before building a note, so off it costs a field read.
 */
final class Trace {
  static final boolean ON = on();

  private Trace() {}

  private static boolean on() {
    try {
      return Boolean.getBoolean("wirescry.agent.test.trace");
    } catch (Throwable t) {
      // A property refused (a SecurityManager): off.
      return false;
    }
  }

  private static final long START = System.nanoTime();

  /** One line: milliseconds since the agent started, the thread, and the message. */
  static void note(String message) {
    if (!ON) return;
    try {
      long ms = (System.nanoTime() - START) / 1_000_000L;
      System.err.println("wirescry-trace: " + ms + " ms [" + Thread.currentThread().getName() + "] " + message);
    } catch (Throwable t) {
      // Nothing to do: a note must never change what the program does.
    }
  }
}
