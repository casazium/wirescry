/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import java.lang.reflect.Method;
import java.util.Optional;

/**
 * Whether Wirescry is still running, so an agent stops sending traffic to a proxy that's gone.
 *
 * <p>Two checks, either of which says "gone":
 *
 * <ul>
 *   <li>The heartbeat: Wirescry changes `seq` every few seconds. Unchanged for {@link
 *       Agent#STALE_READS_OFF} reads in a row means gone. Reads are counted, not timed, so a clock
 *       change or sleep doesn't matter. This works on every Java.
 *   <li>On Java 9 and later, Wirescry's process. When a read shows the heartbeat has just moved,
 *       Wirescry is surely alive, so the start time of its pid is noted then. Until the next move,
 *       the pid must still exist with that start time. This notices a crash within a second, and a
 *       new Wirescry that got the same pid is noted again at its first heartbeat. Node has no start
 *       time that matches Java's, so Wirescry never writes one.
 * </ul>
 */
final class Liveness {
  /** What the process check needs; tests give their own. */
  interface Processes {
    /** "Can't tell": no ProcessHandle (Java 8). */
    Object UNKNOWN = new Object();

    /** The live process `pid`, null if there's none, or UNKNOWN. */
    Object handle(long pid);

    /** The process's start time, or null if the system doesn't say. */
    Object startInstant(Object handle);
  }

  private final Processes processes;
  private long lastSeq = -1;
  private int staleReads;
  private long notedPid;
  private Object notedStart;

  Liveness() {
    this(Real.INSTANCE);
  }

  Liveness(Processes processes) {
    this.processes = processes;
  }

  /** `checkProcess` is false for the read before main, which uses the heartbeat rule only. */
  boolean alive(Control control, boolean checkProcess) {
    boolean moved = control.seq != lastSeq;
    staleReads = moved ? 0 : staleReads + 1;
    lastSeq = control.seq;
    if (staleReads >= Agent.STALE_READS_OFF) return false;
    if (!checkProcess || control.wirescryPid == 0) return true;
    Object handle = processes.handle(control.wirescryPid);
    if (handle == Processes.UNKNOWN) return true;
    if (handle == null) return false;
    Object start = processes.startInstant(handle);
    if (moved) {
      notedPid = control.wirescryPid;
      notedStart = start;
      return true;
    }
    // Nothing noted for this pid yet: the heartbeat hasn't moved since it appeared.
    if (notedPid != control.wirescryPid || notedStart == null) return true;
    return notedStart.equals(start);
  }

  /** java.lang.ProcessHandle (Java 9+) by reflection: the agent is compiled for Java 8. */
  static final class Real implements Processes {
    static final Real INSTANCE = new Real();

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

    @Override
    public Object handle(long pid) {
      if (OF == null) return UNKNOWN;
      try {
        Object handle = ((Optional<?>) OF.invoke(null, pid)).orElse(null);
        if (handle == null || !Boolean.TRUE.equals(IS_ALIVE.invoke(handle))) return null;
        return handle;
      } catch (Exception e) {
        return UNKNOWN;
      }
    }

    @Override
    public Object startInstant(Object handle) {
      try {
        return ((Optional<?>) START.invoke(INFO.invoke(handle))).orElse(null);
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
        long pid = Control.number(new java.io.File("/proc/self").getCanonicalFile().getName());
        if (pid > 0) return pid;
      } catch (Exception e) {
        // fall through
      }
      try {
        // "<pid>@<host>" on HotSpot and OpenJ9.
        String name = java.lang.management.ManagementFactory.getRuntimeMXBean().getName();
        long pid = Control.number(name.substring(0, name.indexOf('@')));
        if (pid > 0) return pid;
      } catch (Throwable e) {
        // fall through
      }
      return -1;
    }
  }
}
