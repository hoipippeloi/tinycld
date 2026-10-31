package realtime

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
)

func TestSafeFlushTurnsAPanicIntoAnError(t *testing.T) {
	c := NewSaveCoordinator(coordApp(t), func(context.Context, string, DocHandle) error {
		panic("exporter exploded")
	})
	c.SetLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))

	err := c.safeFlush(context.Background(), "item-1", nil)
	if err == nil || !strings.Contains(err.Error(), "panicked") {
		t.Fatalf("safeFlush = %v, want a panicked error", err)
	}
}

func TestRecoverGoroutineSwallowsThePanic(t *testing.T) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer recoverGoroutine("test connection", "kind", "zoo", "roomID", "r1")
		panic("room hook exploded")
	}()
	<-done
}
