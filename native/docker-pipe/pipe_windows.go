//go:build windows

package main

import (
	"context"
	"errors"
	"net"
	"regexp"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// listenLocal serves a message-mode pipe like Docker's own, so clients can half-close.
// go-winio creates the first instance with FILE_CREATE (so it fails if anyone else already
// has the name) and sets PIPE_REJECT_REMOTE_CLIENTS (so it can't be reached over the network).
func listenLocal(path string) (net.Listener, error) {
	sd, err := ownerOnly()
	if err != nil {
		return nil, err
	}
	return winio.ListenPipe(path, &winio.PipeConfig{
		SecurityDescriptor: sd,
		MessageMode:        true,
		InputBufferSize:    65536,
		OutputBufferSize:   65536,
	})
}

// ownerOnly lets only this user and SYSTEM open the pipe: anyone else could otherwise use
// Docker through it as this user.
func ownerOnly() (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return "D:P(A;;GA;;;SY)(A;;GA;;;" + user.User.Sid.String() + ")", nil
}

// dialLocal connects to Docker's pipe as the Docker CLI does. go-winio waits while all its
// instances are busy, and returns a connection that can half-close when the pipe is
// message-mode.
func dialLocal(ctx context.Context, path string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, path)
}

// Only pipes on this computer: \\server\pipe\name would sign in to that server as this user.
var localPipe = regexp.MustCompile(`(?i)^\\\\\.\\pipe\\[^\\/]+$`)

func validLocal(path string) bool { return localPipe.MatchString(path) }

// errorCode names a dial error the way Node would, for the relay's messages.
func errorCode(err error) string {
	switch {
	case errors.Is(err, windows.ERROR_FILE_NOT_FOUND), errors.Is(err, windows.ERROR_PATH_NOT_FOUND):
		return "ENOENT"
	case errors.Is(err, windows.ERROR_ACCESS_DENIED):
		return "EACCES"
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, winio.ErrTimeout), errors.Is(err, windows.ERROR_PIPE_BUSY):
		return "ETIMEDOUT"
	}
	return "EIO"
}
