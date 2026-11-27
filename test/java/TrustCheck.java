/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent.impl;

import java.io.File;
import java.io.RandomAccessFile;
import java.nio.channels.FileLock;
import java.nio.file.Files;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermissions;

/**
 * Checks how Trust reads Wirescry's CA again after it couldn't be used: a file held for a moment
 * (by a virus scanner, say) is read again within the same check, and one that couldn't be read
 * isn't refused for the program's life. Run by test/java-agent.test.ts with the agent's classes on
 * the class path, `-Dwirescry.agent.test.trustRetryMs=1000`, and arguments: a CA PEM file (this
 * user's alone), its SHA-256 in hex, and an empty folder to work in. Prints "ok <case>" for each
 * case that passes, "FAIL <case>" for each that doesn't, and "skip <case>" for one this system
 * can't run (a file can't be made unreadable as root).
 */
public final class TrustCheck {
  static int failures;

  static void check(String name, boolean ok) {
    System.out.println((ok ? "ok " : "FAIL ") + name);
    if (!ok) failures++;
  }

  static Control control(File ca, String sha256) {
    return Control.parse(
        "protocol=1\nimpl=jars/wirescry-agent-impl-x.jar\nenabled=true\nstartup=true\nproxyPort=8000\n"
            + "config=1\nseq=1\ncaSha256=" + sha256 + "\ncaPath=" + ca.getAbsolutePath() + "\nend=1\n");
  }

  static boolean posix(File file) {
    return Files.getFileAttributeView(file.toPath(), PosixFileAttributeView.class) != null;
  }

  /** This user's alone, as the agent requires (POSIX only; elsewhere nothing to do). */
  static void restrict(File file) throws Exception {
    if (posix(file)) Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString("rw-------"));
  }

  static File copy(File source, File dir, String name) throws Exception {
    File file = new File(dir, name);
    Files.copy(source.toPath(), file.toPath());
    restrict(file);
    return file;
  }

  /** Makes a file unreadable for now; undone by `release`. Null if this system can't. */
  static Object hold(File file) throws Exception {
    if (posix(file)) {
      Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString("---------"));
      // As root a file without permissions can still be read.
      return Files.isReadable(file.toPath()) ? null : file;
    }
    // Windows: a lock on the whole file keeps every other handle from reading it.
    RandomAccessFile raf = new RandomAccessFile(file, "rw");
    return raf.getChannel().lock();
  }

  static void release(Object held) throws Exception {
    if (held instanceof File) {
      Files.setPosixFilePermissions(((File) held).toPath(), PosixFilePermissions.fromString("rw-------"));
    } else {
      FileLock lock = (FileLock) held;
      lock.release();
      lock.channel().close();
    }
  }

  public static void main(String[] args) throws Exception {
    File source = new File(args[0]);
    String sha256 = args[1];
    File dir = new File(args[2]);
    String wrongSha = sha256.replace(sha256.charAt(0), sha256.charAt(0) == '0' ? '1' : '0');
    check("the retry is the test's", Trust.RETRY_MS == 1000);

    // Missing, then there: a new file is a change, read at once.
    File later = new File(dir, "later.pem");
    check("a missing CA can't be used", "ca-missing".equals(Trust.problem(control(later, sha256))));
    Files.copy(source.toPath(), later.toPath());
    restrict(later);
    check("one that appears is read at once", Trust.problem(control(later, sha256)) == null);

    // The wrong CA: the same answer after the wait too (read again, still wrong).
    Control wrong = control(copy(source, dir, "other.pem"), wrongSha);
    check("a CA that isn't the one named can't be used", "ca-mismatch".equals(Trust.problem(wrong)));
    Thread.sleep(1200);
    check("nor after the wait", "ca-mismatch".equals(Trust.problem(wrong)));

    // Held for a moment during the check: read on a later try of the same check.
    final File brief = copy(source, dir, "brief.pem");
    final Object briefHold = hold(brief);
    if (briefHold == null) {
      System.out.println("skip a file held for a moment (it can't be made unreadable here)");
    } else {
      final long start = System.nanoTime();
      final long[] releasedAfterMs = {-1};
      Thread releaser =
          new Thread() {
            @Override
            public void run() {
              try {
                Thread.sleep(120);
                release(briefHold);
                releasedAfterMs[0] = (System.nanoTime() - start) / 1_000_000L;
              } catch (Exception e) {
                throw new RuntimeException(e);
              }
            }
          };
      releaser.start();
      String result = Trust.problem(control(brief, sha256));
      releaser.join();
      // The check's last try is about 200 ms in: released much later, it couldn't be read.
      if (result != null && releasedAfterMs[0] > 160) {
        System.out.println("skip a file held for a moment (released too late to tell)");
      } else {
        check("a file held for a moment is read in the same check", result == null);
      }
    }

    // Held past the check's tries, with nothing about the file changed: read again after the wait.
    File held = copy(source, dir, "held.pem");
    long modified = held.lastModified();
    long length = held.length();
    Object heldHold = hold(held);
    if (heldHold == null) {
      for (String name : new String[] {"can't be read", "unchanged", "not again at once", "after the wait"}) {
        System.out.println("skip a file held past the check: " + name + " (it can't be made unreadable here)");
      }
    } else {
      Control heldControl = control(held, sha256);
      long failedAt = System.nanoTime();
      check("a CA that can't be read can't be used", "ca-unreadable".equals(Trust.problem(heldControl)));
      release(heldHold);
      check("its time and size unchanged", held.lastModified() == modified && held.length() == length);
      String again = Trust.problem(heldControl);
      if ((System.nanoTime() - failedAt) / 1_000_000L < 800) {
        check("not read again at once", "ca-unreadable".equals(again));
      } else {
        System.out.println("skip not read again at once (the machine was too slow to tell)");
      }
      Thread.sleep(1200);
      check("read again after the wait, and used", Trust.problem(heldControl) == null);
    }
    System.exit(failures == 0 ? 0 : 1);
  }
}
