/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Wirescry's settings for every agent, from `control.properties` (written by
 * src/backend/java/agent-files.ts). One `key=value` per line, UTF-8, ending with `end=1`: a file
 * without that line is half-written or damaged, and is a bad read, as is a key given twice.
 *
 * <p>Versions: `protocol` is the oldest protocol a reader must speak to use the file. A newer
 * Wirescry that only adds keys keeps writing the old number, and agents already running in JVMs
 * (which keep the agent they loaded) ignore keys they don't know. Only a change older agents
 * would misread raises it, and those agents then turn off rather than guess.
 *
 * <p>No regular expressions: this runs before the program's main.
 */
final class Control {
  /** The protocol this agent speaks. */
  static final int PROTOCOL = 1;

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

  private Control(Map<String, String> f, Set<String> detached) {
    this.enabled = "true".equals(f.get("enabled"));
    this.startup = "true".equals(f.get("startup"));
    this.proxyPort = (int) number(f.get("proxyPort"));
    this.config = number(f.get("config"));
    this.seq = number(f.get("seq"));
    this.wirescryPid = f.containsKey("wirescryPid") ? number(f.get("wirescryPid")) : 0;
    this.statusDelayMs = f.containsKey("statusDelayMs") ? number(f.get("statusDelayMs")) : 5000;
    this.caSha256 = f.containsKey("caSha256") ? f.get("caSha256") : "";
    this.detached = detached;
  }

  /** The settings in `text`, or null if it's half-written, damaged or needs a newer protocol. */
  static Control parse(String text) {
    Map<String, String> f = new HashMap<String, String>();
    boolean ended = false;
    for (String raw : split(text, '\n')) {
      String line = raw.endsWith("\r") ? raw.substring(0, raw.length() - 1) : raw;
      if (line.isEmpty()) continue;
      if (ended) return null;
      int eq = line.indexOf('=');
      if (eq <= 0) return null;
      String key = line.substring(0, eq);
      String value = line.substring(eq + 1);
      if (key.equals("end")) {
        if (!value.equals("1")) return null;
        ended = true;
      } else if (f.put(key, value) != null) {
        return null;
      }
    }
    if (!ended) return null;
    long protocol = number(f.get("protocol"));
    if (protocol < 1 || protocol > PROTOCOL) return null;
    if (!bool(f.get("enabled")) || !bool(f.get("startup"))) return null;
    long port = number(f.get("proxyPort"));
    if (port < 1 || port > 65535) return null;
    if (number(f.get("config")) < 0 || number(f.get("seq")) < 0) return null;
    if (f.containsKey("wirescryPid") && number(f.get("wirescryPid")) < 0) return null;
    if (f.containsKey("statusDelayMs")) {
      long delay = number(f.get("statusDelayMs"));
      if (delay < 0 || delay > 60_000) return null;
    }
    if (f.containsKey("caSha256") && !hex64(f.get("caSha256"))) return null;
    Set<String> ids = new HashSet<String>();
    String detached = f.get("detached");
    if (detached != null && !detached.isEmpty()) {
      for (String id : split(detached, ',')) {
        if (!validId(id)) return null;
        ids.add(id);
      }
    }
    return new Control(f, Collections.unmodifiableSet(ids));
  }

  /** An agent id: 1 to 64 of A-Z, a-z, 0-9, `_` and `-`. It names the status file. */
  static boolean validId(String id) {
    if (id == null || id.isEmpty() || id.length() > 64) return false;
    for (int i = 0; i < id.length(); i++) {
      char c = id.charAt(i);
      boolean ok =
          (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
      if (!ok) return false;
    }
    return true;
  }

  /** `text` split at each `sep`, keeping empty parts (String.split may compile a regex). */
  static List<String> split(String text, char sep) {
    List<String> parts = new ArrayList<String>();
    int start = 0;
    for (int i = 0; i <= text.length(); i++) {
      if (i == text.length() || text.charAt(i) == sep) {
        parts.add(text.substring(start, i));
        start = i + 1;
      }
    }
    return parts;
  }

  private static boolean bool(String value) {
    return "true".equals(value) || "false".equals(value);
  }

  private static boolean hex64(String value) {
    if (value == null || value.length() != 64) return false;
    for (int i = 0; i < 64; i++) {
      char c = value.charAt(i);
      if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    return true;
  }

  /** A non-negative decimal number of 1 to 18 digits, or -1. */
  static long number(String value) {
    if (value == null || value.isEmpty() || value.length() > 18) return -1;
    long n = 0;
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (c < '0' || c > '9') return -1;
      n = n * 10 + (c - '0');
    }
    return n;
  }
}
