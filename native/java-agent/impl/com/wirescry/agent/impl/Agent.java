/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import java.io.File;
import java.lang.instrument.Instrumentation;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import com.wirescry.agent.Perms;
import java.util.Random;

/**
 * Wirescry's Java agent, started by the stub (com.wirescry.agent.Stub) from the system class
 * loader, once per JVM. It reads Wirescry's control file once before returning, so a program started
 * with the agent has its settings before main. A daemon thread then reads the file every second,
 * decides whether the agent is on, and writes this JVM's status file for Wirescry.
 *
 * <p>Startup cost matters: this runs before main in every JVM that loads the agent. Before main it
 * reads one file and starts one thread: no regular expressions, no process or time classes, no
 * status file, no logging, JMX, TLS or networking, and no lambdas (each would start the
 * java.lang.invoke machinery early). Those wait for the control thread's first read, a second
 * later. agentmain returns as quickly, for the same reasons and so the attacher isn't kept waiting.
 */
public final class Agent {
  /** Reads of a half-written or damaged control file in a row that turn the agent off. */
  static final int BAD_READS_OFF = 3;
  /** Reads with no change in Wirescry's heartbeat that mean Wirescry is gone (about 15 s). */
  static final int STALE_READS_OFF = 15;
  static final long POLL_MS = 1000;
  /** A status file is rewritten at least this often, so Wirescry can tell a live JVM from a dead one. */
  static final int STATUS_EVERY_POLLS = 5;

  private static volatile Agent running;

  final String route;
  final String id;
  final File dir;
  private final long startedNanos = System.nanoTime();
  private final Liveness liveness = new Liveness();
  private volatile Control lastGood;
  private final Hooks hooks = new Hooks();
  private final Instrumentation inst;
  private boolean retransformed;
  /**
   * How long a startup agent waits before its first status file: the control file's, kept after a
   * bad read, so an agent that turns off still says so.
   */
  private long statusDelayMs = 5000;
  private int badReads;
  /** Read by hooks on any thread, so volatile. */
  private volatile boolean on;
  private String reason = "starting";
  private Status status;

  private Agent(String route, String id, File dir, Instrumentation inst) {
    this.route = route;
    this.id = id;
    this.dir = dir;
    this.inst = inst;
  }

  /**
   * Starts the agent, unless an earlier start in this JVM did. A second attach (or an attach to a
   * program started with the agent) changes nothing: the first agent keeps running, and Wirescry
   * finds it by its status file.
   */
  public static synchronized void start(String args, Instrumentation inst, String route, File dir) {
    if (running != null || dir == null) return;
    String id = "attach".equals(route) ? attachId(args) : randomId();
    if (id == null) return;
    final Agent agent = new Agent(route, id, dir, inst);
    // Only compares class names until a class it changes loads: cheap before main.
    inst.addTransformer(agent.hooks, true);
    agent.poll(true);
    Thread thread =
        new Thread(
            new Runnable() {
              @Override
              public void run() {
                agent.loop();
              }
            },
            "wirescry-agent-control");
    thread.setDaemon(true);
    thread.setPriority(Thread.MIN_PRIORITY);
    thread.start();
    running = agent;
  }

  /** Whether the agent is on: what hooks ask before changing anything. */
  public static boolean isOn() {
    Agent agent = running;
    return agent != null && agent.on;
  }

  /** The last good settings, or null. */
  static Control settings() {
    Agent agent = running;
    return agent == null ? null : agent.lastGood;
  }

  /**
   * The id in the attach arguments, or null if there's none or it's not a good one. The arguments
   * are comma-separated `key=value` pairs; keys this agent doesn't know are ignored, so a later
   * Wirescry can add some.
   */
  static String attachId(String args) {
    if (args == null) return null;
    String id = null;
    for (String pair : Control.split(args, ',')) {
      if (pair.startsWith("id=")) {
        if (id != null) return null;
        id = pair.substring("id=".length());
      }
    }
    return Control.validId(id) ? id : null;
  }

  /** A random id for an agent loaded at startup. Not secret: it only has to differ per JVM. */
  private static String randomId() {
    Random random = new Random(System.nanoTime() ^ System.identityHashCode(new Object()));
    String digits = "0123456789abcdefghijklmnopqrstuvwxyz";
    StringBuilder id = new StringBuilder("s");
    for (int i = 0; i < 12; i++) id.append(digits.charAt(random.nextInt(digits.length())));
    return id.toString();
  }

  private void loop() {
    while (true) {
      try {
        Thread.sleep(POLL_MS);
        poll(false);
      } catch (Throwable ignored) {
        // Keep going: the next read may work. An interrupt can't come from Wirescry.
      }
    }
  }

  /**
   * One read of the control file: decides on or off, and writes the status file when due. The first,
   * before main (`first`), skips Wirescry's process check and the status file (see the class note).
   */
  synchronized void poll(boolean first) {
    File control = new File(dir, "control.properties");
    Control read = null;
    if (!Perms.private_(dir)) {
      off("unsafe-files");
    } else {
      try {
        String text = new String(Files.readAllBytes(control.toPath()), StandardCharsets.UTF_8);
        if (!Perms.private_(control)) {
          off("unsafe-files");
        } else {
          read = Control.parse(text);
          if (read == null) badRead();
          else accept(read, !first);
        }
      } catch (NoSuchFileException e) {
        off("no-control");
      } catch (Exception e) {
        badRead();
      }
    }
    if (!first && !retransformed && "attach".equals(route)) {
      // Classes the agent changes that loaded before it was attached: once, from this thread. A
      // startup agent's transformer was there before any of them loaded.
      retransformed = true;
      hooks.retransformLoaded(inst);
    }
    if (!first) writeStatusIfDue();
  }

  String hookReport() {
    return hooks.report(lastGood);
  }

  private void badRead() {
    badReads++;
    if (lastGood == null || badReads >= BAD_READS_OFF) {
      lastGood = null;
      off("bad-control");
    }
    // Otherwise keep the last good settings: a scanner or a slow write may hold the file briefly.
  }

  private void accept(Control control, boolean checkProcess) {
    badReads = 0;
    lastGood = control;
    statusDelayMs = control.statusDelayMs;
    if (!liveness.alive(control, checkProcess)) off("wirescry-gone");
    else if (!control.enabled) off("off");
    else if (!"attach".equals(route) && !control.startup) off("startup-off");
    else if (control.detached.contains(id)) off("detached");
    else {
      on = true;
      reason = "on";
    }
  }

  private void off(String why) {
    on = false;
    reason = why;
  }

  private int polls;

  private void writeStatusIfDue() {
    polls++;
    long delayMs = "attach".equals(route) ? 0 : statusDelayMs;
    if ((System.nanoTime() - startedNanos) / 1_000_000 < delayMs) return;
    if (status == null) status = new Status(this);
    status.write(on, reason, lastGood, polls % STATUS_EVERY_POLLS == 0);
  }
}
