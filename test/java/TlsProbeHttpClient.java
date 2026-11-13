/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * Like TlsProbe, with Java 11's HttpClient, which checks certificates through an SSLEngine. The
 * client is built once, before any connection: the JDK says changing the default SSLContext after
 * that has no effect on it, so it shows the agent reaching a client that already exists.
 */
public class TlsProbeHttpClient {
  public static void main(String[] args) throws Exception {
    URI uri = URI.create(args[0]);
    HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    System.out.println("ready");
    System.out.flush();
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
    while (in.readLine() != null) {
      String result;
      try {
        HttpResponse<String> response =
            client.send(HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(5)).build(), HttpResponse.BodyHandlers.ofString());
        result = response.statusCode() == 200 ? "OK" : "FAIL status " + response.statusCode();
      } catch (Exception e) {
        Throwable root = e;
        while (root.getCause() != null && root.getCause() != root) root = root.getCause();
        result = "FAIL " + e.getClass().getName() + ": " + String.valueOf(root.getMessage()).replace('\n', ' ');
      }
      System.out.println(result);
      System.out.flush();
    }
  }
}
