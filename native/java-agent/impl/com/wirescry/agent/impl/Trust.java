/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import com.wirescry.agent.Perms;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.Socket;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509ExtendedTrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Whether Wirescry's CA vouches for a server's chain that the JDK's own check rejected. Called by
 * the code TrustAdvice puts in the JDK's X.509 trust manager, with that call's arguments.
 *
 * <p>It runs the same check, by the same overload with the same socket or engine, on a second JDK
 * trust manager that trusts Wirescry's CA alone. So the host name and algorithm checks still
 * apply: a Wirescry certificate for the wrong host, or any chain Wirescry's CA didn't sign, is
 * still rejected. That second manager is the same JDK class, so its own failures come back here,
 * and are refused at once.
 */
public final class Trust {
  private static volatile Delegate delegate;

  private Trust() {}

  private static final class Delegate {
    final String sha256;
    final X509TrustManager manager;

    Delegate(String sha256, X509TrustManager manager) {
      this.sha256 = sha256;
      this.manager = manager;
    }
  }

  /** True if Wirescry's CA accepts what the JDK rejected; false for anything else, or any doubt. */
  public static boolean accepts(Object self, Object[] args) {
    try {
      Control control = Agent.settings();
      if (control == null || !Agent.isOn() || control.caPath.isEmpty() || control.caSha256.isEmpty()) {
        return false;
      }
      Delegate d = delegate(control);
      if (d == null || self == d.manager) return false;
      X509Certificate[] chain = (X509Certificate[]) args[0];
      String authType = (String) args[1];
      if (args.length == 2) {
        d.manager.checkServerTrusted(chain, authType);
      } else if (args.length == 3 && d.manager instanceof X509ExtendedTrustManager) {
        X509ExtendedTrustManager extended = (X509ExtendedTrustManager) d.manager;
        if (args[2] instanceof SSLEngine) extended.checkServerTrusted(chain, authType, (SSLEngine) args[2]);
        else extended.checkServerTrusted(chain, authType, (Socket) args[2]);
      } else {
        return false;
      }
      return true;
    } catch (Throwable t) {
      return false;
    }
  }

  /** The Wirescry-only trust manager for the control file's CA, made once per CA. */
  private static Delegate delegate(Control control) throws Exception {
    Delegate d = delegate;
    if (d != null && d.sha256.equals(control.caSha256)) return d;
    synchronized (Trust.class) {
      d = delegate;
      if (d != null && d.sha256.equals(control.caSha256)) return d;
      delegate = null;
      File file = new File(control.caPath);
      // The CA decides which servers this program trusts: it must be this user's alone.
      if (!file.isAbsolute() || !Perms.private_(file)) return null;
      X509Certificate ca;
      try (InputStream in = new FileInputStream(file)) {
        ca = (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(in);
      }
      if (!hex(MessageDigest.getInstance("SHA-256").digest(ca.getEncoded())).equals(control.caSha256)) {
        return null;
      }
      KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
      store.load(null, null);
      store.setCertificateEntry("wirescry", ca);
      TrustManagerFactory factory = TrustManagerFactory.getInstance("PKIX", "SunJSSE");
      factory.init(store);
      for (TrustManager manager : factory.getTrustManagers()) {
        // Only the JDK's own class runs the same checks; anything else would be a different test.
        if (manager instanceof X509TrustManager
            && manager.getClass().getName().equals("sun.security.ssl.X509TrustManagerImpl")) {
          d = new Delegate(control.caSha256, (X509TrustManager) manager);
          delegate = d;
          return d;
        }
      }
      return null;
    }
  }

  private static String hex(byte[] bytes) {
    StringBuilder s = new StringBuilder();
    for (byte b : bytes) s.append(Character.forDigit((b >> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
    return s.toString();
  }
}
