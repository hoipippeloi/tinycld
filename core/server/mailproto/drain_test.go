package mailproto

import (
	"bufio"
	"context"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-smtp"
	"github.com/pocketbase/pocketbase/core"
)

// The servers here serve a fictional "widget" store: core names no package of
// its own. Each test terminates the app, as a deploy does, and checks what the
// stop waits for and what it refuses or cuts.

// widgetStore is the backend the test sessions share. A store blocks until
// release closes, so a test can hold a write in progress.
type widgetStore struct {
	read    chan struct{} // a session has read a whole message
	release chan struct{} // lets the stores finish
	stored  atomic.Int32
	readErr chan error // a session failed to read a message

	selectStarted chan struct{}
	selectRelease chan struct{} // nil: SELECT does not block
	idling        chan struct{}
	created       atomic.Bool
}

func newWidgetStore() *widgetStore {
	return &widgetStore{
		read:          make(chan struct{}, 8),
		release:       make(chan struct{}),
		readErr:       make(chan error, 8),
		selectStarted: make(chan struct{}, 8),
		idling:        make(chan struct{}, 8),
	}
}

func (w *widgetStore) store(r io.Reader) error {
	if _, err := io.ReadAll(r); err != nil {
		w.readErr <- err
		return err
	}
	w.read <- struct{}{}
	<-w.release
	w.stored.Add(1)
	return nil
}

type widgetIMAPSession struct {
	nopIMAPSession
	w *widgetStore
}

func (s *widgetIMAPSession) Close() error                              { return nil }
func (s *widgetIMAPSession) Login(string, string) error                { return nil }
func (s *widgetIMAPSession) Poll(*imapserver.UpdateWriter, bool) error { return nil }
func (s *widgetIMAPSession) Create(string, *imap.CreateOptions) error {
	s.w.created.Store(true)
	return nil
}
func (s *widgetIMAPSession) Unselect() error { return nil }
func (s *widgetIMAPSession) Namespace() (*imap.NamespaceData, error) {
	return &imap.NamespaceData{}, nil
}
func (s *widgetIMAPSession) Status(string, *imap.StatusOptions) (*imap.StatusData, error) {
	return &imap.StatusData{}, nil
}

func (s *widgetIMAPSession) Select(string, *imap.SelectOptions) (*imap.SelectData, error) {
	s.w.selectStarted <- struct{}{}
	if s.w.selectRelease != nil {
		<-s.w.selectRelease
	}
	return &imap.SelectData{}, nil
}

func (s *widgetIMAPSession) Append(_ string, r imap.LiteralReader, _ *imap.AppendOptions) (*imap.AppendData, error) {
	if err := s.w.store(r); err != nil {
		return nil, err
	}
	return &imap.AppendData{UID: 1, UIDValidity: 1}, nil
}

func (s *widgetIMAPSession) Idle(_ *imapserver.UpdateWriter, stop <-chan struct{}) error {
	s.w.idling <- struct{}{}
	<-stop
	return nil
}

type widgetSMTPSession struct{ w *widgetStore }

func (s *widgetSMTPSession) Mail(string, *smtp.MailOptions) error { return nil }
func (s *widgetSMTPSession) Rcpt(string, *smtp.RcptOptions) error { return nil }
func (s *widgetSMTPSession) Data(r io.Reader) error               { return s.w.store(r) }
func (s *widgetSMTPSession) Reset()                               {}
func (s *widgetSMTPSession) Logout() error                        { return nil }

func setDrainBound(t *testing.T, bound time.Duration) {
	t.Helper()
	prev := drainBound
	drainBound = bound
	t.Cleanup(func() { drainBound = prev })
}

func testListener(t *testing.T) (ListenFunc, string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	return func(string) (net.Listener, error) { return ln, nil }, ln.Addr().String()
}

func startWidgetIMAP(t *testing.T, app core.App, w *widgetStore) string {
	t.Helper()
	listen, addr := testListener(t)
	if _, err := StartIMAP(app, nil, IMAPOptions{
		NewSession: func(core.App, *imapserver.Conn) imapserver.Session {
			return &widgetIMAPSession{w: w}
		},
		Listen:      listen,
		ExternalTLS: true,
	}); err != nil {
		t.Fatal(err)
	}
	return addr
}

func startWidgetSMTP(t *testing.T, app core.App, w *widgetStore) string {
	t.Helper()
	listen, addr := testListener(t)
	if _, err := StartSMTP(app, nil, SMTPOptions{
		Backend: smtp.BackendFunc(func(*smtp.Conn) (smtp.Session, error) {
			return &widgetSMTPSession{w: w}, nil
		}),
		Label:          "widget SMTP",
		TLSAddrEnv:     "WIDGET_SMTP_ADDR",
		DefaultTLSAddr: ":465",
		Listen:         listen,
		ExternalTLS:    true,
	}); err != nil {
		t.Fatal(err)
	}
	return addr
}

type textClient struct {
	t    *testing.T
	conn net.Conn
	r    *bufio.Reader
}

func dialText(t *testing.T, addr string) *textClient {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	t.Cleanup(func() { conn.Close() })
	return &textClient{t: t, conn: conn, r: bufio.NewReader(conn)}
}

func (c *textClient) send(s string) {
	c.t.Helper()
	if _, err := c.conn.Write([]byte(s)); err != nil {
		c.t.Fatalf("write %q: %v", s, err)
	}
}

func (c *textClient) readLine() (string, error) {
	_ = c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	return c.r.ReadString('\n')
}

// expect reads lines until one starts with prefix, and fails at any line
// that starts with stop or at the end of the stream.
func (c *textClient) expect(prefix, stop string) string {
	c.t.Helper()
	for {
		line, err := c.readLine()
		if err != nil {
			c.t.Fatalf("waiting for %q: %v", prefix, err)
		}
		if strings.HasPrefix(line, prefix) {
			return line
		}
		if stop != "" && strings.HasPrefix(line, stop) {
			c.t.Fatalf("got %q while waiting for %q", line, prefix)
		}
	}
}

// expectClosed reads until the server closes the connection.
func (c *textClient) expectClosed() []string {
	c.t.Helper()
	var lines []string
	for {
		line, err := c.readLine()
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				c.t.Fatalf("the server did not close the connection; read %q", lines)
			}
			return lines
		}
		lines = append(lines, line)
	}
}

func imapLogin(t *testing.T, addr string) *textClient {
	t.Helper()
	c := dialText(t, addr)
	c.expect("* OK", "")
	c.send("a LOGIN widget secret\r\n")
	c.expect("a OK", "a ")
	return c
}

func smtpHello(t *testing.T, addr string) *textClient {
	t.Helper()
	c := dialText(t, addr)
	c.expect("220", "")
	c.send("EHLO client.test\r\n")
	c.expect("250 ", "5")
	return c
}

func smtpTransaction(c *textClient) {
	c.t.Helper()
	c.send("MAIL FROM:<sender@widget.test>\r\n")
	c.expect("250", "")
	c.send("RCPT TO:<rcpt@widget.test>\r\n")
	c.expect("250", "")
}

func waitFor(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

// terminate runs the app's terminate, as a deploy does, and returns the
// channel that closes when it has returned. It waits until the drain has
// begun, shown by the listener at addr refusing connections.
func terminate(t *testing.T, app interface{ Cleanup() }, addr string) <-chan struct{} {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		app.Cleanup()
	}()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, time.Second)
		if err != nil {
			return done
		}
		conn.Close()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the listener still accepts after the terminate began")
	return done
}

func expectRunning(t *testing.T, done <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-done:
		t.Fatalf("terminate returned while %s", what)
	case <-time.After(300 * time.Millisecond):
	}
}

func expectDone(t *testing.T, done <-chan struct{}, within time.Duration) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(within):
		t.Fatalf("terminate did not return within %s", within)
	}
}

// An APPEND that has read its message runs to the end, past the bound, and
// its client gets the reply.
func TestIMAPTerminateWaitsForAppend(t *testing.T) {
	setDrainBound(t, 100*time.Millisecond)
	app := newTestApp(t)
	w := newWidgetStore()
	addr := startWidgetIMAP(t, app, w)

	c := imapLogin(t, addr)
	c.send("b APPEND INBOX {5+}\r\nhello\r\n")
	waitFor(t, w.read, "the APPEND to read its message")

	done := terminate(t, app, addr)
	expectRunning(t, done, "an APPEND was storing")
	close(w.release)
	expectDone(t, done, 5*time.Second)

	if w.stored.Load() != 1 {
		t.Fatalf("stored %d messages, want 1", w.stored.Load())
	}
	if line := c.expect("b ", ""); !strings.HasPrefix(line, "b OK") {
		t.Fatalf("APPEND reply = %q, want OK", line)
	}
	c.expectClosed()
}

// A DATA that has read its message runs to the end, past the bound, and its
// client gets the 250.
func TestSMTPTerminateWaitsForData(t *testing.T) {
	setDrainBound(t, 100*time.Millisecond)
	app := newTestApp(t)
	w := newWidgetStore()
	addr := startWidgetSMTP(t, app, w)

	c := smtpHello(t, addr)
	smtpTransaction(c)
	c.send("DATA\r\n")
	c.expect("354", "")
	c.send("Subject: widget\r\n\r\nhello\r\n.\r\n")
	waitFor(t, w.read, "the DATA to read its message")

	done := terminate(t, app, addr)
	expectRunning(t, done, "a DATA was storing")
	close(w.release)
	expectDone(t, done, 5*time.Second)

	if w.stored.Load() != 1 {
		t.Fatalf("stored %d messages, want 1", w.stored.Load())
	}
	c.expect("250", "4")
	c.expectClosed()
}

// IMAP clients hold their connections open, most often in IDLE. The drain
// says BYE to them at once instead of waiting the bound for them to leave.
func TestIMAPIdleSessionsDoNotHoldTerminate(t *testing.T) {
	setDrainBound(t, 30*time.Second)
	app := newTestApp(t)
	w := newWidgetStore()
	addr := startWidgetIMAP(t, app, w)

	idler := imapLogin(t, addr)
	idler.send("i IDLE\r\n")
	idler.expect("+", "")
	waitFor(t, w.idling, "the IDLE to start")
	quiet := imapLogin(t, addr)

	done := terminate(t, app, addr)
	expectDone(t, done, 3*time.Second)

	for name, c := range map[string]*textClient{"idling": idler, "quiet": quiet} {
		lines := c.expectClosed()
		if !containsPrefix(lines, "* BYE") {
			t.Errorf("%s session got %q before the close, want a BYE", name, lines)
		}
	}
}

// A client that stops sending in the middle of a message, or never sends
// its next command, holds the terminate for the bound and no longer, and the
// half-read message is not stored. Both servers drain at the same time.
func TestStuckSessionsAreCutAtTheBound(t *testing.T) {
	bound := 300 * time.Millisecond
	setDrainBound(t, bound)
	app := newTestApp(t)
	w := newWidgetStore()
	imapAddr := startWidgetIMAP(t, app, w)
	smtpAddr := startWidgetSMTP(t, app, w)

	imapStuck := imapLogin(t, imapAddr)
	imapStuck.send("b APPEND INBOX {100+}\r\nonly ten b")

	smtpStuck := smtpHello(t, smtpAddr)
	smtpTransaction(smtpStuck)
	smtpStuck.send("DATA\r\n")
	smtpStuck.expect("354", "")
	smtpStuck.send("Subject: half a widget\r\n")

	smtpQuiet := smtpHello(t, smtpAddr)

	start := time.Now()
	done := terminate(t, app, imapAddr)
	expectDone(t, done, 5*time.Second)
	if took := time.Since(start); took < bound {
		t.Fatalf("terminate returned after %s, before the bound %s: it did not wait for the sessions", took, bound)
	}

	for range 2 {
		select {
		case <-w.readErr:
		case <-time.After(time.Second):
			t.Fatal("a half-read message did not fail its read")
		}
	}
	if w.stored.Load() != 0 {
		t.Fatalf("stored %d half-read messages", w.stored.Load())
	}
	imapStuck.expectClosed()
	smtpStuck.expectClosed()
	smtpQuiet.expectClosed()
}

// During the drain the listener refuses connections, and a session that is
// still open gets no new work: IMAP says BYE, SMTP answers 421. A transaction
// begun before the drain may still finish.
func TestSMTPRefusesNewWorkDuringTheDrain(t *testing.T) {
	setDrainBound(t, 2*time.Second)
	app := newTestApp(t)
	w := newWidgetStore()
	addr := startWidgetSMTP(t, app, w)

	holder := smtpHello(t, addr)
	smtpTransaction(holder)
	holder.send("DATA\r\n")
	holder.expect("354", "")
	holder.send("hello\r\n.\r\n")
	waitFor(t, w.read, "the DATA to read its message")

	between := smtpHello(t, addr)
	unnamed := dialText(t, addr)
	unnamed.expect("220", "")
	inTransaction := smtpHello(t, addr)
	inTransaction.send("MAIL FROM:<sender@widget.test>\r\n")
	inTransaction.expect("250", "")

	done := terminate(t, app, addr)

	between.send("MAIL FROM:<sender@widget.test>\r\n")
	if line := between.expect("4", "2"); !strings.HasPrefix(line, "421 4.3.2") {
		t.Fatalf("MAIL FROM during the drain = %q, want 421 4.3.2", line)
	}
	unnamed.send("EHLO late.test\r\n")
	if line := unnamed.expect("4", "2"); !strings.HasPrefix(line, "421 4.3.2") {
		t.Fatalf("EHLO during the drain = %q, want 421 4.3.2", line)
	}
	inTransaction.send("RCPT TO:<rcpt@widget.test>\r\n")
	inTransaction.expect("250", "4")

	close(w.release)
	expectDone(t, done, 5*time.Second)
	holder.expect("250", "4")
}

func TestIMAPRefusesNewWorkDuringTheDrain(t *testing.T) {
	app := newTestApp(t)
	w := newWidgetStore()
	w.selectRelease = make(chan struct{})
	addr := startWidgetIMAP(t, app, w)

	holder := imapLogin(t, addr)
	holder.send("b APPEND INBOX {5+}\r\nhello\r\n")
	waitFor(t, w.read, "the APPEND to read its message")

	// The CREATE waits behind the SELECT and reaches the session only once
	// the drain has begun.
	pipelined := imapLogin(t, addr)
	pipelined.send("c SELECT INBOX\r\nd CREATE widgets\r\n")
	waitFor(t, w.selectStarted, "the SELECT to start")

	done := terminate(t, app, addr)
	close(w.selectRelease)

	if line := pipelined.expect("c ", ""); !strings.HasPrefix(line, "c OK") {
		t.Fatalf("SELECT begun before the drain = %q, want OK", line)
	}
	if lines := pipelined.expectClosed(); !containsPrefix(lines, "* BYE") {
		t.Fatalf("a command during the drain got %q, want a BYE", lines)
	}
	if w.created.Load() {
		t.Fatal("a CREATE sent during the drain ran")
	}

	close(w.release)
	expectDone(t, done, 5*time.Second)
	if line := holder.expect("b ", ""); !strings.HasPrefix(line, "b OK") {
		t.Fatalf("APPEND reply = %q, want OK", line)
	}
}

// A session refused as the drain begins never reaches the feature's backend.
func TestNewSessionRefusedDuringTheDrain(t *testing.T) {
	d := newDrain("widget", true)
	d.shutdown(context.Background())
	if d.beginSession(nil, nil) {
		t.Fatal("a session began after the drain")
	}
	if c := d.enter(nil, callCut, admitUntilClosed); c != nil {
		t.Fatal("a call was admitted after the drain closed")
	}
}

func containsPrefix(lines []string, prefix string) bool {
	for _, l := range lines {
		if strings.HasPrefix(l, prefix) {
			return true
		}
	}
	return false
}
