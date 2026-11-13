/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import com.wirescry.agent.Perms;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermissions;

/**
 * This JVM's status file, `status/<pid>-<id>.properties` next to the control file, for Wirescry
 * (read by src/backend/java/agent-files.ts). The same format as the control file: `key=value`
 * lines ending with `end=1`. Written to a temporary file and renamed, so Wirescry never reads half
 * of one.
 *
 * <p>Written only when the status folder is this user's alone (a program run with `sudo -E` must
 * not leave root's files in the user's folder), when something changed, and every few reads so
 * Wirescry can tell a live JVM from a dead one by `beat`.
 */
final class Status {
  /** Renames retried on Windows, where a reader holding the file blocks replacing it. */
  private static final int RENAME_TRIES = 5;

  private final Agent agent;
  private long pid;
  private String lastText;
  private long beat;

  Status(Agent agent) {
    this.agent = agent;
    this.pid = Liveness.Real.self();
  }

  void write(boolean on, String reason, Control control, boolean beatDue) {
    if (pid < 0) return;
    String text = text(on, reason, control);
    if (text.equals(lastText) && !beatDue) return;
    File folder = new File(agent.dir, "status");
    if (!Perms.private_(folder)) return;
    beat++;
    String full = text + "beat=" + beat + "\nend=1\n";
    File file = new File(folder, pid + "-" + agent.id + ".properties");
    File temp = new File(folder, pid + "-" + agent.id + ".tmp");
    try {
      Files.write(temp.toPath(), full.getBytes(StandardCharsets.UTF_8));
      if (Files.getFileAttributeView(temp.toPath(), PosixFileAttributeView.class) != null) {
        Files.setPosixFilePermissions(temp.toPath(), PosixFilePermissions.fromString("rw-------"));
      }
      for (int i = 0; ; i++) {
        try {
          Files.move(
              temp.toPath(),
              file.toPath(),
              StandardCopyOption.REPLACE_EXISTING,
              StandardCopyOption.ATOMIC_MOVE);
          break;
        } catch (Exception e) {
          if (i + 1 >= RENAME_TRIES) throw e;
          Thread.sleep(50L << i);
        }
      }
      lastText = text;
    } catch (Exception e) {
      temp.delete();
    }
  }

  private String text(boolean on, String reason, Control control) {
    StringBuilder s = new StringBuilder();
    s.append("protocol=").append(Control.PROTOCOL).append('\n');
    s.append("agentVersion=").append(Version.AGENT).append('\n');
    s.append("route=").append(agent.route).append('\n');
    s.append("id=").append(agent.id).append('\n');
    s.append("pid=").append(pid).append('\n');
    s.append("java=").append(clean(System.getProperty("java.version"))).append('\n');
    s.append("enabled=").append(on).append('\n');
    s.append("reason=").append(reason).append('\n');
    s.append("appliedConfig=").append(control == null ? -1 : control.config).append('\n');
    if (control != null) {
      s.append("port=").append(control.proxyPort).append('\n');
      if (!control.caSha256.isEmpty()) s.append("caSha256=").append(control.caSha256).append('\n');
    }
    // Filled in by the hooks that later pull requests add.
    s.append("hooks=").append('\n');
    return s.toString();
  }

  /** A value kept to one line of printable ASCII, at most 64 characters. */
  static String clean(String value) {
    if (value == null) return "";
    StringBuilder s = new StringBuilder();
    for (int i = 0; i < value.length() && s.length() < 64; i++) {
      char c = value.charAt(i);
      if (c > ' ' && c < 127 && c != '=') s.append(c);
    }
    return s.toString();
  }
}
