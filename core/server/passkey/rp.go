package passkey

import (
	"errors"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/pocketbase/pocketbase/core"
)

const ceremonyTimeout = 5 * time.Minute

var errBadOrigin = errors.New("passkey: request origin does not match this server")

// relyingParty builds the WebAuthn config for the host this request reached.
//
// The relying party is the host itself. One deployment can answer on more
// than one name (its own and a custom domain), and each name is its own RP:
// a passkey made on one name works only on that name, which is what the
// browser enforces anyway. The browser's Origin header names the page that
// runs the ceremony; it must be this same host, so a page on another site
// cannot drive a ceremony here.
func relyingParty(app core.App, re *core.RequestEvent) (*webauthn.WebAuthn, error) {
	origin, host, err := ceremonyOrigin(re, requestHosts(app, re))
	if err != nil {
		return nil, err
	}
	name := app.Settings().Meta.AppName
	if name == "" {
		name = host
	}
	return webauthn.New(&webauthn.Config{
		RPID:          host,
		RPDisplayName: name,
		RPOrigins:     []string{origin},
		Timeouts: webauthn.TimeoutsConfig{
			Login:        webauthn.TimeoutConfig{Enforce: true, Timeout: ceremonyTimeout},
			Registration: webauthn.TimeoutConfig{Enforce: true, Timeout: ceremonyTimeout},
		},
	})
}

// requestHosts is the host the request was sent to, plus X-Forwarded-Host
// when the admin has listed it as a trusted proxy header (Settings → trusted
// proxy). Without that, a client could name any host it likes in the header.
func requestHosts(app core.App, re *core.RequestEvent) []string {
	hosts := []string{re.Request.Host}
	for _, h := range app.Settings().TrustedProxy.Headers {
		if strings.EqualFold(h, "X-Forwarded-Host") {
			hosts = append(hosts, re.Request.Header.Get("X-Forwarded-Host"))
		}
	}
	return hosts
}

// ceremonyOrigin returns the Origin header and its host name when that host
// is one the request was sent to.
func ceremonyOrigin(re *core.RequestEvent, hosts []string) (origin string, host string, err error) {
	origin = re.Request.Header.Get("Origin")
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return "", "", errBadOrigin
	}
	host = parsed.Hostname()
	if parsed.Scheme == "http" && host != "localhost" {
		// WebAuthn runs only in a secure context; plain http is allowed for
		// localhost in development and nowhere else.
		return "", "", errBadOrigin
	}
	for _, candidate := range hosts {
		if candidate != "" && strings.EqualFold(hostOnly(candidate), host) {
			return parsed.Scheme + "://" + parsed.Host, host, nil
		}
	}
	return "", "", errBadOrigin
}

func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return h
	}
	return hostport
}
