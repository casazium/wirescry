/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/**
 * The class loader for the agent's weaver and Byte Buddy, whose classes sit under `weaver/` in
 * the agent's jar. Under that prefix the program's class loaders can't find them, so they never
 * meet a Byte Buddy of the program's own (Mockito, Hibernate and others bring one), in either
 * direction. Its parent is the platform loader (the extension loader on Java 8): it sees the JDK
 * and nothing of the program's.
 */
final class WeaverLoader extends ClassLoader {
  private static final String PREFIX = "weaver/";
  private final JarFile jar;

  WeaverLoader(JarFile jar) {
    super(ClassLoader.getSystemClassLoader().getParent());
    this.jar = jar;
  }

  @Override
  protected Class<?> findClass(String name) throws ClassNotFoundException {
    byte[] bytes = read(PREFIX + name.replace('.', '/') + ".class");
    if (bytes == null) throw new ClassNotFoundException(name);
    return defineClass(name, bytes, 0, bytes.length);
  }

  /** Byte Buddy reads class files as resources (for the advice it copies): those come from here. */
  @Override
  public InputStream getResourceAsStream(String name) {
    byte[] bytes = read(PREFIX + name);
    if (bytes != null) return new java.io.ByteArrayInputStream(bytes);
    return super.getResourceAsStream(name);
  }

  private byte[] read(String entryName) {
    JarEntry entry = jar.getJarEntry(entryName);
    if (entry == null) return null;
    try (InputStream in = jar.getInputStream(entry)) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
      return out.toByteArray();
    } catch (IOException e) {
      return null;
    }
  }
}
