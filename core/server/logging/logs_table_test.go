package logging

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/tools/types"
)

// recordingHandler keeps the attributes each record reaches it with.
type recordingHandler struct {
	attrs []slog.Attr
	got   *[]map[string]any
}

func (h *recordingHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *recordingHandler) Handle(_ context.Context, r slog.Record) error {
	data := map[string]any{}
	add := func(a slog.Attr) {
		if a.Value.Kind() == slog.KindGroup {
			group := map[string]any{}
			for _, g := range a.Value.Group() {
				group[g.Key] = g.Value.Any()
			}
			data[a.Key] = group
			return
		}
		data[a.Key] = a.Value.Any()
	}
	for _, a := range h.attrs {
		add(a)
	}
	r.Attrs(func(a slog.Attr) bool {
		add(a)
		return true
	})
	*h.got = append(*h.got, data)
	return nil
}

func (h *recordingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &recordingHandler{attrs: append(append([]slog.Attr{}, h.attrs...), attrs...), got: h.got}
}

func (h *recordingHandler) WithGroup(string) slog.Handler { return h }

// The _logs table stores attributes as a PocketBase JSONMap; a duration must
// reach it in a form that map can marshal.
func TestLogsTableHandlerWritesDurationsAsText(t *testing.T) {
	var got []map[string]any
	logger := slog.New(newLogsTableHandler(&recordingHandler{got: &got})).With("timeout", 2*time.Second)
	logger.Error("restart", "waited", 15*time.Second, slog.Group("retry", "after", time.Minute), "count", 3)

	if len(got) != 1 {
		t.Fatalf("got %d records, want 1", len(got))
	}
	data := got[0]
	if data["timeout"] != "2s" || data["waited"] != "15s" || data["count"] != int64(3) {
		t.Fatalf("attributes = %#v", data)
	}
	if retry, _ := data["retry"].(map[string]any); retry["after"] != "1m0s" {
		t.Fatalf("group attribute = %#v", data["retry"])
	}
	if _, err := types.JSONMap[any](data).MarshalJSON(); err != nil {
		t.Fatalf("the _logs table cannot store the attributes: %v", err)
	}
}
