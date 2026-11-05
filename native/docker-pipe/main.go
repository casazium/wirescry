// Command wirescry-docker-pipe carries Docker API connections between Docker clients, Wirescry's
// Docker relay and Docker, for Wirescry on Windows.
//
// Docker on Windows talks over message-mode named pipes, and ends one direction of a stream
// (stdin's end, or the end of a container's output) with a zero-length message. Node, which runs
// the relay, can neither see nor send one, and can only serve byte-mode pipes, so through a relay
// in Node `docker run` never finished. This helper does the pipe ends with go-winio, the library
// the Docker CLI and daemon use, and talks plain TCP on 127.0.0.1 to the relay, where Node handles
// half-closed connections:
//
//	Docker client ─pipe─▶ helper (front) ─TCP─▶ relay
//	relay ─TCP─▶ helper (back) ─pipe─▶ Docker
//
// The end of each direction is passed on as the end of the same direction on the other side.
//
// Wirescry starts it and writes one line of JSON to its stdin:
//
//	{"listen": "\\\\.\\pipe\\wirescry-docker-…", "relay": "127.0.0.1:<port>", "token": "<64 hex digits>"}
//
// It answers with one line on stdout, {"back": "127.0.0.1:<port>"} or {"error": "…"}, and runs
// until its stdin closes (when Wirescry stops or dies). Each front connection it opens to the relay
// starts with the token. Each connection to the back port must start with the token and then the
// path of Docker's pipe and a newline; anything else is closed.
package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	tokenSize = 32
	// How long to wait for Docker's pipe when all its instances are busy, as the Docker CLI does.
	dialTimeout = 32 * time.Second
)

// How long a connection to the back port has to send the token and pipe path. A variable for tests.
var preambleTimeout = 5 * time.Second

type config struct {
	Listen string `json:"listen"`
	Relay  string `json:"relay"`
	Token  string `json:"token"`
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("docker-pipe: ")
	in := bufio.NewReader(os.Stdin)
	line, err := in.ReadBytes('\n')
	if err != nil && len(line) == 0 {
		fail(fmt.Errorf("no settings on stdin: %w", err))
	}
	var cfg config
	if err := json.Unmarshal(line, &cfg); err != nil {
		fail(fmt.Errorf("unreadable settings: %w", err))
	}
	h, err := start(cfg)
	if err != nil {
		fail(err)
	}
	answer(map[string]string{"back": h.BackAddr()})
	// Wirescry keeps stdin open while it runs. It closes when Wirescry stops, and when it
	// dies Windows closes it: either way, stop too.
	_, _ = io.Copy(io.Discard, in)
	h.Close()
}

func answer(v any) {
	out, _ := json.Marshal(v)
	fmt.Fprintf(os.Stdout, "%s\n", out)
}

func fail(err error) {
	answer(map[string]string{"error": err.Error()})
	os.Exit(1)
}

// Helper serves the front pipe and the back port.
type Helper struct {
	token  []byte
	relay  string
	front  net.Listener
	back   net.Listener
	mu     sync.Mutex
	closed bool
	conns  map[net.Conn]struct{}
	wg     sync.WaitGroup
}

func start(cfg config) (*Helper, error) {
	token, err := hex.DecodeString(cfg.Token)
	if err != nil || len(token) != tokenSize {
		return nil, errors.New("the token must be 64 hex digits")
	}
	host, _, err := net.SplitHostPort(cfg.Relay)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return nil, fmt.Errorf("the relay must be on 127.0.0.1, not %q", cfg.Relay)
	}
	back, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("couldn't listen on 127.0.0.1: %w", err)
	}
	front, err := listenLocal(cfg.Listen)
	if err != nil {
		back.Close()
		return nil, fmt.Errorf("couldn't create %s: %w", cfg.Listen, err)
	}
	h := &Helper{token: token, relay: cfg.Relay, front: front, back: back, conns: map[net.Conn]struct{}{}}
	h.wg.Add(2)
	go h.serve(front, h.handleFront)
	go h.serve(back, h.handleBack)
	return h, nil
}

// BackAddr is where the relay connects to reach Docker.
func (h *Helper) BackAddr() string { return h.back.Addr().String() }

// Close stops listening and closes every connection.
func (h *Helper) Close() {
	h.mu.Lock()
	h.closed = true
	conns := h.conns
	h.conns = map[net.Conn]struct{}{}
	h.mu.Unlock()
	h.front.Close()
	h.back.Close()
	for c := range conns {
		c.Close()
	}
	h.wg.Wait()
}

func (h *Helper) isClosed() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.closed
}

// track remembers c until it's forgotten, so Close can close it. False once closed.
func (h *Helper) track(c net.Conn) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return false
	}
	h.conns[c] = struct{}{}
	return true
}

func (h *Helper) forget(c net.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.conns, c)
}

func (h *Helper) serve(l net.Listener, handle func(net.Conn)) {
	defer h.wg.Done()
	failures := 0
	for {
		c, err := l.Accept()
		if err != nil {
			if h.isClosed() {
				return
			}
			// Rare; don't flood the log if it keeps happening.
			if failures++; failures <= 5 || failures%100 == 0 {
				log.Printf("accept: %v", err)
			}
			time.Sleep(min(time.Duration(failures)*50*time.Millisecond, 2*time.Second))
			continue
		}
		failures = 0
		if !h.track(c) {
			c.Close()
			return
		}
		go func() {
			defer h.forget(c)
			handle(c)
		}()
	}
}

// handleFront passes a Docker client's connection on to the relay.
func (h *Helper) handleFront(client net.Conn) {
	relay, err := net.DialTimeout("tcp", h.relay, 10*time.Second)
	if err != nil {
		log.Printf("couldn't reach Wirescry's relay: %v", err)
		client.Close()
		return
	}
	if !h.track(relay) {
		relay.Close()
		client.Close()
		return
	}
	defer h.forget(relay)
	if _, err := relay.Write(h.token); err != nil {
		relay.Close()
		client.Close()
		return
	}
	bridge(client, client, relay, relay)
}

// handleBack passes a connection from the relay on to Docker's pipe.
func (h *Helper) handleBack(relay net.Conn) {
	_ = relay.SetReadDeadline(time.Now().Add(preambleTimeout))
	r := bufio.NewReaderSize(relay, 4096)
	path, err := readPreamble(r, h.token)
	if err != nil {
		// Not the relay: say nothing.
		relay.Close()
		return
	}
	_ = relay.SetReadDeadline(time.Time{})
	if !validLocal(path) {
		refuse(relay, "EINVAL", fmt.Sprintf("%s isn't a pipe on this computer", path))
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout)
	docker, err := dialLocal(ctx, path)
	cancel()
	if err != nil {
		refuse(relay, errorCode(err), err.Error())
		return
	}
	if !h.track(docker) {
		docker.Close()
		relay.Close()
		return
	}
	defer h.forget(docker)
	bridge(relay, r, docker, docker)
}

// readPreamble reads the token and the pipe path line from a back connection.
func readPreamble(r *bufio.Reader, token []byte) (string, error) {
	got := make([]byte, len(token))
	if _, err := io.ReadFull(r, got); err != nil {
		return "", err
	}
	if subtle.ConstantTimeCompare(got, token) != 1 {
		return "", errors.New("wrong token")
	}
	line, err := r.ReadSlice('\n')
	if err != nil {
		return "", err
	}
	path := strings.TrimRight(string(line), "\r\n")
	if path == "" {
		return "", errors.New("no pipe path")
	}
	return path, nil
}

// refuse answers a back connection that couldn't be passed on, the way Docker answers errors,
// with Node's name for the error in X-Wirescry-Dial-Error and the error itself as the message,
// which the relay puts into words.
func refuse(c net.Conn, code, message string) {
	body, _ := json.Marshal(map[string]string{"message": message})
	fmt.Fprintf(c, "HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: %d\r\nX-Wirescry-Dial-Error: %s\r\nConnection: close\r\n\r\n%s", len(body), code, body)
	if hc, ok := c.(halfCloser); ok {
		_ = hc.CloseWrite()
	}
	// Let the request finish arriving, so closing doesn't reset the connection before the
	// relay has read the answer.
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _ = io.Copy(io.Discard, c)
	c.Close()
}

type halfCloser interface {
	CloseWrite() error
}

// bridge copies a→b and b→a until both directions have ended. When one direction ends, the
// other side is told by a half-close (a zero-length message on a message-mode pipe, a FIN on
// TCP), and the other direction goes on. When both have ended both are closed: Docker never
// closes its end after a stream, only half-closes it, so closing here is what frees it.
//
// When a side goes away altogether instead (a pipe whose other end closed, a TCP reset, an
// error), both are closed at once, and TCP with a reset, so the relay (Node) knows it's not a
// half-close. go-winio reads a pipe's half-close and its closing alike, as the end; peerGone
// tells them apart.
//
// ar and br are what to read a and b through (a buffered reader holding bytes already read).
func bridge(a net.Conn, ar io.Reader, b net.Conn, br io.Reader) {
	var once sync.Once
	finish := func(abort bool) {
		once.Do(func() {
			for _, c := range []net.Conn{a, b} {
				if tcp, ok := c.(*net.TCPConn); ok && abort {
					_ = tcp.SetLinger(0) // Close then sends a reset.
				}
				c.Close()
			}
		})
	}
	done := make(chan struct{}, 2)
	pass := func(dst net.Conn, src io.Reader, from net.Conn) {
		defer func() { done <- struct{}{} }()
		// A zero-length write on a message-mode pipe means the end, but go-winio ignores them
		// (and io.Copy through a bufio.Reader can make one), so only CloseWrite sends it.
		if _, err := io.Copy(dst, src); err != nil || peerGone(from) {
			finish(true)
			return
		}
		if hc, ok := dst.(halfCloser); ok {
			if err := hc.CloseWrite(); err != nil {
				finish(true)
			}
		}
		// A byte-mode pipe can't be half-closed: like the Docker CLI on one, carry on.
	}
	go pass(b, ar, a)
	go pass(a, br, b)
	<-done
	<-done
	finish(false)
}
