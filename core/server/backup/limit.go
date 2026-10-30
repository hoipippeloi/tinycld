package backup

import (
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
)

// The manual-run ceiling is a seam an embedder claims once per app; an app
// nobody claims uses the default. Scheduled runs never count: a ceiling is
// there to stop a person clicking Back up now forty times, not to stop the
// schedule the same person configured.
type limits struct {
	mu      sync.Mutex
	fn      func(core.App) int
	claimed bool
	runs    []time.Time
}

var limitsKey = appstate.NewKey[*limits]("backup.limits")

func limitsOf(app core.App) *limits {
	return limitsKey.GetOrInit(app, func() *limits { return &limits{} })
}

const defaultDailyLimit = 10

// SetDailyLimit claims app's manual-run ceiling. The first caller for an app
// wins, so an embedder cannot have its ceiling replaced by a later import.
func SetDailyLimit(app core.App, fn func(app core.App) int) {
	if fn == nil {
		return
	}
	l := limitsOf(app)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.claimed {
		return
	}
	l.fn, l.claimed = fn, true
}

func dailyLimit(app core.App) int {
	l := limitsOf(app)
	l.mu.Lock()
	fn := l.fn
	l.mu.Unlock()
	if fn == nil {
		return defaultDailyLimit
	}
	return fn(app)
}

// allowManual records the run when it is under app's ceiling. A limit of zero
// or less is no ceiling at all.
func allowManual(app core.App) bool {
	limit := dailyLimit(app)
	l := limitsOf(app)
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := time.Now().Add(-24 * time.Hour)
	kept := l.runs[:0]
	for _, t := range l.runs {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	l.runs = kept
	if limit > 0 && len(l.runs) >= limit {
		return false
	}
	l.runs = append(l.runs, time.Now())
	return true
}
