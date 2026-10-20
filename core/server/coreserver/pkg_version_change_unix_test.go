//go:build unix

package coreserver

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// The drop report's npm pack runs inside a request. A client that gives up
// ends the request, and the pack must end with it: npm can hang on a slow
// registry for minutes, and nothing else stops it. The fake npm here writes a
// heartbeat until it is killed.
func TestDropReport_NpmPackEndsWithTheRequest(t *testing.T) {
	app := backupTestApp(t)

	bin := t.TempDir()
	heartbeat := filepath.Join(t.TempDir(), "heartbeat")
	script := "#!/bin/sh\nwhile :; do echo beat >> '" + heartbeat + "'; sleep 0.05; done\n"
	if err := os.WriteFile(filepath.Join(bin, "npm"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	body := strings.NewReader(`{"slug":"widgets","targetVersion":"2.0.0"}`)
	re := &core.RequestEvent{App: app}
	re.Request = httptest.NewRequest("POST", "/api/admin/packages/versions/drop-report", body).WithContext(ctx)
	re.Response = httptest.NewRecorder()

	done := make(chan error, 1)
	go func() { done <- handleDropReport(app, re) }()

	deadline := time.Now().Add(10 * time.Second)
	for heartbeatSize(heartbeat) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the drop report never ran npm pack")
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the drop report still waits on npm pack after its request ended")
	}
	time.Sleep(200 * time.Millisecond)
	before := heartbeatSize(heartbeat)
	time.Sleep(300 * time.Millisecond)
	if after := heartbeatSize(heartbeat); after != before {
		t.Fatalf("npm pack still runs after the request ended (heartbeat %d -> %d bytes)", before, after)
	}
}

func heartbeatSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}
