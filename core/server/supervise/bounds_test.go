package supervise

import (
	"strings"
	"testing"
	"time"
)

func envOf(entries []string) func(string) string {
	return func(key string) string {
		for _, kv := range entries {
			if k, v, ok := strings.Cut(kv, "="); ok && k == key {
				return v
			}
		}
		return ""
	}
}

// What the supervisor passes is what the child reads: the child fits its
// terminate into the bounds of the supervisor that runs it.
func TestChildBounds_ReadsWhatTheSupervisorPasses(t *testing.T) {
	stop, drain := ChildBounds(envOf(boundsEnv(7*time.Second, 25*time.Second)))
	if stop != 7*time.Second || drain != 25*time.Second {
		t.Fatalf("ChildBounds = %v, %v; want 7s, 25s", stop, drain)
	}
}

// A supervisor that passes no bounds (an older build) gives the defaults,
// and so does a value that does not parse or is not positive.
func TestChildBounds_FallsBackToTheDefaults(t *testing.T) {
	for _, env := range [][]string{
		nil,
		{EnvStopBound + "=soon", EnvDrainBound + "=later"},
		{EnvStopBound + "=0s", EnvDrainBound + "=-5s"},
	} {
		stop, drain := ChildBounds(envOf(env))
		if stop != DefaultStopBound || drain != DefaultDrainBound {
			t.Errorf("ChildBounds(%v) = %v, %v; want the defaults %v, %v",
				env, stop, drain, DefaultStopBound, DefaultDrainBound)
		}
	}
}
