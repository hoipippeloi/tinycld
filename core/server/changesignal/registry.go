// Package changesignal tells realtime clients that a collection changed,
// and never what changed.
//
// After a record write commits, core sends a message on the topic
// `collection/<name>` to every signed-in realtime client subscribed to it.
// The payload is `{}`: any signed-in client may subscribe to any topic, so a
// message must carry no data. A client that gets one runs its query again
// under its own rules. Messages are coalesced per topic, so a batch of
// writes sends one.
//
// Packages feed it in two ways, from their own Register(app):
//   - RegisterView declares the collections a view collection's SQL reads,
//     so a write to any of them also signals the view's topic. PocketBase's
//     view parser reads only the outer FROM and JOIN, so the declared list is
//     authoritative; CheckViews proves it against SQLite's bytecode in the
//     package's tests.
//   - Touch signals a collection after a raw-SQL write, which runs no model
//     hook.
//
// Core names no package; tests use fictional zoo_* collections.
package changesignal

import (
	"fmt"
	"slices"
	"sort"
	"sync"
)

const topicPrefix = "collection/"

// Topic is the change-signal topic of a collection.
func Topic(collection string) string {
	return topicPrefix + collection
}

var (
	mu    sync.RWMutex
	views = map[string][]string{}
)

// RegisterView declares the collections that the view collection's SQL
// reads, in a subquery, an EXISTS or a CTE included. The view and its
// sources are collection names, not ids. A write to any source
// then also signals the view's topic. Calling it again for the same view
// adds sources. A blank name, no sources, or a view that lists itself panics
// at boot, because such a view could never be live.
func RegisterView(view string, sources ...string) {
	if view == "" || len(sources) == 0 {
		panic(fmt.Sprintf("changesignal.RegisterView(%q): a view needs a name and at least one source", view))
	}
	mu.Lock()
	defer mu.Unlock()
	set := map[string]bool{}
	for _, source := range views[view] {
		set[source] = true
	}
	for _, source := range sources {
		if source == "" || source == view {
			panic(fmt.Sprintf("changesignal.RegisterView(%q): invalid source %q", view, source))
		}
		set[source] = true
	}
	merged := make([]string, 0, len(set))
	for source := range set {
		merged = append(merged, source)
	}
	sort.Strings(merged)
	views[view] = merged
}

// RegisteredViews returns a copy of the registry: view name to sorted sources.
func RegisteredViews() map[string][]string {
	mu.RLock()
	defer mu.RUnlock()
	out := make(map[string][]string, len(views))
	for view, sources := range views {
		out[view] = slices.Clone(sources)
	}
	return out
}

// topicsFor returns the topics a write to collection signals: its own, then
// every registered view that reads it, directly or through another view.
func topicsFor(collection string) []string {
	mu.RLock()
	defer mu.RUnlock()
	seen := map[string]bool{collection: true}
	queue := []string{collection}
	var viewTopics []string
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for view, sources := range views {
			if seen[view] || !slices.Contains(sources, current) {
				continue
			}
			seen[view] = true
			viewTopics = append(viewTopics, Topic(view))
			queue = append(queue, view)
		}
	}
	sort.Strings(viewTopics)
	return append([]string{Topic(collection)}, viewTopics...)
}

// coveredBy returns the collections a view may read: its declared sources
// and, for a source that is itself a registered view, that view's own.
// SQLite inlines a view it reads, so its bytecode opens the base tables.
func coveredBy(view string) map[string]bool {
	mu.RLock()
	defer mu.RUnlock()
	covered := map[string]bool{}
	var walk func(string)
	walk = func(name string) {
		for _, source := range views[name] {
			if covered[source] {
				continue
			}
			covered[source] = true
			walk(source)
		}
	}
	walk(view)
	return covered
}

// ResetForTesting empties the registry. Tests register their own views.
func ResetForTesting() {
	mu.Lock()
	defer mu.Unlock()
	views = map[string][]string{}
}
