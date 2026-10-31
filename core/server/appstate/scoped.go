package appstate

import "github.com/pocketbase/pocketbase/core"

// Scoped prefixes key with the app's ID. Use it for a key in a map that the
// whole process shares and whose entries are short-lived (a sentinel deleted
// right after use, a throttle that sweeps itself): two apps that use the same
// record id or IP then never read or clear each other's entry. State that
// lives as long as the app belongs on the app instead, through a Key.
func Scoped(app core.App, key string) string {
	return ID(app) + "|" + key
}
