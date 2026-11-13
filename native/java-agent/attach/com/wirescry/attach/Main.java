/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.attach;

import com.sun.tools.attach.AgentInitializationException;
import com.sun.tools.attach.AgentLoadException;
import com.sun.tools.attach.AttachNotSupportedException;
import com.sun.tools.attach.VirtualMachine;
import com.sun.tools.attach.VirtualMachineDescriptor;
import java.io.File;
import java.util.Properties;

/**
 * Wirescry's attacher: lists running JVMs and loads Wirescry's agent into one. Run by Wirescry
 * with a JDK 11 or later (it needs the jdk.attach module); the target can be Java 8 or later.
 *
 * <pre>
 *   list                       one JSON line per JVM: {"pid":"…","name":"…"}
 *   load PID STUB_JAR ARGS     one JSON line: {"ok":true,…} or {"ok":false,"reason":"…",…}
 * </pre>
 *
 * Names are the main class or the jar's file name only. A JVM's display name also holds its
 * command-line arguments, which often hold passwords and tokens, so those never leave here.
 */
public final class Main {
  private Main() {}

  public static void main(String[] args) {
    int code;
    try {
      if (args.length == 1 && args[0].equals("list")) code = list();
      else if (args.length == 4 && args[0].equals("load")) code = load(args[1], args[2], args[3]);
      else {
        System.out.println(failure("usage", "list | load PID STUB_JAR ARGS"));
        code = 2;
      }
    } catch (Throwable t) {
      System.out.println(failure("failed", t.toString()));
      code = 1;
    }
    System.out.flush();
    System.exit(code);
  }

  private static int list() {
    String self = String.valueOf(ProcessHandle.current().pid());
    for (VirtualMachineDescriptor vm : VirtualMachine.list()) {
      if (vm.id().equals(self) || !vm.id().matches("[0-9]{1,18}")) continue;
      System.out.println("{\"pid\":" + json(vm.id()) + ",\"name\":" + json(shortName(vm.displayName())) + "}");
    }
    return 0;
  }

  /**
   * The main class, or the jar's file name, from a display name ("main.Class arg…" or
   * "/path/app.jar arg…"). A jar path with a space in it loses everything after the space's
   * folder: the display name joins arguments with spaces, so there's no telling them apart.
   */
  static String shortName(String displayName) {
    String first = displayName == null ? "" : displayName.trim().split("\\s+", 2)[0];
    int slash = Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\'));
    if (first.endsWith(".jar") && slash >= 0) first = first.substring(slash + 1);
    return first.length() > 200 ? first.substring(0, 200) : first;
  }

  private static int load(String pid, String jar, String agentArgs) {
    if (!pid.matches("[0-9]{1,18}")) {
      System.out.println(failure("bad-pid", pid));
      return 2;
    }
    if (!new File(jar).isAbsolute()) {
      System.out.println(failure("bad-jar", "The agent's path must be absolute."));
      return 2;
    }
    VirtualMachine vm;
    try {
      vm = VirtualMachine.attach(pid);
    } catch (AttachNotSupportedException e) {
      System.out.println(failure("attach-not-supported", e.getMessage()));
      return 1;
    } catch (Exception e) {
      System.out.println(failure("attach-failed", e.toString()));
      return 1;
    }
    try {
      Properties props = vm.getSystemProperties();
      String javaVersion = props.getProperty("java.version", "");
      String javaHome = props.getProperty("java.home", "");
      vm.loadAgent(jar, agentArgs);
      System.out.println(
          "{\"ok\":true,\"java\":" + json(javaVersion) + ",\"javaHome\":" + json(javaHome) + "}");
      return 0;
    } catch (AgentLoadException e) {
      String message = String.valueOf(e.getMessage());
      String reason = message.contains("EnableDynamicAgentLoading") ? "dynamic-loading-disabled" : "agent-load-failed";
      System.out.println(failure(reason, message));
      return 1;
    } catch (AgentInitializationException e) {
      System.out.println(failure("agent-init-failed", e.getMessage()));
      return 1;
    } catch (Exception e) {
      System.out.println(failure("load-failed", e.toString()));
      return 1;
    } finally {
      try {
        vm.detach();
      } catch (Exception ignored) {
        // The program may have exited.
      }
    }
  }

  private static String failure(String reason, String message) {
    return "{\"ok\":false,\"reason\":" + json(reason) + ",\"message\":" + json(String.valueOf(message)) + "}";
  }

  /** A JSON string: every character outside printable ASCII is escaped, so a line stays one line. */
  static String json(String value) {
    StringBuilder s = new StringBuilder("\"");
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (c == '"' || c == '\\') s.append('\\').append(c);
      else if (c < 0x20 || c > 0x7e) s.append(String.format("\\u%04x", (int) c));
      else s.append(c);
    }
    return s.append('"').toString();
  }
}
