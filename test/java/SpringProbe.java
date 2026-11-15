/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import org.apache.hc.client5.http.impl.classic.HttpClients;
import org.springframework.http.client.HttpComponentsClientHttpRequestFactory;
import org.springframework.web.client.RestTemplate;

/**
 * Spring's RestTemplate on Apache HttpClient 5.x, for test/java-agent-apache.test.ts: run on a
 * plain class path, and as the application in a Spring Boot fat jar (BOOT-INF/lib, launched by
 * Spring Boot's JarLauncher). Java 17+. Prints "ready", then one line per command on stdin:
 * "OK <body>" or "FAIL <exception>".
 *
 * <pre>
 *   rest URL      GET with a RestTemplate on HttpComponentsClientHttpRequestFactory as Spring
 *                 makes it (HttpClients.createSystem(): the JDK's proxy selector)
 *   default URL   the same on HttpClients.createDefault() (DefaultRoutePlanner)
 *   loader        the class loader HttpClient's classes came from
 *   set NAME [VALUE]  sets a system property
 * </pre>
 */
public class SpringProbe {
  public static void main(String[] args) throws Exception {
    System.out.println("ready");
    System.out.flush();
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    String line;
    while ((line = in.readLine()) != null) {
      String[] p = line.trim().split(" ");
      String out;
      try {
        out = run(p);
      } catch (Throwable t) {
        Throwable cause = t;
        while (cause.getCause() != null) cause = cause.getCause();
        out = "FAIL " + cause.getClass().getName() + ": " + cause.getMessage();
      }
      System.out.println(out.replace('\n', ' ').replace('\r', ' '));
      System.out.flush();
    }
  }

  static String run(String[] p) throws Exception {
    switch (p[0]) {
      case "rest":
        return "OK " + new RestTemplate(new HttpComponentsClientHttpRequestFactory()).getForObject(p[1], String.class);
      case "default":
        return "OK "
            + new RestTemplate(new HttpComponentsClientHttpRequestFactory(HttpClients.createDefault()))
                .getForObject(p[1], String.class);
      case "loader":
        return HttpClients.class.getClassLoader().getClass().getName();
      case "set":
        System.setProperty(p[1], p.length > 2 ? p[2] : "");
        return "set";
      default:
        return "FAIL unknown command";
    }
  }
}
