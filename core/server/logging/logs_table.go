package logging

import (
	"context"
	"log/slog"
)

// logsTableHandler writes duration attributes as text before they reach the
// _logs table. PocketBase stores a record's attributes with encoding/json/v2,
// which has no representation for time.Duration: the whole log entry was
// dropped with "Failed to write log".
type logsTableHandler struct {
	next slog.Handler
}

func newLogsTableHandler(next slog.Handler) slog.Handler {
	return &logsTableHandler{next: next}
}

func (h *logsTableHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *logsTableHandler) Handle(ctx context.Context, r slog.Record) error {
	out := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	r.Attrs(func(a slog.Attr) bool {
		out.AddAttrs(durationsAsText(a))
		return true
	})
	return h.next.Handle(ctx, out)
}

func (h *logsTableHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	converted := make([]slog.Attr, len(attrs))
	for i, a := range attrs {
		converted[i] = durationsAsText(a)
	}
	return &logsTableHandler{next: h.next.WithAttrs(converted)}
}

func (h *logsTableHandler) WithGroup(name string) slog.Handler {
	return &logsTableHandler{next: h.next.WithGroup(name)}
}

func durationsAsText(a slog.Attr) slog.Attr {
	a.Value = a.Value.Resolve()
	switch a.Value.Kind() {
	case slog.KindDuration:
		return slog.String(a.Key, a.Value.Duration().String())
	case slog.KindGroup:
		group := a.Value.Group()
		converted := make([]slog.Attr, len(group))
		for i, g := range group {
			converted[i] = durationsAsText(g)
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(converted...)}
	}
	return a
}
