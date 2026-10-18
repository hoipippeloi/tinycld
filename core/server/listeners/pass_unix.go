//go:build unix

package listeners

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// Set is an ordered collection of named listeners and files the supervisor
// hands to one child process. Order matters: it is the order ExtraFiles
// (and so fd numbers) and EnvFDNames are written in.
type Set struct {
	names []string
	files []*os.File
	addrs map[string]net.Addr
}

// AddListener adds l under name. It keeps a dup of the listening socket;
// the dup is what a child's net.FileListener re-wraps, and what the server
// code that accepts on it ultimately closes, so the supervisor's own
// listener is never closed by a child's shutdown.
func (s *Set) AddListener(name string, l *net.TCPListener) error {
	f, err := dupListener(name, l)
	if err != nil {
		return fmt.Errorf("listeners: dup %s listener: %w", name, err)
	}
	s.add(name, f)
	if s.addrs == nil {
		s.addrs = map[string]net.Addr{}
	}
	s.addrs[name] = l.Addr()
	return nil
}

// dupListener dups l's socket without l.File(). exec reads each passed
// file's fd through os.File.Fd, and on a file from l.File() that switches
// the socket to blocking mode. The mode belongs to the socket, which every
// running child shares, not to the dup: a running child that calls
// accept(2) before the new child's net.FileListener switches it back stays
// blocked in the kernel until a connection comes, and its Close waits for
// that accept, so a drain with no traffic never ends.
func dupListener(name string, l *net.TCPListener) (*os.File, error) {
	rc, err := l.SyscallConn()
	if err != nil {
		return nil, err
	}
	var fd int
	var dupErr error
	ctlErr := rc.Control(func(sysfd uintptr) {
		// Under ForkLock, so a concurrent exec cannot inherit the dup
		// before it is close-on-exec.
		syscall.ForkLock.RLock()
		defer syscall.ForkLock.RUnlock()
		fd, dupErr = syscall.Dup(int(sysfd))
		if dupErr == nil {
			syscall.CloseOnExec(fd)
		}
	})
	if err := errors.Join(ctlErr, dupErr); err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), name), nil
}

// AddFile adds a plain, non-listener fd under name (e.g. the control
// socket end handed to a child).
func (s *Set) AddFile(name string, f *os.File) {
	s.add(name, f)
}

func (s *Set) add(name string, f *os.File) {
	s.names = append(s.names, name)
	s.files = append(s.files, f)
}

// Addr returns the bound address of the listener added under name, or nil
// if name was never added via AddListener.
func (s *Set) Addr(name string) net.Addr {
	return s.addrs[name]
}

// Apply sets cmd.ExtraFiles to this Set's files and appends EnvFDs/
// EnvFDNames to cmd.Env, in the same order, so the child's fd 3, 4, 5, …
// line up with names[0], names[1], names[2], ….
func (s *Set) Apply(cmd *exec.Cmd) {
	cmd.ExtraFiles = append(cmd.ExtraFiles, s.files...)
	cmd.Env = append(cmd.Env,
		EnvFDs+"="+strconv.Itoa(len(s.names)),
		EnvFDNames+"="+strings.Join(s.names, ":"),
	)
}
