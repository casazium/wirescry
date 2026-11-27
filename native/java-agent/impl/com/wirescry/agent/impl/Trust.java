/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import com.wirescry.agent.Perms;
import java.io.File;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.Socket;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509ExtendedTrustManager;

/**
 * Whether Wirescry's CA vouches for a server's chain that the JDK's own check rejected. Called by
 * the code the weaver puts in the JDK's X.509 trust manager (com.wirescry.agent.weaver), one entry
 * point per checkServerTrusted overload, with that call's arguments.
 *
 * <p>It runs the same overload, with the same socket or engine, on a second JDK trust manager that
 * trusts Wirescry's CA alone. So the host name and algorithm checks still apply: a Wirescry
 * certificate for the wrong host, or any chain Wirescry's CA didn't sign, is still rejected. That
 * second manager is the same JDK class, so its own failures come back here: a thread already in
 * here is refused at once.
 *
 * <p>Not covered: revocation checks a program turns on (Wirescry's certificates name no CRL or
 * OCSP server, so they fail them), and programs under a SecurityManager (reading the CA is denied;
 * the status file says so).
 */
public final class Trust {
  private static final ThreadLocal<Boolean> CHECKING = new ThreadLocal<Boolean>();
  private static volatile Delegate delegate;
  /** The last CA that couldn't be used, and why, so it isn't read again on every check. */
  private static volatile Failure failure;
  /**
   * How long such a CA is left before it's read again, though nothing about it changed: a virus
   * scanner, say, may hold a new file for a moment, and one failed read mustn't stand for the
   * program's life. A property only tests set can shorten it.
   */
  static final long RETRY_MS = retryMs();
  /** Reads of the CA file, a pause apart, before it counts as unreadable. */
  static final int READ_TRIES = 3;
  static final long READ_PAUSE_MS = 100;
  /** The largest CA file read. */
  static final long MAX_CA_BYTES = 64 * 1024;

  private Trust() {}

  private static final class Delegate {
    final String sha256;
    final String path;
    final X509ExtendedTrustManager manager;

    Delegate(String sha256, String path, X509ExtendedTrustManager manager) {
      this.sha256 = sha256;
      this.path = path;
      this.manager = manager;
    }
  }

  /** A CA that couldn't be used: its settings and file as they were, why, and when. */
  private static final class Failure {
    final String key;
    final String reason;
    final long atNanos;

    Failure(String key, String reason) {
      this.key = key;
      this.reason = reason;
      this.atNanos = System.nanoTime();
    }
  }

  private static long retryMs() {
    try {
      long ms = Long.getLong("wirescry.agent.test.trustRetryMs", 2_000L).longValue();
      return ms >= 50 && ms <= 60_000 ? ms : 2_000L;
    } catch (Throwable t) {
      // A property refused (a SecurityManager): the usual wait.
      return 2_000L;
    }
  }

  public static boolean acceptsPlain(Object self, X509Certificate[] chain, String authType) {
    X509ExtendedTrustManager manager = enter(self);
    if (manager == null) return false;
    try {
      manager.checkServerTrusted(chain, authType);
      return true;
    } catch (Throwable t) {
      if (Trace.ON) Trace.note("trust: Wirescry's CA didn't vouch for the chain: " + t);
      return false;
    } finally {
      CHECKING.remove();
    }
  }

  public static boolean acceptsSocket(Object self, X509Certificate[] chain, String authType, Socket socket) {
    X509ExtendedTrustManager manager = enter(self);
    if (manager == null) return false;
    try {
      manager.checkServerTrusted(chain, authType, socket);
      return true;
    } catch (Throwable t) {
      if (Trace.ON) Trace.note("trust: Wirescry's CA didn't vouch for the chain: " + t);
      return false;
    } finally {
      CHECKING.remove();
    }
  }

  public static boolean acceptsEngine(Object self, X509Certificate[] chain, String authType, SSLEngine engine) {
    X509ExtendedTrustManager manager = enter(self);
    if (manager == null) return false;
    try {
      manager.checkServerTrusted(chain, authType, engine);
      return true;
    } catch (Throwable t) {
      if (Trace.ON) Trace.note("trust: Wirescry's CA didn't vouch for the chain: " + t);
      return false;
    } finally {
      CHECKING.remove();
    }
  }

  /**
   * The Wirescry-only manager to run the check with, marking this thread as checking; or null (and
   * nothing marked) when the agent is off, there's no usable CA, or this is the second manager's
   * own failure coming back.
   */
  private static X509ExtendedTrustManager enter(Object self) {
    try {
      if (CHECKING.get() != null) return null;
      if (!Agent.isOn()) {
        Trace.note("trust: the agent is off");
        return null;
      }
      Control control = Agent.settings();
      Delegate d = delegate(control);
      if (d == null) {
        if (Trace.ON) {
          Failure f = failure;
          Trace.note("trust: no usable CA (" + (f == null ? "no-ca" : f.reason) + ")");
        }
        return null;
      }
      if (self == d.manager) return null;
      CHECKING.set(Boolean.TRUE);
      return d.manager;
    } catch (Throwable t) {
      if (Trace.ON) Trace.note("trust: " + t);
      return null;
    }
  }

  /**
   * For the status file: null if Wirescry's CA is usable, else why not (`no-ca`, `ca-missing`,
   * `ca-unsafe`, `ca-mismatch`, `ca-unreadable`, `jdk-manager`).
   */
  static String problem(Control control) {
    try {
      if (control == null || control.caPath.isEmpty() || control.caSha256.isEmpty()) return "no-ca";
      if (delegate(control) != null) return null;
      Failure f = failure;
      return f == null ? "no-ca" : f.reason;
    } catch (Throwable t) {
      return "ca-unreadable";
    }
  }

  /** The Wirescry-only trust manager for the control file's CA, made once per CA. */
  private static Delegate delegate(Control control) throws Exception {
    if (control == null || control.caPath.isEmpty() || control.caSha256.isEmpty()) return null;
    Delegate d = delegate;
    if (d != null && d.sha256.equals(control.caSha256) && d.path.equals(control.caPath)) return d;
    File file = new File(control.caPath);
    // A failure stands until the settings or the file change, or RETRY_MS passes.
    String key = control.caSha256 + '\n' + control.caPath + '\n' + file.lastModified() + '\n' + file.length();
    Failure f = failure;
    if (f != null && f.key.equals(key) && System.nanoTime() - f.atNanos < RETRY_MS * 1_000_000L) return null;
    synchronized (Trust.class) {
      d = delegate;
      if (d != null && d.sha256.equals(control.caSha256) && d.path.equals(control.caPath)) return d;
      // Another thread may have just tried, while this one waited for the lock.
      f = failure;
      if (f != null && f.key.equals(key) && System.nanoTime() - f.atNanos < RETRY_MS * 1_000_000L) return null;
      delegate = null;
      String why = build(control, file);
      if (why != null) {
        if (Trace.ON) Trace.note("trust: Wirescry's CA can't be used: " + why);
        failure = new Failure(key, why);
        return null;
      }
      failure = null;
      return delegate;
    }
  }

  /** Makes the delegate for `control`'s CA; returns why it couldn't, or null. */
  private static String build(Control control, File file) throws Exception {
    if (!file.isFile()) return "ca-missing";
    // The CA decides which servers this program trusts: it must be this user's alone.
    if (!Perms.private_(file)) return "ca-unsafe";
    // A CA is a few KB; anything much larger isn't one.
    if (file.length() > MAX_CA_BYTES) return "ca-unreadable";
    // Read in a few tries, a moment apart: a virus scanner, say, may hold a new file briefly, and
    // this check is a handshake waiting. Only reading is tried again, not a file that won't parse.
    byte[] bytes = null;
    for (int attempt = 0; bytes == null; attempt++) {
      try {
        bytes = Files.readAllBytes(file.toPath());
      } catch (IOException e) {
        if (attempt >= READ_TRIES - 1) return "ca-unreadable";
        try {
          Thread.sleep(READ_PAUSE_MS);
        } catch (InterruptedException interrupted) {
          // The program wants this thread back: give up now, and keep the interrupt for it.
          Thread.currentThread().interrupt();
          return "ca-unreadable";
        }
      }
    }
    if (bytes.length > MAX_CA_BYTES) return "ca-unreadable";
    X509Certificate ca;
    try (InputStream in = new ByteArrayInputStream(bytes)) {
      ca = (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(in);
    } catch (Exception e) {
      return "ca-unreadable";
    }
    if (!hex(MessageDigest.getInstance("SHA-256").digest(ca.getEncoded())).equals(control.caSha256)) {
      return "ca-mismatch";
    }
    KeyStore store = store();
    store.setCertificateEntry("wirescry", ca);
    TrustManagerFactory factory = TrustManagerFactory.getInstance("PKIX", "SunJSSE");
    factory.init(store);
    for (TrustManager manager : factory.getTrustManagers()) {
      // Only the JDK's own class runs the same checks; anything else would be a different test.
      if (manager.getClass().getName().equals("sun.security.ssl.X509TrustManagerImpl")
          && manager instanceof X509ExtendedTrustManager) {
        delegate = new Delegate(control.caSha256, control.caPath, (X509ExtendedTrustManager) manager);
        return null;
      }
    }
    return "jdk-manager";
  }

  /** An empty key store of a type every JDK has, whatever a program sets as its default. */
  private static KeyStore store() throws Exception {
    KeyStore store;
    try {
      store = KeyStore.getInstance("PKCS12");
      store.load(null, null);
    } catch (Exception e) {
      store = KeyStore.getInstance("JKS");
      store.load(null, null);
    }
    return store;
  }

  private static String hex(byte[] bytes) {
    StringBuilder s = new StringBuilder();
    for (byte b : bytes) s.append(Character.forDigit((b >> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
    return s.toString();
  }
}
