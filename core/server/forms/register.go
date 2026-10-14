// replace tinycld/core/server/forms/register.go
package forms

import (
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/logging"
)

var log = logging.ForPackage("forms")

type Options struct {
	// HostsPath is the generator's server/form_hosts.json.
	HostsPath string
	// HostsJSON is the embedded fallback for a single-binary build; used when HostsPath is absent.
	HostsJSON []byte
}

// Register reads the host registry and binds the forms hooks. With no hosts
// it stays inert, so a lean shell binds nothing (composition_parity_test).
func Register(app *pocketbase.PocketBase, opts Options) {
	defs, err := LoadHosts(opts.HostsPath)
	if err != nil {
		log.Error("form hosts unreadable, forms disabled", "err", err)
		return
	}
	if len(defs.Hosts) == 0 && len(opts.HostsJSON) > 0 {
		if defs, err = ParseHosts(opts.HostsJSON); err != nil {
			log.Error("embedded form hosts unreadable, forms disabled", "err", err)
			return
		}
	}
	if len(defs.Hosts) == 0 {
		return
	}
	registerCore(app, defs)
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		if err := SeedDefaults(se.App, defs); err != nil {
			log.Error("seed default forms failed", "err", err)
		}
		return se.Next()
	})
}

func registerCore(app core.App, defs *Defs) {
	if len(defs.Hosts) == 0 {
		return
	}
	bindFormsHooks(app, defs)
	bindHostHooks(app, defs)
}
