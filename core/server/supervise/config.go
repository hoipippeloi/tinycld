package supervise

import (
	"errors"
	"strings"
	"time"
)

// defaultHTTPAddr is the plain-HTTP bind when HTTP_ADDR is unset: an
// unprivileged port that a reverse proxy or a Docker port mapping fronts.
const defaultHTTPAddr = "0.0.0.0:7090"

// The ports autocert mode holds: :443 for HTTPS, :80 for the ACME HTTP-01
// challenge and the redirect to HTTPS.
const (
	autocertHTTPSAddr = "0.0.0.0:443"
	autocertHTTPAddr  = "0.0.0.0:80"
)

// childRestartExitCode is what a server child exits with to ask for a
// restart when it has no control socket or got no ack for its restart
// message (coreserver's restartExitCode).
const childRestartExitCode = 75

// portWant is one listener a child should get: its inherited-fd name and
// the address to bind.
type portWant struct {
	name, addr string
}

// config is what the supervisor reads from its environment once, at start.
type config struct {
	stateDir string
	// childArgs is the full argument list after the binary: serve, the
	// caller's directory flags, then the mode's domains and flags.
	childArgs []string
	// base is the main HTTP(S) listeners, before any package's ports.
	base []portWant
}

// readConfig applies the entrypoint's serve-mode rules. Autocert mode needs
// both AUTOCERT_ENABLED and PRIMARY_DOMAIN; with only the first, it serves
// plain HTTP, as the entrypoint did. Domain validation stays in the
// entrypoint, which runs before this.
func readConfig(args []string, getenv func(string) string) (config, error) {
	cfg := config{stateDir: strings.TrimSpace(getenv("TINYCLD_STATE_DIR"))}
	if cfg.stateDir == "" {
		return config{}, errors.New("TINYCLD_STATE_DIR is not set; the supervisor needs it to find the current build")
	}

	cfg.childArgs = append([]string{"serve"}, args...)
	primary := strings.TrimSpace(getenv("PRIMARY_DOMAIN"))
	autocert := autocertOn(getenv("AUTOCERT_ENABLED"))

	if autocert && primary != "" {
		cfg.childArgs = append(cfg.childArgs, primary)
		for _, d := range strings.Split(getenv("ADDITIONAL_DOMAINS"), ",") {
			if d = strings.TrimSpace(d); d != "" {
				cfg.childArgs = append(cfg.childArgs, d)
			}
		}
		// PocketBase serves TLS on the main listener only when --https is
		// set; with --http alone it would serve plain HTTP on :443.
		cfg.childArgs = append(cfg.childArgs, "--http="+autocertHTTPAddr, "--https="+autocertHTTPSAddr)
		cfg.base = []portWant{{ListenerHTTPS, autocertHTTPSAddr}, {ListenerHTTPRedirect, autocertHTTPAddr}}
		return cfg, nil
	}

	if autocert {
		log.Warn("AUTOCERT_ENABLED is set but PRIMARY_DOMAIN is empty; serving plain HTTP")
	}
	addr := strings.TrimSpace(getenv("HTTP_ADDR"))
	if addr == "" {
		addr = defaultHTTPAddr
	}
	cfg.childArgs = append(cfg.childArgs, "--http="+addr)
	cfg.base = []portWant{{ListenerHTTP, addr}}
	return cfg, nil
}

func autocertOn(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// options are the supervisor's time bounds and the user its children run
// as. They are fields rather than constants so tests can change them.
type options struct {
	// readyTimeout is how long a new child has to send ready: the same 60 s
	// the entrypoint's health probe allowed a cold boot that runs
	// migrations and seeds packages.
	readyTimeout time.Duration
	// drainBound is how long a draining child has to exit before it is
	// killed: its own drain budget plus time to run its shutdown hooks.
	drainBound time.Duration
	// stopBound is how long a stopped child has after SIGTERM before
	// SIGKILL.
	//
	// A child's terminate chain waits in sequence, each wait bounded on its
	// own. In chain order:
	//   - a package operation (coreserver rebuildStopPriority, first in the
	//     chain): the cancel kills its build commands, then a wait of 2 s
	//     (rebuildCancelGrace) for a job still building, or 6 s
	//     (rebuildTailStopBound) for one in its database tail. It claims the
	//     same interlock as a backup run, so it never waits beside one.
	//   - the realtime stop (realtime suspendBudget, 10 s). In read-only
	//     mode, which covers a supervised rebuild's whole tail, it has no
	//     final pass to make and returns at once.
	//   - PocketBase's HTTP shutdown (1 s), the mail protocol servers' drain
	//     (mailproto drainBound, 5 s, all servers at once, plus any write in
	//     progress), a backup run (coreserver backupStopBound, 8 s), tail
	//     writes (readonly tailStopBound, 5 s) and the automation worker
	//     (automation shutdownDrainWait, 5 s).
	// Their worst cases add up to more than 30 s, far more than this bound, and
	// the realtime stop's 10 s alone uses all of it. Each worst case is stuck
	// work, and they seldom coincide; when they do, SIGKILL ends the child
	// with the database open, which SQLite's journal survives, and only the
	// cut-off wait's warning and its unfinished write are lost. A rebuild
	// SIGKILLed after its migration sync but before it armed its backup is
	// the one loss this bound can cause that a later boot does not repair.
	// The fix that makes the chain fit is one deadline per terminate, shared
	// by every wait (each takes the lesser of its own bound and what is
	// left), not a longer bound per wait. Until then a new wait must fit in
	// what is left, not add to the sum. The background job runners
	// (tinycld.org/core/background) also wait, with no bound of their own:
	// each cancels its jobs' ctx first, so the wait is the database writes
	// those jobs have in progress.
	stopBound time.Duration
	// childUser is who children run as when the supervisor runs as root:
	// the user the entrypoint's gosu dropped to.
	childUser string
}

func defaultOptions() options {
	return options{
		readyTimeout: 60 * time.Second,
		drainBound:   ChildDrainTimeout + 10*time.Second,
		stopBound:    10 * time.Second,
		childUser:    "tinycld",
	}
}
