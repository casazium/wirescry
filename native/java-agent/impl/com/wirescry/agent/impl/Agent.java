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

  /**
   * The most control-file ports {@link #wirescryPort} remembers; the oldest go first. A client
   * keeps the port it was built with for good (a terminal's, after ProxyProperties moved it to the
   * control file's at startup), so this is large enough that no real session drops one: 4 KB.
   */
  static final int PORTS_KEPT = 1024;

  /**
   * The ports a live Wirescry has had while this agent ran, by its control file, oldest first:
   * copied on write, read by hooks on any thread.
   */
  private static volatile int[] wirescryPorts = new int[0];

  /**
   * The port the terminal that started this program named (`terminalPort=`), or 0: kept apart, and
   * never dropped. ProxyProperties moves the terminal's proxy properties to the control file's port
   * before the program's main, so clients start on that; this one matters where it can't (a
   * SecurityManager that refuses).
   */
  private static volatile int terminalPort;

  final String route;
  final String id;
  final File dir;
  private final long startedNanos = System.nanoTime();
  private final Liveness liveness = new Liveness();
  private volatile Control lastGood;
  private final Hooks hooks = new Hooks();
  /** Wirescry's proxy properties, cleared while off; startup agents only (see ProxyProperties). */
  private final ProxyProperties properties;
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
  /** What the agent knows of Wirescry, as ProxyProperties takes it: read by hooks, so volatile. */
  private volatile int wirescryState = ProxyProperties.UNKNOWN;
  private String reason = "starting";
  private Status status;

  private Agent(String route, String id, File dir, Instrumentation inst, ProxyProperties properties) {
    this.route = route;
    this.id = id;
    this.dir = dir;
    this.inst = inst;
    this.properties = properties;
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
    boolean attach = "attach".equals(route);
    final Agent agent =
        new Agent(route, id, dir, inst, attach ? null : new ProxyProperties(ProxyProperties.terminalPort(args)));
    if (!attach) rememberTerminalPort(ProxyProperties.terminalPort(args));
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
    // Normal, not the lowest: it wakes once a second for a moment, so it costs a program nothing,
    // but Windows honours Java's priorities, and at the lowest a busy program's own threads kept it
    // from running for seconds (a port change, turning off and the status file all came late).
    thread.setPriority(Thread.NORM_PRIORITY);
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

  /** What the agent knows of Wirescry: ProxyProperties.GONE, RUNNING or UNKNOWN. */
  static int wirescryState() {
    Agent agent = running;
    return agent == null ? ProxyProperties.UNKNOWN : agent.wirescryState;
  }

  /** Whether `port` has been Wirescry's while this agent ran: the terminal's, or a control file's. */
  static boolean wirescryPort(int port) {
    if (port <= 0) return false;
    if (port == terminalPort) return true;
    for (int p : wirescryPorts) {
      if (p == port) return true;
    }
    return false;
  }

  static void rememberTerminalPort(int port) {
    if (port > 0 && port <= 65535) terminalPort = port;
  }

  /** Adds `port` to {@link #wirescryPorts} if it's new, dropping the oldest past PORTS_KEPT. */
  static synchronized void rememberPort(int port) {
    if (port <= 0 || port > 65535 || port == terminalPort) return;
    for (int p : wirescryPorts) {
      if (p == port) return;
    }
    int[] before = wirescryPorts;
    int drop = before.length >= PORTS_KEPT ? before.length - PORTS_KEPT + 1 : 0;
    int[] after = new int[before.length - drop + 1];
    System.arraycopy(before, drop, after, 0, before.length - drop);
    after[after.length - 1] = port;
    wirescryPorts = after;
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
          else {
            // 0 when the system can't say: then the age is unknown, not old.
            long modified = control.lastModified();
            accept(read, !first, modified > 0 ? System.currentTimeMillis() - modified : -1);
          }
        }
      } catch (NoSuchFileException e) {
        off("no-control");
      } catch (Exception e) {
        badRead();
      }
    }
    wirescryState = wirescry();
    if (properties != null) properties.apply(wirescryState, lastGood == null ? 0 : lastGood.proxyPort);
    if (!first && !retransformed) {
      // Classes the agent changes that loaded before its transformer: once, from this thread. For
      // an attach, those the program loaded; at startup, those an agent named before this one
      // loaded in its own premain (a monitoring agent sending its first report, say).
      retransformed = true;
      // For tests only: a pause first, so a test can act in the window before it (as another
      // agent's retransform might).
      try {
        long pause = Long.getLong("wirescry.agent.test.retransformDelayMs", 0L).longValue();
        if (pause > 0) Thread.sleep(Math.min(pause, 60_000L));
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      } catch (Throwable ignored) {
        // A property refused (a SecurityManager): no pause.
      }
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

  /**
   * Whether Wirescry is running, for ProxyProperties: gone after a quit (`enabled=false`), a crash,
   * or with its control file deleted; running while it says on, or only that startup agents are
   * off (its setting); unknown otherwise (files refused, or unreadable), where nothing changes.
   */
  private int wirescry() {
    if ("off".equals(reason) || "wirescry-gone".equals(reason) || "no-control".equals(reason)) {
      return ProxyProperties.GONE;
    }
    if ("on".equals(reason) || "startup-off".equals(reason)) return ProxyProperties.RUNNING;
    return ProxyProperties.UNKNOWN;
  }

  private void accept(Control control, boolean checkProcess, long ageMs) {
    badReads = 0;
    lastGood = control;
    statusDelayMs = control.statusDelayMs;
    if (!liveness.alive(control, checkProcess, ageMs)) {
      off("wirescry-gone");
      return;
    }
    // A port a live Wirescry had (not a stale file's), whatever it says of agents.
    rememberPort(control.proxyPort);
    if (!control.enabled) off("off");
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
