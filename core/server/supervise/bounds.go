package supervise

import (
	"strings"
	"time"
)

// The env vars that tell a child how long it has to exit before the
// supervisor kills it: after a SIGTERM (EnvStopBound) and after a drain
// message (EnvDrainBound). The child's terminate shares one deadline across
// all of its waits (tinycld.org/core/shutdown), and it takes that deadline
// from these. Each is a Go duration ("10s").
//
// The supervisor and the child can be different builds, so the values pass
// through the env rather than through a shared constant: a child then fits
// its terminate into the bound of the supervisor that actually runs it. A
// child under a supervisor that sets neither uses the Default bounds below,
// which are what such a supervisor gives.
const (
	EnvStopBound  = "TINYCLD_STOP_BOUND"
	EnvDrainBound = "TINYCLD_DRAIN_BOUND"
)

const (
	// DefaultStopBound is how long a stopped child has after SIGTERM
	// before SIGKILL.
	DefaultStopBound = 10 * time.Second
	// DefaultDrainBound is how long a draining child has to exit before it
	// is killed: its own drain budget plus time to run its shutdown hooks.
	DefaultDrainBound = ChildDrainTimeout + 10*time.Second
)

// boundsEnv is the env entries that pass a supervisor's bounds to a child.
func boundsEnv(stop, drain time.Duration) []string {
	return []string{EnvStopBound + "=" + stop.String(), EnvDrainBound + "=" + drain.String()}
}

// ChildBounds is the child's side of boundsEnv: the time it has after a
// SIGTERM and after a drain message. A value that is missing or does not
// parse as a positive duration falls back to its default.
func ChildBounds(getenv func(string) string) (stop, drain time.Duration) {
	return parseBound(getenv(EnvStopBound), DefaultStopBound),
		parseBound(getenv(EnvDrainBound), DefaultDrainBound)
}

func parseBound(v string, fallback time.Duration) time.Duration {
	d, err := time.ParseDuration(strings.TrimSpace(v))
	if err != nil || d <= 0 {
		return fallback
	}
	return d
}
