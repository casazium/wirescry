//go:build !windows

package main

// Elsewhere the helper uses Unix sockets in place of pipes. Wirescry doesn't use it there; it's
// so the helper and the relay with it can be tested on any computer.

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

func listenLocal(path string) (net.Listener, error) {
	// A socket left by a helper that was killed (tests do that). Only a socket: never a file.
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSocket != 0 {
		if conn, err := net.Dial("unix", path); err == nil {
			conn.Close()
		} else {
			_ = os.Remove(path)
		}
	}
	return net.Listen("unix", path)
}

func dialLocal(ctx context.Context, path string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", path)
}

func validLocal(path string) bool { return filepath.IsAbs(path) }

// peerGone: a Unix socket's half-close and close read alike, and the tests don't need to tell.
func peerGone(net.Conn) bool { return false }

func errorCode(err error) string {
	switch {
	case errors.Is(err, syscall.ENOENT):
		return "ENOENT"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "ECONNREFUSED"
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM):
		return "EACCES"
	case errors.Is(err, context.DeadlineExceeded):
		return "ETIMEDOUT"
	}
	return "EIO"
}
