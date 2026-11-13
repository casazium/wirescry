/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
import java.io.BufferedReader;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.net.URL;
import java.security.KeyStore;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import javax.net.ssl.HttpsURLConnection;
import java.util.Collections;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSessionContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * A TLS client for test/java-agent.test.ts, Java 8+. Builds its client first, prints "ready",
 * then connects once for each line on stdin, printing "OK" or "FAIL <exception>". So a test can
 * attach the agent between connections, to a client built before it. Each connection is new and
 * makes a full handshake: no keep-alive, and no TLS session resumed (which skips the certificate
 * check the test is about).
 *
 * <pre>
 *   TlsProbe url URL            HttpsURLConnection (the JDK's default socket factory)
 *   TlsProbe socket URL         an SSLSocket with HTTPS host name checks
 *   TlsProbe store URL CA.pem   a context trusting only CA.pem, by the JDK's own trust manager
 *   TlsProbe own URL            a hand-written trust manager that trusts nothing
 * </pre>
 */
public class TlsProbe {
  static SSLContext context;

  public static void main(String[] args) throws Exception {
    System.setProperty("http.keepAlive", "false");
    String mode = args[0];
    URL url = new URL(args[1]);
    SSLSocketFactory factory = factory(mode, args.length > 2 ? args[2] : null);
    System.out.println("ready");
    System.out.flush();
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
    while (in.readLine() != null) {
      String result;
      try {
        forgetSessions(context);
        connect(mode, url, factory);
        result = "OK";
      } catch (Exception e) {
        result = "FAIL " + e.getClass().getName();
      }
      System.out.println(result);
      System.out.flush();
    }
  }

  static SSLSocketFactory factory(String mode, String caFile) throws Exception {
    if (mode.equals("url") || mode.equals("socket")) {
      context = SSLContext.getDefault();
      return mode.equals("url") ? HttpsURLConnection.getDefaultSSLSocketFactory() : context.getSocketFactory();
    }
    context = SSLContext.getInstance("TLS");
    if (mode.equals("store")) {
      KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
      store.load(null, null);
      try (FileInputStream ca = new FileInputStream(caFile)) {
        store.setCertificateEntry("ca", CertificateFactory.getInstance("X.509").generateCertificate(ca));
      }
      TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
      tmf.init(store);
      context.init(null, tmf.getTrustManagers(), null);
    } else {
      context.init(
          null,
          new TrustManager[] {
            new X509TrustManager() {
              public void checkClientTrusted(X509Certificate[] chain, String type) throws CertificateException {
                throw new CertificateException("trusts nothing");
              }

              public void checkServerTrusted(X509Certificate[] chain, String type) throws CertificateException {
                throw new CertificateException("trusts nothing");
              }

              public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
              }
            }
          },
          null);
    }
    return context.getSocketFactory();
  }

  static void forgetSessions(SSLContext context) {
    SSLSessionContext sessions = context.getClientSessionContext();
    for (byte[] id : Collections.list(sessions.getIds())) {
      if (sessions.getSession(id) != null) sessions.getSession(id).invalidate();
    }
  }

  static void connect(String mode, URL url, SSLSocketFactory factory) throws Exception {
    if (mode.equals("url")) {
      HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
      connection.setSSLSocketFactory(factory);
      connection.setConnectTimeout(5000);
      connection.setReadTimeout(5000);
      if (connection.getResponseCode() != 200) throw new Exception("status " + connection.getResponseCode());
      connection.getInputStream().close();
      connection.disconnect();
      return;
    }
    try (SSLSocket socket = (SSLSocket) factory.createSocket(url.getHost(), url.getPort())) {
      SSLParameters params = socket.getSSLParameters();
      params.setEndpointIdentificationAlgorithm("HTTPS");
      socket.setSSLParameters(params);
      socket.setSoTimeout(5000);
      socket.startHandshake();
    }
  }
}
