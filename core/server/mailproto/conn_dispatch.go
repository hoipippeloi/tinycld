package mailproto

import (
	"crypto/tls"
	"errors"
	"net"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
)

// Service names one mail protocol server an app runs.
type Service string

const (
	ServiceIMAP       Service = "imap"
	ServiceSubmission Service = "submission"
	ServiceMX         Service = "mx"
)

// ErrNotServing refuses a connection handed to an app that runs no server for
// the service, or whose server has begun to stop. The caller still owns the
// connection and must close it.
var ErrNotServing = errors.New("mailproto: the app serves no connections for this service")

// ServeIMAPConn hands conn, which the caller accepted, to app's IMAP server
// and returns at once. The server owns conn from then on. It lets one process
// serve many apps: a dispatcher accepts, picks the app, and calls this. The
// connection is served as it is: a dispatcher that terminated TLS hands in the
// plaintext side, and the server wraps no TLS around it.
func ServeIMAPConn(app core.App, conn net.Conn) error {
	return serveConn(app, ServiceIMAP, conn)
}

// ServeSubmissionConn is ServeIMAPConn for app's SMTP submission server.
func ServeSubmissionConn(app core.App, conn net.Conn) error {
	return serveConn(app, ServiceSubmission, conn)
}

// ServeMXConn is ServeIMAPConn for app's inbound MX server.
func ServeMXConn(app core.App, conn net.Conn) error {
	return serveConn(app, ServiceMX, conn)
}

// Dispatched is a ListenFunc for a service whose connections all arrive
// through ServeIMAPConn, ServeSubmissionConn or ServeMXConn. The listener it
// returns binds no port and accepts nothing. Use it with ExternalTLS: the
// dispatcher that hands the connections in has terminated TLS.
func Dispatched(addr string) (net.Listener, error) {
	return newConnQueue(addr), nil
}

func serveConn(app core.App, svc Service, conn net.Conn) error {
	e := servicesOf(app).get(svc)
	if e == nil {
		return ErrNotServing
	}
	return e.accept(conn, nil)
}

var servicesKey = appstate.NewKey[*services]("mailproto.services")

// services holds the server each service of one app runs.
type services struct {
	mu      sync.Mutex
	entries map[Service]*entry
}

func servicesOf(app core.App) *services {
	return servicesKey.GetOrInit(app, func() *services {
		return &services{entries: map[Service]*entry{}}
	})
}

func (s *services) set(svc Service, e *entry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries[svc] = e
}

func (s *services) get(svc Service) *entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.entries[svc]
}

// entry is one protocol server's way in: a connection queue the server
// serves on, and the drain that counts every connection put in it.
type entry struct {
	d     *drain
	queue *connQueue
}

// startEntry serves serve on a new connection queue and makes it app's server
// for svc. Every listener of the server feeds the same queue (see acceptFrom),
// so the standalone listener paths and a dispatcher share one way in. The
// drain closes the queue with the server's listeners.
func startEntry(app core.App, svc Service, d *drain, label string, serve func(net.Listener) error) *entry {
	e := &entry{d: d, queue: newConnQueue(string(svc))}
	d.serve(e.queue, label, string(svc), serve)
	servicesOf(app).set(svc, e)
	return e
}

// accept counts c in the drain, wraps it in TLS when tlsConfig is set, and
// queues it for the server. On an error the caller still owns c.
func (e *entry) accept(c net.Conn, tlsConfig *tls.Config) error {
	tc := e.d.track(c)
	if tc == nil {
		return ErrNotServing
	}
	var conn net.Conn = tc
	if tlsConfig != nil {
		conn = tls.Server(tc, tlsConfig)
	}
	if err := e.queue.push(conn); err != nil {
		// Leave the drain without closing c: the caller owns it again.
		tc.closeOnce.Do(func() { e.d.untrack(tc) })
		return ErrNotServing
	}
	return nil
}

// acceptFrom returns the serve loop of a listener that feeds e. It accepts
// each connection and hands it over the way ServeIMAPConn does, wrapped in TLS
// when tlsConfig is set. A temporary accept error (the process is out of file
// descriptors) is retried with the same backoff the protocol libraries use.
func (e *entry) acceptFrom(tlsConfig *tls.Config) func(net.Listener) error {
	return func(ln net.Listener) error {
		var delay time.Duration
		for {
			c, err := ln.Accept()
			if err != nil {
				if ne, ok := err.(net.Error); ok && ne.Temporary() {
					delay = acceptBackoff(delay)
					mailLog.Warn("accept failed; retrying", "server", e.d.label, "delay", delay, "err", err)
					time.Sleep(delay)
					continue
				}
				return err
			}
			delay = 0
			if err := e.accept(c, tlsConfig); err != nil {
				_ = c.Close()
			}
		}
	}
}

func acceptBackoff(prev time.Duration) time.Duration {
	if prev == 0 {
		return 5 * time.Millisecond
	}
	if next := prev * 2; next < time.Second {
		return next
	}
	return time.Second
}

// connQueue is a net.Listener whose connections are pushed in rather than
// accepted from a socket. Accept returns net.ErrClosed once it is closed,
// which every serve loop here treats as a normal stop.
type connQueue struct {
	addr  queueAddr
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

func newConnQueue(addr string) *connQueue {
	return &connQueue{
		addr:  queueAddr(addr),
		conns: make(chan net.Conn),
		done:  make(chan struct{}),
	}
}

func (q *connQueue) Accept() (net.Conn, error) {
	select {
	case c := <-q.conns:
		return c, nil
	case <-q.done:
		return nil, net.ErrClosed
	}
}

func (q *connQueue) Close() error {
	q.once.Do(func() { close(q.done) })
	return nil
}

func (q *connQueue) Addr() net.Addr { return q.addr }

// push waits until the server accepts c, or fails once the queue is closed.
func (q *connQueue) push(c net.Conn) error {
	select {
	case <-q.done:
		return net.ErrClosed
	default:
	}
	select {
	case q.conns <- c:
		return nil
	case <-q.done:
		return net.ErrClosed
	}
}

type queueAddr string

func (a queueAddr) Network() string { return "mailproto" }
func (a queueAddr) String() string  { return string(a) }
