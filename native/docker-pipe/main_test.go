package main

// The helper between a client and a fake Docker that ends streams as Docker does: with a
// half-close (on Windows, a zero-length message on a message-mode pipe), never a full close.
// A stand-in for Wirescry's relay sits between the helper's two sides, as the relay does:
//
//	client ─pipe─▶ helper front ─TCP─▶ fake relay ─TCP─▶ helper back ─pipe─▶ fake Docker
//
// On Windows these are real named pipes through go-winio; elsewhere Unix sockets.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	// The lifecycle test runs this binary as the helper itself.
	if os.Getenv("WIRESCRY_DOCKER_PIPE_RUN_MAIN") == "1" {
		main()
		return
	}
	os.Exit(m.Run())
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// localPath is a fresh pipe name (Windows) or socket path.
func localPath(t *testing.T, name string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		return `\\.\pipe\wirescry-test-` + name + "-" + randomHex(6)
	}
	// Short: Unix socket paths are limited to about 100 bytes.
	dir, err := os.MkdirTemp("", "dp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, name)
}

// daemonBehaviour is how the fake Docker answers one connection after reading the request head.
type daemonBehaviour func(t *testing.T, c net.Conn, r *bufio.Reader, head string)

type fakeDocker struct {
	path string
	// closed gets an entry each time the helper closes a connection to the fake Docker.
	closed chan struct{}
}

// startDocker serves the fake Docker on a pipe (message-mode on Windows, like Docker's).
func startDocker(t *testing.T, behave daemonBehaviour) *fakeDocker {
	t.Helper()
	d := &fakeDocker{path: localPath(t, "docker"), closed: make(chan struct{}, 16)}
	l, err := listenLocal(d.path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				r := bufio.NewReader(c)
				head, err := readHead(r)
				if err != nil {
					c.Close()
					return
				}
				behave(t, c, r, head)
				// Docker never closes the connection itself: it waits for the other end.
				_, _ = io.Copy(io.Discard, r)
				// Reads end once the helper has closed its end.
				c.Close()
				d.closed <- struct{}{}
			}()
		}
	}()
	return d
}

func readHead(r *bufio.Reader) (string, error) {
	var head strings.Builder
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return "", err
		}
		head.WriteString(line)
		if line == "\r\n" {
			return head.String(), nil
		}
	}
}

func closeWrite(t *testing.T, c net.Conn) {
	t.Helper()
	hc, ok := c.(halfCloser)
	if !ok {
		t.Fatalf("%T can't half-close", c)
	}
	if err := hc.CloseWrite(); err != nil {
		t.Fatal(err)
	}
}

// fakeRelay stands in for Wirescry's relay: it checks the token on connections from the
// helper's front, and passes each on through the helper's back to Docker, with half-closes.
type fakeRelay struct {
	l        net.Listener
	token    []byte
	back     string
	docker   string
	rejected chan struct{}
}

func startRelay(t *testing.T, token []byte, docker string) *fakeRelay {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	r := &fakeRelay{l: l, token: token, docker: docker, rejected: make(chan struct{}, 4)}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go r.handle(c)
		}
	}()
	return r
}

func (r *fakeRelay) handle(c net.Conn) {
	got := make([]byte, tokenSize)
	if _, err := io.ReadFull(c, got); err != nil || !bytes.Equal(got, r.token) {
		r.rejected <- struct{}{}
		c.Close()
		return
	}
	back, err := net.Dial("tcp", r.back)
	if err != nil {
		c.Close()
		return
	}
	fmt.Fprintf(back, "%s%s\n", r.token, r.docker)
	bridge(c, c, back, back)
}

type setup struct {
	helper *Helper
	relay  *fakeRelay
	docker *fakeDocker
	front  string
	token  []byte
}

func startAll(t *testing.T, behave daemonBehaviour) *setup {
	t.Helper()
	tokenHex := randomHex(tokenSize)
	token, _ := hex.DecodeString(tokenHex)
	docker := startDocker(t, behave)
	relay := startRelay(t, token, docker.path)
	front := localPath(t, "front")
	h, err := start(config{Listen: front, Relay: relay.l.Addr().String(), Token: tokenHex})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	relay.back = h.BackAddr()
	return &setup{helper: h, relay: relay, docker: docker, front: front, token: token}
}

func (s *setup) dial(t *testing.T) net.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := dialLocal(ctx, s.front)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

// readAll reads until the end, failing the test if it doesn't come in time.
func readAll(t *testing.T, c net.Conn, timeout time.Duration) []byte {
	t.Helper()
	type result struct {
		data []byte
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		data, err := io.ReadAll(c)
		ch <- result{data, err}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatalf("read: %v (got %q)", r.err, r.data)
		}
		return r.data
	case <-time.After(timeout):
		t.Fatal("the end of the stream never arrived")
		return nil
	}
}

func (s *setup) waitDockerClosed(t *testing.T) {
	t.Helper()
	select {
	case <-s.docker.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the helper never closed its connection to Docker")
	}
}

const upgradeRequest = "POST /v1.47/containers/x/attach?stream=1&stdin=1&stdout=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
const upgraded = "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"

// `docker run -i`: the input's end reaches Docker, then the output's end reaches the client.
func TestInputThenOutputEnd(t *testing.T) {
	s := startAll(t, func(t *testing.T, c net.Conn, r *bufio.Reader, head string) {
		fmt.Fprint(c, upgraded)
		in, err := io.ReadAll(r) // stdin, until the client's half-close
		if err != nil {
			t.Errorf("stdin: %v", err)
		}
		fmt.Fprintf(c, "got %q", in)
		closeWrite(t, c)
	})
	c := s.dial(t)
	fmt.Fprint(c, upgradeRequest+"hello\n")
	closeWrite(t, c)
	out := readAll(t, c, 5*time.Second)
	if want := upgraded + `got "hello\n"`; string(out) != want {
		t.Fatalf("got %q, want %q", out, want)
	}
	c.Close()
	s.waitDockerClosed(t)
}

// Plain `docker run`: the output ends while the client still has its input open.
func TestOutputEndsFirst(t *testing.T) {
	s := startAll(t, func(t *testing.T, c net.Conn, r *bufio.Reader, head string) {
		fmt.Fprint(c, upgraded+"output")
		closeWrite(t, c)
		// The connection is still open the other way.
		in, err := io.ReadAll(r)
		if err != nil || string(in) != "late input" {
			t.Errorf("input after the output ended: %q, %v", in, err)
		}
	})
	c := s.dial(t)
	fmt.Fprint(c, upgradeRequest)
	if out := readAll(t, c, 5*time.Second); string(out) != upgraded+"output" {
		t.Fatalf("got %q", out)
	}
	fmt.Fprint(c, "late input")
	closeWrite(t, c)
	s.waitDockerClosed(t)
}

// An attach without Upgrade: Docker answers 200 with a raw stream that only its end ends.
func TestRawStreamWithoutUpgrade(t *testing.T) {
	const raw = "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n"
	s := startAll(t, func(t *testing.T, c net.Conn, r *bufio.Reader, head string) {
		if strings.Contains(head, "Upgrade") {
			t.Errorf("unexpected upgrade: %q", head)
		}
		fmt.Fprint(c, raw+"logs")
		closeWrite(t, c)
	})
	c := s.dial(t)
	fmt.Fprint(c, "POST /containers/x/attach?stream=1&stdout=1 HTTP/1.1\r\nHost: docker\r\n\r\n")
	if out := readAll(t, c, 5*time.Second); string(out) != raw+"logs" {
		t.Fatalf("got %q", out)
	}
	c.Close()
	s.waitDockerClosed(t)
}

// BuildKit's sessions upgrade to h2c; the bytes are whatever HTTP/2 sends, both ways at once.
func TestLargeStreamsBothWays(t *testing.T) {
	const size = 8 << 20
	in := make([]byte, size)
	_, _ = rand.Read(in)
	sum := sha256.Sum256(in)
	s := startAll(t, func(t *testing.T, c net.Conn, r *bufio.Reader, head string) {
		fmt.Fprint(c, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n")
		// Echo while still reading: neither side waits for the other to finish.
		if _, err := io.Copy(c, r); err != nil {
			t.Errorf("echo: %v", err)
		}
		closeWrite(t, c)
	})
	c := s.dial(t)
	go func() {
		fmt.Fprint(c, "POST /session HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n")
		_, _ = c.Write(in)
		closeWrite(t, c)
	}()
	out := readAll(t, c, 60*time.Second)
	head := "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n"
	if !bytes.HasPrefix(out, []byte(head)) {
		t.Fatalf("no upgrade: %q", out[:min(len(out), 200)])
	}
	if got := sha256.Sum256(out[len(head):]); got != sum || len(out)-len(head) != size {
		t.Fatalf("echo differs: %d bytes", len(out)-len(head))
	}
	c.Close()
	s.waitDockerClosed(t)
}

// Ordinary requests, several on one connection, as the CLI sends them.
func TestKeepAliveRequests(t *testing.T) {
	s := startAll(t, func(t *testing.T, c net.Conn, r *bufio.Reader, head string) {
		for i := 0; ; i++ {
			fmt.Fprintf(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n%02d", i)
			if _, err := readHead(r); err != nil {
				return
			}
		}
	})
	c := s.dial(t)
	r := bufio.NewReader(c)
	for i := 0; i < 3; i++ {
		fmt.Fprint(c, "GET /version HTTP/1.1\r\nHost: docker\r\n\r\n")
		head, err := readHead(r)
		if err != nil || !strings.HasPrefix(head, "HTTP/1.1 200") {
			t.Fatalf("response %d: %q %v", i, head, err)
		}
		body := make([]byte, 2)
		if _, err := io.ReadFull(r, body); err != nil || string(body) != fmt.Sprintf("%02d", i) {
			t.Fatalf("body %d: %q %v", i, body, err)
		}
	}
	c.Close()
	s.waitDockerClosed(t)
}

func dialBack(t *testing.T, s *setup) net.Conn {
	t.Helper()
	c, err := net.Dial("tcp", s.helper.BackAddr())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestBackRefusesAWrongToken(t *testing.T) {
	s := startAll(t, func(t *testing.T, c net.Conn, r *bufio.Reader, head string) {
		t.Error("Docker was reached without the token")
	})
	c := dialBack(t, s)
	wrong := bytes.Repeat([]byte{'x'}, tokenSize)
	fmt.Fprintf(c, "%s%s\nGET /version HTTP/1.1\r\nHost: docker\r\n\r\n", wrong, s.docker.path)
	if out := readAll(t, c, 5*time.Second); len(out) != 0 {
		t.Fatalf("answered: %q", out)
	}
}

func TestBackClosesASlowConnection(t *testing.T) {
	old := preambleTimeout
	preambleTimeout = 200 * time.Millisecond
	t.Cleanup(func() { preambleTimeout = old })
	s := startAll(t, func(t *testing.T, c net.Conn, r *bufio.Reader, head string) {})
	c := dialBack(t, s)
	_, _ = c.Write(s.token[:10])
	if out := readAll(t, c, 5*time.Second); len(out) != 0 {
		t.Fatalf("answered: %q", out)
	}
}

// The token, path and request may come in pieces.
func TestBackTakesAPreambleInPieces(t *testing.T) {
	s := startAll(t, func(t *testing.T, c net.Conn, r *bufio.Reader, head string) {
		fmt.Fprint(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
		closeWrite(t, c)
	})
	c := dialBack(t, s)
	whole := fmt.Sprintf("%s%s\nGET /version HTTP/1.1\r\nHost: docker\r\n\r\n", s.token, s.docker.path)
	for i := 0; i < len(whole); i += 7 {
		_, _ = c.Write([]byte(whole[i:min(i+7, len(whole))]))
		time.Sleep(time.Millisecond)
	}
	closeWrite(t, c)
	if out := readAll(t, c, 5*time.Second); !strings.HasSuffix(string(out), "\r\n\r\nok") {
		t.Fatalf("got %q", out)
	}
}

func refusal(t *testing.T, s *setup, path string) (string, string) {
	t.Helper()
	c := dialBack(t, s)
	fmt.Fprintf(c, "%s%s\nGET /version HTTP/1.1\r\nHost: docker\r\n\r\n", s.token, path)
	closeWrite(t, c)
	out := string(readAll(t, c, 40*time.Second))
	if !strings.HasPrefix(out, "HTTP/1.1 502 ") {
		t.Fatalf("got %q", out)
	}
	code := ""
	for _, line := range strings.Split(out, "\r\n") {
		if v, ok := strings.CutPrefix(line, "X-Wirescry-Dial-Error: "); ok {
			code = v
		}
	}
	var body struct{ Message string }
	_ = json.Unmarshal([]byte(out[strings.Index(out, "\r\n\r\n")+4:]), &body)
	return code, body.Message
}

func TestBackRefusesPipesOnOtherComputers(t *testing.T) {
	s := startAll(t, func(t *testing.T, c net.Conn, r *bufio.Reader, head string) {})
	remote := `\\server\pipe\docker_engine`
	if runtime.GOOS != "windows" {
		remote = "relative/path"
	}
	if code, message := refusal(t, s, remote); code != "EINVAL" || !strings.Contains(message, "this computer") {
		t.Fatalf("got %s %q", code, message)
	}
}

func TestBackSaysWhenDockerIsntThere(t *testing.T) {
	s := startAll(t, func(t *testing.T, c net.Conn, r *bufio.Reader, head string) {})
	if code, _ := refusal(t, s, localPath(t, "missing")); code != "ENOENT" {
		t.Fatalf("got %s", code)
	}
}

func TestPipePaths(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows pipe names")
	}
	for path, want := range map[string]bool{
		`\\.\pipe\docker_engine`:            true,
		`\\.\PIPE\dockerDesktopLinuxEngine`: true,
		`\\server\pipe\docker_engine`:       false,
		`\\.\pipe\`:                         false,
		`\\.\pipe\a\b`:                      false,
		`//./pipe/docker_engine`:            false,
		`C:\docker.sock`:                    false,
	} {
		if validLocal(path) != want {
			t.Errorf("validLocal(%q) = %v", path, !want)
		}
	}
}

func TestFrontRefusesATakenName(t *testing.T) {
	docker := startDocker(t, func(t *testing.T, c net.Conn, r *bufio.Reader, head string) {})
	_, err := start(config{Listen: docker.path, Relay: "127.0.0.1:1", Token: randomHex(tokenSize)})
	if err == nil {
		t.Fatal("served a name someone else already has")
	}
}

func TestStartChecksItsSettings(t *testing.T) {
	path := localPath(t, "front")
	for _, cfg := range []config{
		{Listen: path, Relay: "127.0.0.1:1", Token: "short"},
		{Listen: path, Relay: "10.0.0.1:1", Token: randomHex(tokenSize)},
		{Listen: path, Relay: "localhost:1", Token: randomHex(tokenSize)},
	} {
		if h, err := start(cfg); err == nil {
			h.Close()
			t.Errorf("started with %+v", cfg)
		}
	}
}

// The helper as Wirescry runs it: settings on stdin, the back port on stdout, and it stops
// when stdin closes.
func TestStopsWhenStdinCloses(t *testing.T) {
	relay, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "WIRESCRY_DOCKER_PIPE_RUN_MAIN=1")
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	settings, _ := json.Marshal(config{Listen: localPath(t, "front"), Relay: relay.Addr().String(), Token: randomHex(tokenSize)})
	fmt.Fprintf(stdin, "%s\n", settings)
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	var answer struct{ Back, Error string }
	_ = json.Unmarshal([]byte(line), &answer)
	if answer.Back == "" {
		t.Fatalf("answered %q", line)
	}
	stdin.Close()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("exited with %v", err)
		}
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("still running after stdin closed")
	}
}
