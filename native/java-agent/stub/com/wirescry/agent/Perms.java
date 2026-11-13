/*
 * Copyright 2026 Bob Casazza (Casazium)
 * SPDX-License-Identifier: Apache-2.0
 */
package com.wirescry.agent;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Set;

/**
 * Whether only this user can change a file or folder. The agent's code and settings come from
 * Wirescry's data folder, so another user able to write there could run code in this program or
 * send its traffic elsewhere.
 *
 * <p>On macOS and Linux: it exists, isn't a symbolic link, is owned by this user, and neither its
 * group nor others can write it. Windows has no POSIX view; there the data folder is under the
 * user's profile, which only that user (and administrators) can write, so existing is enough.
 */
public final class Perms {
  private Perms() {}

  // An underscore: `private` is a keyword.
  public static boolean private_(File file) {
    try {
      if (!file.exists()) return false;
      PosixFileAttributeView view =
          Files.getFileAttributeView(
              file.toPath(), PosixFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
      if (view == null) return true;
      PosixFileAttributes attrs = view.readAttributes();
      if (attrs.isSymbolicLink()) return false;
      String user = System.getProperty("user.name");
      if (user == null || !user.equals(attrs.owner().getName())) return false;
      Set<PosixFilePermission> perms = attrs.permissions();
      return !perms.contains(PosixFilePermission.GROUP_WRITE)
          && !perms.contains(PosixFilePermission.OTHERS_WRITE);
    } catch (Exception e) {
      return false;
    }
  }
}
