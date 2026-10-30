//go:build unix

package readonly

import (
	"syscall"
	"testing"
	"time"
)

// SIGUSR2 is one signal for the whole process: it enters read-only mode for
// every app that called Register and has not terminated. One app per process
// (standalone) therefore behaves as before.
func TestSIGUSR2EntersEveryRegisteredApp(t *testing.T) {
	a := registeredTestApp(t)
	t.Cleanup(a.Cleanup)
	b := registeredTestApp(t)
	t.Cleanup(b.Cleanup)
	gone := registeredTestApp(t)
	gone.Cleanup() // a terminated app leaves the registry

	if err := syscall.Kill(syscall.Getpid(), syscall.SIGUSR2); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !Active(a) || !Active(b) {
		if time.Now().After(deadline) {
			t.Fatalf("SIGUSR2 did not enter read-only mode: a=%v b=%v", Active(a), Active(b))
		}
		time.Sleep(10 * time.Millisecond)
	}
	if Active(gone) {
		t.Fatal("SIGUSR2 entered read-only mode for an app that had terminated")
	}
}
