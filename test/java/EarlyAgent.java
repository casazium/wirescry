/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
import java.lang.instrument.Instrumentation;
import java.net.ProxySelector;
import java.net.URI;

/**
 * An agent for test/java-agent-proxy.test.ts, named before Wirescry's: its premain asks the JDK's
 * proxy selector, as a monitoring agent sending its first report might, so the selector is loaded
 * before Wirescry's agent starts.
 */
public class EarlyAgent {
  public static void premain(String args, Instrumentation inst) throws Exception {
    ProxySelector.getDefault().select(new URI("http://early.test/"));
  }
}
