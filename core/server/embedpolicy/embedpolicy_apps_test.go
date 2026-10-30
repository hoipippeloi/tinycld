package embedpolicy

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func newApp(t *testing.T) core.App {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

// A resolver answers from its own app's data. Another app's request must
// never run it: the lookup would read the wrong database, and a token that
// matched there would grant framing here.
func TestResolversAreKeptPerApp(t *testing.T) {
	a, b := newApp(t), newApp(t)
	ranForB := false
	Register(a, func(r *http.Request) []string {
		return []string{"https://a.example.com"}
	})
	Register(b, func(r *http.Request) []string {
		ranForB = true
		return nil
	})

	req := httptest.NewRequest("GET", "/p/x/tok?embed=1", nil)
	if got := FrameAncestors(a, req); got != "https://a.example.com" {
		t.Errorf("FrameAncestors(A) = %q, want A's origin", got)
	}
	if ranForB {
		t.Error("app B's resolver ran for app A's request")
	}
	if got := FrameAncestors(b, req); got != "'none'" {
		t.Errorf("FrameAncestors(B) = %q, want 'none': A's resolver answered for B", got)
	}
	if got := FrameAncestors(newApp(t), req); got != "'none'" {
		t.Errorf("FrameAncestors(app with no resolver) = %q, want 'none'", got)
	}
}
