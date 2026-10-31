package coreserver

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"syscall"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"

	"github.com/pocketbase/pocketbase/tools/router"
	"tinycld.org/core/logging"
	"tinycld.org/core/syscfg"
)

// initSentryFromConfig (re)binds app's Sentry client from the current system
// settings. Safe to call repeatedly: the new client replaces the old one on
// the app's hub, so a DSN change applied here takes effect immediately for
// subsequent captures. Other apps in the process keep their own clients.
//
// Reads through syscfg rather than SystemConfig directly: on a deployment whose
// operator owns error reporting, the DSN is theirs and never reaches this
// deployment's own collection.
func initSentryFromConfig(app core.App) {
	logging.InitAppSentry(app, syscfg.Get(app, "sentry.dsn"))
}

// registerSentryMiddlewareCore binds the per-request capture logic. Takes
// core.App (not *pocketbase.PocketBase) so tests can drive it against
// tests.TestApp without invoking the global Init. registerSharedMiddleware
// calls this after readonly.Register, so Sentry's middleware sees every
// route added after shared registration; must still run before any OnServe
// handlers register routes of their own — middleware bound after a route is
// added does not apply to it.
//
// The Sentry CLIENT itself is initialized later, by RegisterSystemConfig, once
// the system_settings collection is loaded — the DSN comes from there, not an env
// var. Until then (and whenever the DSN is empty) the SDK is a no-op: events drop,
// the middleware still runs, and panic recovery still re-panics so PB's normal 500
// path is unaffected. initSentryFromConfig binds the app's client and is reused
// for live re-init when the DSN changes.
func registerSentryMiddlewareCore(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		e.Router.Bind(&hook.Handler[*core.RequestEvent]{
			Id:       appContextMiddlewareId,
			Priority: appContextMiddlewarePriority,
			Func:     appContextMiddleware,
		})
		e.Router.BindFunc(sentryMiddleware)
		return e.Next()
	})
}

const (
	appContextMiddlewareId = "tinycldAppContext"
	// Before every other middleware, PocketBase's included, so whatever they
	// log with the request's ctx is filed under this app.
	appContextMiddlewarePriority = apis.DefaultWWWRedirectMiddlewarePriority - 1
)

// appContextMiddleware names the serving app on the request's ctx. A handler
// that logs with that ctx then writes to this app's _logs table, even when
// other apps share the process. Bound in the same OnServe handler as the
// Sentry middleware, so the composition's hook counts do not change.
func appContextMiddleware(re *core.RequestEvent) error {
	re.Request = re.Request.WithContext(logging.WithApp(re.Request.Context(), re.App))
	return re.Next()
}

// sentrySkipPaths are request paths fully excluded from Sentry — no
// breadcrumbs and no error/5xx capture. Liveness and health probes hit
// often enough that a flapping dependency or a mid-rollout deploy would
// drown real signal otherwise. PB serves /api/health by default; other
// probe paths can be added at test time.
var sentrySkipPaths = map[string]bool{
	"/api/health": true,
}

func sentryMiddleware(re *core.RequestEvent) error {
	path := re.Request.URL.Path
	if sentrySkipPaths[path] {
		return re.Next()
	}

	// A clone of this app's hub: its client and tags are this app's, and the
	// user set below stays on this one request.
	hub := logging.Hub(re.App).Clone()
	ctx := sentry.SetHubOnContext(re.Request.Context(), hub)
	re.Request = re.Request.WithContext(ctx)

	method := re.Request.Method

	hub.Scope().SetTag("http.method", method)
	hub.Scope().SetTag("http.route", path)
	if re.Auth != nil {
		hub.Scope().SetUser(sentry.User{ID: re.Auth.Id})
	}

	sniff := &errorBodySniffer{ResponseWriter: re.Response}
	re.Response = sniff

	defer func() {
		if r := recover(); r != nil {
			hub.RecoverWithContext(ctx, r)
			hub.Flush(2 * time.Second)
			panic(r)
		}
	}()

	err := re.Next()

	status := re.Status()

	hub.AddBreadcrumb(&sentry.Breadcrumb{
		Type:     "http",
		Category: "request",
		Data: map[string]any{
			"method": method,
			"path":   path,
			"status": status,
		},
		Level: sentry.LevelInfo,
	}, nil)

	if err != nil {
		var apiErr *router.ApiError
		if errors.As(err, &apiErr) && apiErr.Status < 500 {
			return err
		}
		if clientDisconnected(re.Request.Context(), err) || answeredBeforeError(status) {
			return err
		}
		captureErr := err
		if apiErr != nil {
			if raw, ok := apiErr.RawData().(error); ok {
				captureErr = raw
			}
		}
		hub.CaptureException(captureErr)
		return err
	}

	if status >= 500 {
		hub.WithScope(func(scope *sentry.Scope) {
			scope.SetLevel(sentry.LevelError)
			scope.SetTag("http.status", fmt.Sprintf("%d", status))
			if body := sniff.Body(); body != "" {
				scope.SetContext("response", map[string]any{"body": body})
			}
			hub.CaptureMessage(fmt.Sprintf("HTTP %d %s %s", status, method, path))
		})
	}

	return nil
}

// clientDisconnected reports whether err only says that the client went away
// before the response was written. The server did nothing wrong, so these get
// no Sentry event. A write to a socket the client closed fails with a broken
// pipe or a reset. HTTP/2 instead fails with errors no caller can match
// ("http2: stream closed", "client disconnected"), but it cancels the
// request's context first, so a done context marks the client as gone.
func clientDisconnected(ctx context.Context, err error) bool {
	if errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET) {
		return true
	}
	return ctx.Err() != nil
}

// answeredBeforeError reports whether the handler wrote its own answer, a
// bodiless 204 or a 4xx, before it returned an error. PocketBase does this on
// purpose: an unknown email in a password reset gets a 204 so that no one can
// probe which emails have accounts, and an MFA sign-in gets its 401 first. The
// error is only for the request log. A 2xx with a body is not included: an
// error then can be a failure part-way through the body.
func answeredBeforeError(status int) bool {
	return status == http.StatusNoContent || (status >= 400 && status < 500)
}

// errorBodySniffer wraps an http.ResponseWriter to capture the first chunk
// of the response body when status is >= 500. Handlers that call
// http.Error or write a short text/plain message directly to the writer
// (the go-webdav CalDAV path is one) bypass PB's error mapping, so the
// only signal a router-level middleware can attach to is the body itself.
//
// We only retain the body when status >= 500 — error responses are short,
// and capturing successful responses would waste memory and risk PII.
//
// All Write/WriteHeader calls pass through to the underlying writer
// unchanged; this is purely an observer.
type errorBodySniffer struct {
	http.ResponseWriter
	status  int
	capture bool
	buf     strings.Builder
}

const errorBodyCaptureLimit = 4096

func (w *errorBodySniffer) WriteHeader(code int) {
	w.status = code
	w.capture = code >= 500
	w.ResponseWriter.WriteHeader(code)
}

func (w *errorBodySniffer) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	if w.capture && w.buf.Len() < errorBodyCaptureLimit {
		remaining := errorBodyCaptureLimit - w.buf.Len()
		chunk := p
		if len(chunk) > remaining {
			chunk = chunk[:remaining]
		}
		w.buf.Write(chunk)
	}
	return w.ResponseWriter.Write(p)
}

// Body returns the captured response body when status was >= 500, with
// trailing whitespace trimmed (http.Error appends a trailing newline).
// Returns the empty string when nothing was captured.
func (w *errorBodySniffer) Body() string {
	return strings.TrimRight(w.buf.String(), "\r\n")
}

// Unwrap exposes the underlying ResponseWriter so PB's getStatus and
// getWritten helpers (and http.ResponseController) can walk past this
// wrapper to PB's own status/write tracker. Without it, re.Status()
// would return 0 even after a 500 was written.
func (w *errorBodySniffer) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// Flush, Hijack, and Push forward to the underlying ResponseWriter when it
// implements the corresponding optional interface. PB's own ResponseWriter
// supports all three; without these passthroughs, a streaming handler (e.g.
// backup_api.go's download) would silently lose flush/hijack capability.
func (w *errorBodySniffer) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *errorBodySniffer) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := w.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, http.ErrNotSupported
}

func (w *errorBodySniffer) Push(target string, opts *http.PushOptions) error {
	if p, ok := w.ResponseWriter.(http.Pusher); ok {
		return p.Push(target, opts)
	}
	return http.ErrNotSupported
}
