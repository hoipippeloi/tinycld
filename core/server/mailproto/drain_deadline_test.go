package mailproto

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"tinycld.org/core/readonly/readonlytest"
)

// A write has no bound of its own, but it cannot hold the stop past the
// terminate's deadline: the process is killed then, and returning first lets
// the finalizer close the database. The stop returns at the deadline with the
// write still running, and logs it at Error.
func TestStopReturnsAtTheDeadlineWithAWriteStillRunning(t *testing.T) {
	setDrainBound(t, 50*time.Millisecond)
	logs := readonlytest.CaptureLogs(t)
	d := newDrain("widget", false)
	write := d.enter(nil, callWrite, admitUntilDrain)
	if write == nil {
		t.Fatal("the write was not admitted")
	}
	t.Cleanup(write.leave)

	end, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() {
		d.shutdown(end)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the stop waited past the deadline for a write in progress")
	}
	if end.Err() == nil {
		t.Fatal("the stop returned before the deadline with a write still running")
	}
	r, ok := readonlytest.Find(logs(), "closing the app under mail writes that did not finish by the terminate's deadline")
	if !ok {
		t.Fatal("the write still running at the deadline was not logged")
	}
	if r.Level != slog.LevelError || r.Attrs["server"] != "widget" {
		t.Fatalf("want an Error naming the server, got %v %v", r.Level, r.Attrs)
	}
}
