package mailproto

import (
	"io"
	"net"
	"sync"

	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
	"github.com/pocketbase/pocketbase/core"
)

// errSMTPShuttingDown refuses new work while the server shuts down. A 4xx
// makes the client queue the message and try again, by then on the next
// server.
var errSMTPShuttingDown = &smtp.SMTPError{
	Code:         421,
	EnhancedCode: smtp.EnhancedCode{4, 3, 2},
	Message:      "Mail service is shutting down; try again later",
}

// ServeSMTP serves server on ln with the graceful stop StartSMTP gives its
// own listeners, binds that stop to app's terminate, and returns it. It is
// for an SMTP service whose listener and server the caller builds itself;
// the caller must not call server.Close or server.Shutdown. service names the
// service ServeSubmissionConn or ServeMXConn reaches the server through.
//
// It replaces server.Backend with a wrapper the stop sees through, and
// server.LMTP must be false: the wrapper does not forward LMTPSession. label
// names the service in logs.
//
// On stop, a new session and a new transaction (MAIL FROM, AUTH) get 421; a
// transaction begun before may still finish within the drain. A DATA whose
// message the session has read in full runs to the end, with its connection
// open for the reply, so the client does not send again a message that was
// stored.
func ServeSMTP(app core.App, service Service, server *smtp.Server, ln net.Listener, label string) func() {
	d := newSMTPDrain(server, label)
	e := startEntry(app, service, d, label, server.Serve)
	d.serve(ln, label, ln.Addr().String(), e.acceptFrom(nil))
	return d.bind(app)
}

// newSMTPDrain makes the drain of server and wraps its backend.
func newSMTPDrain(server *smtp.Server, label string) *drain {
	d := newDrain(label, false)
	server.Backend = &drainSMTPBackend{d: d, inner: server.Backend}
	d.closeServer = func() { _ = server.Close() }
	return d
}

type drainSMTPBackend struct {
	d     *drain
	inner smtp.Backend
}

func (b *drainSMTPBackend) NewSession(c *smtp.Conn) (smtp.Session, error) {
	tc := trackedOf(c.Conn())
	if !b.d.beginSession(tc, nil) {
		return nil, errSMTPShuttingDown
	}
	inner, err := b.inner.NewSession(c)
	if err != nil {
		b.d.endSession()
		return nil, err
	}
	s := &drainSMTPSession{d: b.d, tc: tc, inner: inner}
	if auth, ok := inner.(smtp.AuthSession); ok {
		return &drainSMTPAuthSession{drainSMTPSession: s, auth: auth}, nil
	}
	return s, nil
}

// drainSMTPSession passes each call to the feature's session once the drain
// admits it.
type drainSMTPSession struct {
	d     *drain
	tc    *trackedConn
	inner smtp.Session

	logoutOnce sync.Once
}

var _ smtp.Session = (*drainSMTPSession)(nil)

func (s *drainSMTPSession) enter(policy admitPolicy) (*call, error) {
	c := s.d.enter(s.tc, callCut, policy)
	if c == nil {
		return nil, errSMTPShuttingDown
	}
	return c, nil
}

func (s *drainSMTPSession) Mail(from string, opts *smtp.MailOptions) error {
	c, err := s.enter(admitUntilDrain)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Mail(from, opts)
}

func (s *drainSMTPSession) Rcpt(to string, opts *smtp.RcptOptions) error {
	c, err := s.enter(admitUntilClosed)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Rcpt(to, opts)
}

// Data can be cut while it still reads the message; once it has read the
// message in full it is a write.
func (s *drainSMTPSession) Data(r io.Reader) error {
	c, err := s.enter(admitUntilClosed)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Data(&bodyWatch{r: r, done: c.write})
}

func (s *drainSMTPSession) Reset() {
	s.inner.Reset()
}

func (s *drainSMTPSession) Logout() error {
	var err error
	s.logoutOnce.Do(func() {
		defer s.d.endSession()
		err = s.inner.Logout()
	})
	return err
}

// drainSMTPAuthSession forwards AUTH for a session that offers it.
type drainSMTPAuthSession struct {
	*drainSMTPSession
	auth smtp.AuthSession
}

var _ smtp.AuthSession = (*drainSMTPAuthSession)(nil)

func (s *drainSMTPAuthSession) AuthMechanisms() []string {
	return s.auth.AuthMechanisms()
}

func (s *drainSMTPAuthSession) Auth(mech string) (sasl.Server, error) {
	c, err := s.enter(admitUntilDrain)
	if err != nil {
		return nil, err
	}
	defer c.leave()
	return s.auth.Auth(mech)
}

// bodyWatch calls done once the session has read the message in full.
type bodyWatch struct {
	r    io.Reader
	done func()
}

func (b *bodyWatch) Read(p []byte) (int, error) {
	n, err := b.r.Read(p)
	if err == io.EOF {
		b.done()
	}
	return n, err
}
