package mailproto

import (
	"errors"
	"io"
	"sync"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
)

const imapByeText = "Server shutting down; try again later"

// errIMAPUnavailable refuses a command once the drain has begun. The session
// also says BYE, so the client reconnects, by then to the next server.
var errIMAPUnavailable = &imap.Error{
	Type: imap.StatusResponseTypeNo,
	Code: imap.ResponseCodeUnavailable,
	Text: imapByeText,
}

// errIMAPByeGreeting is the greeting of a connection that arrives as the
// drain begins.
var errIMAPByeGreeting = &imap.Error{
	Type: imap.StatusResponseTypeBye,
	Text: imapByeText,
}

var errIMAPSessionNotRev2 = errors.New("mailproto: the IMAP session does not implement imapserver.SessionIMAP4rev2, which IMAPCaps advertises")

// newIMAPSession admits a session on conn, or refuses it once the drain has
// begun, and wraps the feature's session so the drain sees its calls.
func (d *drain) newIMAPSession(conn *imapserver.Conn, newSession func() imapserver.Session) (imapserver.Session, error) {
	tc := trackedOf(conn.NetConn())
	bye := func() { _ = conn.Bye(imapByeText) }
	if !d.beginSession(tc, bye) {
		return nil, errIMAPByeGreeting
	}
	inner, ok := newSession().(imapserver.SessionIMAP4rev2)
	if !ok {
		d.endSession()
		return nil, errIMAPSessionNotRev2
	}
	return &drainIMAPSession{d: d, tc: tc, bye: bye, inner: inner}, nil
}

// drainIMAPSession passes each call to the feature's session once the drain
// admits it. It implements exactly imapserver.SessionIMAP4rev2, the set
// IMAPCaps advertises: a session's SessionSASL, SessionUnauthenticate and
// SessionAppendLimit are not forwarded.
type drainIMAPSession struct {
	d     *drain
	tc    *trackedConn
	bye   func()
	inner imapserver.SessionIMAP4rev2

	closeOnce sync.Once
}

var _ imapserver.SessionIMAP4rev2 = (*drainIMAPSession)(nil)

// enter admits a command, or says BYE and refuses it. The BYE runs on the
// session's own goroutine, which writes nothing else meanwhile.
func (s *drainIMAPSession) enter(kind callKind) (*call, error) {
	c := s.d.enter(s.tc, kind, admitUntilDrain)
	if c == nil {
		s.bye()
		return nil, errIMAPUnavailable
	}
	return c, nil
}

// Close ends the session in the drain even when the feature's Close panics,
// which go-imap recovers: the stop would wait for it forever.
func (s *drainIMAPSession) Close() error {
	var err error
	s.closeOnce.Do(func() {
		defer s.d.endSession()
		err = s.inner.Close()
	})
	return err
}

func (s *drainIMAPSession) Login(username, password string) error {
	c, err := s.enter(callCut)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Login(username, password)
}

func (s *drainIMAPSession) Select(mailbox string, options *imap.SelectOptions) (*imap.SelectData, error) {
	c, err := s.enter(callCut)
	if err != nil {
		return nil, err
	}
	defer c.leave()
	return s.inner.Select(mailbox, options)
}

func (s *drainIMAPSession) Create(mailbox string, options *imap.CreateOptions) error {
	c, err := s.enter(callWrite)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Create(mailbox, options)
}

func (s *drainIMAPSession) Delete(mailbox string) error {
	c, err := s.enter(callWrite)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Delete(mailbox)
}

func (s *drainIMAPSession) Rename(mailbox, newName string, options *imap.RenameOptions) error {
	c, err := s.enter(callWrite)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Rename(mailbox, newName, options)
}

func (s *drainIMAPSession) Subscribe(mailbox string) error {
	c, err := s.enter(callWrite)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Subscribe(mailbox)
}

func (s *drainIMAPSession) Unsubscribe(mailbox string) error {
	c, err := s.enter(callWrite)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Unsubscribe(mailbox)
}

func (s *drainIMAPSession) List(w *imapserver.ListWriter, ref string, patterns []string, options *imap.ListOptions) error {
	c, err := s.enter(callCut)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.List(w, ref, patterns, options)
}

func (s *drainIMAPSession) Status(mailbox string, options *imap.StatusOptions) (*imap.StatusData, error) {
	c, err := s.enter(callCut)
	if err != nil {
		return nil, err
	}
	defer c.leave()
	return s.inner.Status(mailbox, options)
}

// Append can be cut while it still reads the message; once it has read the
// whole literal it is a write.
func (s *drainIMAPSession) Append(mailbox string, r imap.LiteralReader, options *imap.AppendOptions) (*imap.AppendData, error) {
	c, err := s.enter(callCut)
	if err != nil {
		return nil, err
	}
	defer c.leave()
	return s.inner.Append(mailbox, &literalWatch{LiteralReader: r, done: c.write}, options)
}

// Poll is never refused: go-imap calls it after a command and before the
// command's tagged reply, so refusing it would drop the reply to a write that
// was made.
func (s *drainIMAPSession) Poll(w *imapserver.UpdateWriter, allowExpunge bool) error {
	c := s.d.enter(s.tc, callCut, admitAlways)
	defer c.leave()
	return s.inner.Poll(w, allowExpunge)
}

func (s *drainIMAPSession) Idle(w *imapserver.UpdateWriter, stop <-chan struct{}) error {
	c, err := s.enter(callIdle)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Idle(w, stop)
}

func (s *drainIMAPSession) Unselect() error {
	c, err := s.enter(callCut)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Unselect()
}

func (s *drainIMAPSession) Expunge(w *imapserver.ExpungeWriter, uids *imap.UIDSet) error {
	c, err := s.enter(callWrite)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Expunge(w, uids)
}

func (s *drainIMAPSession) Search(kind imapserver.NumKind, criteria *imap.SearchCriteria, options *imap.SearchOptions) (*imap.SearchData, error) {
	c, err := s.enter(callCut)
	if err != nil {
		return nil, err
	}
	defer c.leave()
	return s.inner.Search(kind, criteria, options)
}

func (s *drainIMAPSession) Fetch(w *imapserver.FetchWriter, numSet imap.NumSet, options *imap.FetchOptions) error {
	c, err := s.enter(callCut)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Fetch(w, numSet, options)
}

func (s *drainIMAPSession) Store(w *imapserver.FetchWriter, numSet imap.NumSet, flags *imap.StoreFlags, options *imap.StoreOptions) error {
	c, err := s.enter(callWrite)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Store(w, numSet, flags, options)
}

func (s *drainIMAPSession) Copy(numSet imap.NumSet, dest string) (*imap.CopyData, error) {
	c, err := s.enter(callWrite)
	if err != nil {
		return nil, err
	}
	defer c.leave()
	return s.inner.Copy(numSet, dest)
}

func (s *drainIMAPSession) Namespace() (*imap.NamespaceData, error) {
	c, err := s.enter(callCut)
	if err != nil {
		return nil, err
	}
	defer c.leave()
	return s.inner.Namespace()
}

func (s *drainIMAPSession) Move(w *imapserver.MoveWriter, numSet imap.NumSet, dest string) error {
	c, err := s.enter(callWrite)
	if err != nil {
		return err
	}
	defer c.leave()
	return s.inner.Move(w, numSet, dest)
}

// literalWatch calls done once the session has read the whole literal.
type literalWatch struct {
	imap.LiteralReader
	read int64
	done func()
}

func (r *literalWatch) Read(p []byte) (int, error) {
	n, err := r.LiteralReader.Read(p)
	r.read += int64(n)
	if err == io.EOF || r.read >= r.Size() {
		r.done()
	}
	return n, err
}
