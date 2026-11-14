/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
import java.lang.instrument.Instrumentation;

/**
 * Another agent, as a monitoring tool might be, that retransforms classes when attached:
 * every loaded class named in its arguments (comma-separated). For
 * test/java-agent-apache.test.ts. Its manifest names it as Agent-Class, with
 * Can-Retransform-Classes.
 */
public class Retransformer {
  public static void agentmain(String args, Instrumentation inst) throws Exception {
    java.util.List<String> names = java.util.Arrays.asList(args.split(","));
    for (Class<?> c : inst.getAllLoadedClasses()) {
      if (names.contains(c.getName()) && inst.isModifiableClass(c)) inst.retransformClasses(c);
    }
  }
}
