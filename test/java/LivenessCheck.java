/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

/**
 * Checks Liveness (native/java-agent) with a fake process table, which real processes can't give:
 * a Wirescry that restarts with the same pid, or whose start time changes. Run by
 * test/java-agent.test.ts with the agent's classes on the class path; prints "ok <case>" for each
 * case that passes and "FAIL <case>" for each that doesn't.
 */
public final class LivenessCheck {
  static final class Fake implements Liveness.Processes {
    Object handle = "wirescry";
    Object start = "t1";
    int asked;

    @Override
    public Object handle(long pid) {
      asked++;
      return handle;
    }

    @Override
    public Object startInstant(Object handle) {
      return start;
    }
  }

  static Control control(long seq) {
    return Control.parse(
        "protocol=1\nimpl=jars/wirescry-agent-impl-x.jar\nenabled=true\nstartup=true\nproxyPort=8000\n"
            + "config=1\nseq=" + seq + "\nwirescryPid=77\nend=1\n");
  }

  static int failures;

  static void check(String name, boolean ok) {
    System.out.println((ok ? "ok " : "FAIL ") + name);
    if (!ok) failures++;
  }

  public static void main(String[] args) {
    Fake fake = new Fake();
    Liveness live = new Liveness(fake);
    check("the read before main asks no process", live.alive(control(1), false) && fake.asked == 0);
    check("alive while the heartbeat hasn't moved since the pid appeared", live.alive(control(1), true));
    check("noted when the heartbeat moves", live.alive(control(2), true));
    fake.start = "t2";
    check("gone when the pid's start time changes", !live.alive(control(2), true));
    check("noted again when the new Wirescry's heartbeat moves", live.alive(control(3), true));
    check("and alive after", live.alive(control(3), true));
    fake.handle = null;
    check("gone when the pid has no process", !live.alive(control(3), true));
    fake.handle = Liveness.Processes.UNKNOWN;
    check("the heartbeat alone on Java 8", live.alive(control(4), true));

    Liveness stale = new Liveness(new Fake());
    boolean on = true;
    for (int i = 0; i < Agent.STALE_READS_OFF; i++) on = stale.alive(control(5), true);
    check("alive for " + Agent.STALE_READS_OFF + " reads of one heartbeat", on);
    check("gone at the next, though the process lives", !stale.alive(control(5), true));
    check("back when the heartbeat moves", stale.alive(control(6), true));

    Fake noStart = new Fake();
    noStart.start = null;
    Liveness unknownStart = new Liveness(noStart);
    unknownStart.alive(control(1), true);
    check("alive when the system gives no start time", unknownStart.alive(control(1), true));
    System.exit(failures == 0 ? 0 : 1);
  }
}
