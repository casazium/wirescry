/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import java.lang.reflect.Method;

/**
 * Whether Wirescry is still running, so an agent stops sending traffic to a proxy that's gone.
 *
 * <p>Two checks, either of which says "gone":
 *
 * <ul>
 *   <li>The heartbeat: Wirescry changes `seq` every few seconds. Unchanged for {@link
 *       Agent#STALE_READS_OFF} reads in a row means gone. Reads are counted, not timed, so a clock
 *       change or sleep doesn't matter. This works on every Java.
 *   <li>On Java 9 and later, Wirescry's process: the first time a pid is seen, its start time is
 *       noted; from then on the pid must exist with that same start time. This notices a crash
 *       within a second. Node has no start time that matches Java's, so Wirescry never writes one.
 * </ul>
 */
final class Liveness {
  private long lastSeq = -1;
  private int staleReads;
  private long pid;
  private Object startInstant;

  boolean alive(Control control) {
    if (control.seq == lastSeq) staleReads++;
    else staleReads = 0;
    lastSeq = control.seq;
    if (staleReads >= Agent.STALE_READS_OFF) return false;
    if (control.wirescryPid == 0) return true;
    Object handle = Processes.handle(control.wirescryPid);
    if (handle == Processes.UNKNOWN) return true; // Java 8: the heartbeat alone.
    if (handle == null) return false;
    Object start = Processes.startInstant(handle);
    if (pid != control.wirescryPid) {
      pid = control.wirescryPid;
      startInstant = start;
      return true;
    }
    return startInstant == null || startInstant.equals(start);
  }

  /** java.lang.ProcessHandle (Java 9+) by reflection: the agent is compiled for Java 8. */
  static final class Processes {
    /** "Can't tell": this Java has no ProcessHandle. */
    static final Object UNKNOWN = new Object();

    private static final Method OF, IS_ALIVE, INFO, START, CURRENT, PID;

    static {
      Method of = null, isAlive = null, info = null, start = null, current = null, pid = null;
      try {
        Class<?> handle = Class.forName("java.lang.ProcessHandle");
        of = handle.getMethod("of", long.class);
        isAlive = handle.getMethod("isAlive");
        info = handle.getMethod("info");
        start = Class.forName("java.lang.ProcessHandle$Info").getMethod("startInstant");
        current = handle.getMethod("current");
        pid = handle.getMethod("pid");
      } catch (Exception e) {
        of = null;
      }
      OF = of;
      IS_ALIVE = isAlive;
      INFO = info;
      START = start;
      CURRENT = current;
      PID = pid;
    }

    /** The live process `pid`, null if there's none, or UNKNOWN on Java 8. */
    static Object handle(long pid) {
      if (OF == null) return UNKNOWN;
      try {
        Object optional = OF.invoke(null, pid);
        Object handle = optional.getClass().getMethod("orElse", Object.class).invoke(optional, (Object) null);
        if (handle == null || !Boolean.TRUE.equals(IS_ALIVE.invoke(handle))) return null;
        return handle;
      } catch (Exception e) {
        return UNKNOWN;
      }
    }

    /** The process's start time (an Optional's value), or null if the system doesn't say. */
    static Object startInstant(Object handle) {
      try {
        Object optional = START.invoke(INFO.invoke(handle));
        return optional.getClass().getMethod("orElse", Object.class).invoke(optional, (Object) null);
      } catch (Exception e) {
        return null;
      }
    }

    /**
     * This JVM's pid, or -1. Only Java 8 off Linux needs the runtime MXBean, which starts JMX; it's
     * asked from the control thread when the first status file is due, never before main.
     */
    static long self() {
      try {
        if (CURRENT != null) return (Long) PID.invoke(CURRENT.invoke(null));
      } catch (Exception e) {
        // fall through
      }
      try {
        // Java 8 on Linux: /proc/self is a link named after this process.
        String name = new java.io.File("/proc/self").getCanonicalFile().getName();
        if (name.matches("[0-9]{1,18}")) return Long.parseLong(name);
      } catch (Exception e) {
        // fall through
      }
      try {
        // "<pid>@<host>" on HotSpot and OpenJ9.
        String name = java.lang.management.ManagementFactory.getRuntimeMXBean().getName();
        String digits = name.substring(0, name.indexOf('@'));
        if (digits.matches("[0-9]{1,18}")) return Long.parseLong(digits);
      } catch (Throwable e) {
        // fall through
      }
      return -1;
    }
  }
}
