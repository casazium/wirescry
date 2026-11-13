/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * Wirescry's settings for every agent, from `control.properties` (written by
 * src/backend/java/agent-files.ts). One `key=value` per line, UTF-8, ending with `end=1`: a file
 * without that line is half-written or damaged, and is a bad read. Unknown keys are ignored, so a
 * newer Wirescry can add some; a `protocol` this agent doesn't know is a bad read.
 */
final class Control {
  static final int PROTOCOL = 1;
  private static final String ID = "[A-Za-z0-9_-]{1,64}";

  final boolean enabled;
  /** Whether agents loaded at startup (not attached) are on. */
  final boolean startup;
  final int proxyPort;
  /** Changes when the port, the CA or `enabled` change; the status file echoes it once applied. */
  final long config;
  /** Wirescry's heartbeat: it changes every few seconds while Wirescry runs. */
  final long seq;
  /** Wirescry's backend process, or 0 if not given. */
  final long wirescryPid;
  /** How long a startup agent waits before writing its status file, in milliseconds. */
  final long statusDelayMs;
  /** The CA's SHA-256, in hex, or "" if not given. */
  final String caSha256;
  /** Agents Wirescry has detached, by id. */
  final Set<String> detached;

  private Control(
      boolean enabled,
      boolean startup,
      int proxyPort,
      long config,
      long seq,
      long wirescryPid,
      long statusDelayMs,
      String caSha256,
      Set<String> detached) {
    this.enabled = enabled;
    this.startup = startup;
    this.proxyPort = proxyPort;
    this.config = config;
    this.seq = seq;
    this.wirescryPid = wirescryPid;
    this.statusDelayMs = statusDelayMs;
    this.caSha256 = caSha256;
    this.detached = detached;
  }

  /** The settings in `text`, or null if it's half-written, damaged or from an unknown protocol. */
  static Control parse(String text) {
    String protocol = null, enabled = null, startup = null, port = null, config = null, seq = null;
    String pid = null, delay = null, ca = null, detached = null;
    boolean ended = false;
    for (String raw : text.split("\n", -1)) {
      String line = raw.endsWith("\r") ? raw.substring(0, raw.length() - 1) : raw;
      if (ended) {
        if (line.isEmpty()) continue;
        return null;
      }
      if (line.isEmpty()) continue;
      int eq = line.indexOf('=');
      if (eq <= 0) return null;
      String key = line.substring(0, eq);
      String value = line.substring(eq + 1);
      if (key.equals("end")) {
        if (!value.equals("1")) return null;
        ended = true;
      } else if (key.equals("protocol")) protocol = value;
      else if (key.equals("enabled")) enabled = value;
      else if (key.equals("startup")) startup = value;
      else if (key.equals("proxyPort")) port = value;
      else if (key.equals("config")) config = value;
      else if (key.equals("seq")) seq = value;
      else if (key.equals("wirescryPid")) pid = value;
      else if (key.equals("statusDelayMs")) delay = value;
      else if (key.equals("caSha256")) ca = value;
      else if (key.equals("detached")) detached = value;
    }
    if (!ended || !String.valueOf(PROTOCOL).equals(protocol)) return null;
    Boolean on = bool(enabled);
    Boolean atStartup = bool(startup);
    long portNumber = number(port);
    long configNumber = number(config);
    long seqNumber = number(seq);
    long pidNumber = pid == null ? 0 : number(pid);
    long delayMs = delay == null ? 5000 : number(delay);
    if (on == null || atStartup == null) return null;
    if (portNumber < 1 || portNumber > 65535) return null;
    if (configNumber < 0 || seqNumber < 0 || pidNumber < 0) return null;
    if (delayMs < 0 || delayMs > 60_000) return null;
    String caHex = ca == null ? "" : ca;
    if (!caHex.isEmpty() && !caHex.matches("[0-9a-f]{64}")) return null;
    Set<String> ids = new HashSet<String>();
    if (detached != null && !detached.isEmpty()) {
      for (String id : detached.split(",", -1)) {
        if (!id.matches(ID)) return null;
        ids.add(id);
      }
    }
    return new Control(
        on,
        atStartup,
        (int) portNumber,
        configNumber,
        seqNumber,
        pidNumber,
        delayMs,
        caHex,
        Collections.unmodifiableSet(ids));
  }

  static boolean validId(String id) {
    return id != null && id.matches(ID);
  }

  private static Boolean bool(String value) {
    if ("true".equals(value)) return Boolean.TRUE;
    if ("false".equals(value)) return Boolean.FALSE;
    return null;
  }

  /** A non-negative decimal number of at most 18 digits, or -1. */
  private static long number(String value) {
    if (value == null || !value.matches("[0-9]{1,18}")) return -1;
    return Long.parseLong(value);
  }

  @Override
  public String toString() {
    return "Control" + Arrays.asList(enabled, startup, proxyPort, config, seq, wirescryPid);
  }
}
