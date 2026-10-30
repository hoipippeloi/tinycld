package readonly

import (
	"sync"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
)

// registered holds every app passed to Register that has not terminated. It
// is keyed by appstate.ID, so an app wrapper and the app it wraps count once.
// SIGUSR2 is one signal for the whole process, so it enters the mode for each
// of these apps; a process with one app keeps its standalone behavior.
var (
	registeredMu sync.Mutex
	registered   = map[string]core.App{}
)

func remember(app core.App) {
	id := appstate.ID(app)
	registeredMu.Lock()
	defer registeredMu.Unlock()
	registered[id] = app
}

func forget(app core.App) {
	id := appstate.ID(app)
	registeredMu.Lock()
	defer registeredMu.Unlock()
	delete(registered, id)
}

func registeredApps() []core.App {
	registeredMu.Lock()
	defer registeredMu.Unlock()
	apps := make([]core.App, 0, len(registered))
	for _, app := range registered {
		apps = append(apps, app)
	}
	return apps
}
