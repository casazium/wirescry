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
import java.util.Random;

/**
 * Wirescry's Java agent, started by the stub (com.wirescry.agent.Stub) from the bootstrap class
 * path, once per JVM. It reads Wirescry's control file once before returning, so a program started
 * with the agent has its settings before main. A daemon thread then reads the file every second,
 * decides whether the agent is on, and writes this JVM's status file for Wirescry.
 *
 * <p>Startup cost matters: this runs before main in every JVM that loads the agent. It touches no
 * logging, JMX, TLS or networking classes, and uses no lambdas (each would start the
 * java.lang.invoke machinery early).
 */
public final class Agent {
  /** Reads of a half-written or damaged control file in a row that turn the agent off. */
  static final int BAD_READS_OFF = 3;
  /** Reads with no change in Wirescry's heartbeat that mean Wirescry is gone (about 15 s). */
  static final int STALE_READS_OFF = 15;
  static final long POLL_MS = 1000;
  /** A status file is rewritten at least this often, so Wirescry can tell a live JVM from a dead one. */
  static final int STATUS_EVERY_POLLS = 5;

  private static Agent running;

  final String route;
  final String id;
  final File dir;
  private final long startedNanos = System.nanoTime();
  private final Liveness liveness = new Liveness();
  private Control lastGood;
  private int badReads;
  private boolean on;
  private String reason = "starting";
  private Status status;

  private Agent(String route, String id, File dir) {
    this.route = route;
    this.id = id;
    this.dir = dir;
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
    final Agent agent = new Agent(route, id, dir);
    agent.poll();
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

  /** Whether the agent is on: what later pull requests' hooks ask before changing anything. */
  public static boolean isOn() {
    Agent agent = running;
    return agent != null && agent.on;
  }

  /** The id Wirescry gave in the attach arguments (`id=<id>`), or null if they're wrong. */
  static String attachId(String args) {
    if (args == null || !args.startsWith("id=")) return null;
    String id = args.substring("id=".length());
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
        poll();
      } catch (Throwable ignored) {
        // Keep going: the next read may work. An interrupt can't come from Wirescry.
      }
    }
  }

  /** One read of the control file: decides on or off, and writes the status file when due. */
  synchronized void poll() {
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
          else accept(read);
        }
      } catch (NoSuchFileException e) {
        off("no-control");
      } catch (Exception e) {
        badRead();
      }
    }
    writeStatusIfDue();
  }

  private void badRead() {
    badReads++;
    if (lastGood == null || badReads >= BAD_READS_OFF) {
      lastGood = null;
      off("bad-control");
    }
    // Otherwise keep the last good settings: a scanner or a slow write may hold the file briefly.
  }

  private void accept(Control control) {
    badReads = 0;
    lastGood = control;
    if (!liveness.alive(control)) off("wirescry-gone");
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
    long delayMs = "attach".equals(route) ? 0 : lastGood == null ? 5000 : lastGood.statusDelayMs;
    if ((System.nanoTime() - startedNanos) / 1_000_000 < delayMs) return;
    if (status == null) status = new Status(this);
    status.write(on, reason, lastGood, polls % STATUS_EVERY_POLLS == 0);
  }
}
