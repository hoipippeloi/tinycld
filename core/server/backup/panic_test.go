package backup

import (
	"sync/atomic"
	"testing"

	"tinycld.org/core/readonly/readonlytest"
)

func TestProgressWriterPanicIsLoggedNotFatal(t *testing.T) {
	logs := readonlytest.CaptureLogs(t)
	app := newTestApp(t)
	row := runningBackupRow(t, app)
	progressTickForTesting = func() { panic("progress tick exploded") }
	t.Cleanup(func() { progressTickForTesting = nil })

	var total atomic.Int64
	p := newProgress(app, row, total.Load)
	<-p.done
	p.stop()

	if _, ok := readonlytest.Find(logs(), "goroutine panicked"); !ok {
		t.Fatal("the progress writer's panic was not logged")
	}
}

func TestExpiryWatcherPanicIsLoggedNotFatal(t *testing.T) {
	logs := readonlytest.CaptureLogs(t)
	app := newTestApp(t)
	row := runningBackupRow(t, app)
	expiryTickForTesting = func() { panic("expiry tick exploded") }
	t.Cleanup(func() { expiryTickForTesting = nil })

	w := newExpiryWatcher(app, row, stalledSource{offset: 7})
	<-w.done
	w.stop()

	if _, ok := readonlytest.Find(logs(), "goroutine panicked"); !ok {
		t.Fatal("the expiry watcher's panic was not logged")
	}
}
