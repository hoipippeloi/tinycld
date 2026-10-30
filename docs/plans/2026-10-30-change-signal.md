# Change Signal and Live Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a write commits, core sends a data-free realtime message per collection (`collection/<name>`), and pbtsdb gives clients a way to listen (`subscribeTopic`) and to keep a collection live on those messages (`liveTopics`), so reports and view collections update when another user writes.

**Architecture:** A new core Go package `changesignal` binds the three `OnModelAfter*Success` hooks (PocketBase runs them after the commit), turns the written collection into topics (its own and those of every registered view that reads it), coalesces per topic over 200 ms and sends `{}` to every authenticated client subscribed to the topic through `app.SubscriptionsBroker()`. `Touch` covers raw-SQL writers (transaction aware); `RegisterView` declares a view's sources; `CheckViews` proves the declaration against SQLite `EXPLAIN` bytecode. pbtsdb adds `subscribeTopic(pb, topic, onMessage)` on its shared realtime connection and a `liveTopics` collection option that calls the existing `reload()`. Core TS pins the new pbtsdb and adds a two-function topic helper.

**Tech Stack:** Go (PocketBase fork v0.40.4 at `tinycld/third_party/pocketbase`, modernc SQLite), TypeScript, pbtsdb (vitest against stock PocketBase 0.40.4 on 127.0.0.1:8210), Biome.

**Spec:** `/Users/nas/code/tinycld/docs/superpowers/specs/2026-10-30-report-engine-design.md`, section "## 1. Change signal and live views", the Testing bullets "Change signal" and "pbtsdb", the Risks line about raw SQL writes, and Security ("Change-signal messages carry no data"). Read-only: never edit anything under `/Users/nas/code/tinycld`.

**Repos and paths:**
- Workspace root: `/Users/nas/tmp/tinycld/books-purchases` (shortened below as `$WS`).
- Core repo: `$WS/tinycld`, branch `books/p5-change-signal`. Core Go module `tinycld.org/core` at `$WS/tinycld/core/server`.
- pbtsdb clone: `/Users/nas/tmp/tinycld/books-purchases-pbtsdb` (shortened as `$PBTSDB`), branch `books/p5-change-signal`, from 2.0.6 (`a5c45d8`).
- Do not touch the `books` member.

## Global Constraints

- Topics are `collection/<name>`; a report subscribes to the topics of every collection its compiled query reads.
- Hooks: `OnModelAfterCreateSuccess`, `OnModelAfterUpdateSuccess`, `OnModelAfterDeleteSuccess` (they run after the transaction commits).
- Send through `app.SubscriptionsBroker()`; coalesce per topic over 200 ms so a batch of writes sends one message.
- The message never carries record data; a test asserts it.
- Raw SQL writes (`app.DB()` execute, migrations) fire no hooks; code that writes report sources with raw SQL calls `changesignal.Touch(app, collection)`.
- `changesignal.RegisterView(view, sources...)`; the declared list is authoritative; the `EXPLAIN` (`OpenRead` root pages) check fails a test when a view reads an undeclared collection.
- pbtsdb: public `subscribeTopic` and collection option `liveTopics` that calls the existing `collection.reload()` on a message, debounced.
- No fork change: hooks, the broker and custom topics are upstream PocketBase behavior.
- Core names no package; tests use fictional `zoo_*` collections. `pnpm run check:core-isolation` must stay green.
- Go code logs through `logging.ForPackage("changesignal")`; TS code never uses `console.*`; no `any`; no `biome-ignore`.
- New pbtsdb version: **2.1.0** (new public API, no break). Its pin goes in `$WS/tinycld/core/package-versions.json` only, plus core's own `peerDependencies` range (CONTRIBUTING "Vendor version pins").
- Merging the pbtsdb PR and publishing to npm are human-gated (Task 9).

## Decisions this plan makes (read before Task 1)

1. **Every collection gets signals, not only registered ones.** The spec says a report subscribes to "the topics of every collection its compiled query reads"; the compiled query reads rule-CTE collections too (Security: "Every touched collection's list rule applies"), and those are not report sources. So every record write signals its collection's topic. Cost per write: one cached collection lookup and one map check; a topic with no subscriber sends nothing.
2. **Payload is the two bytes `{}`, not empty bytes.** Probed: pbtsdb's dispatcher (`$PBTSDB/src/realtime-client.ts`, `dispatcherFor`) runs `JSON.parse(String(message.data))` and silently drops an event whose data is not JSON, and the fork's resumable client (`third_party/pocketbase/tools/subscriptions/resumable_tinycld.go`, `withSeq`) adds its `"seq"` only to a JSON object payload. So the payload is the empty JSON object; after the fork adds its sequence a resumable client receives `{"seq":N}`. Neither carries record data. The topic is the SSE event name.
3. **Only authenticated clients receive signals.** The spec says any client may subscribe to any topic, which is why the payload is empty. The timing of writes is still information (when `users` or a ledger changes), and nothing in scope needs a signed-out listener (public report links are out of scope). The send skips a client whose `apis.RealtimeClientAuthKey` is unset. This is reported to the human for confirmation; reverting it is deleting one `if`.
4. **A view's topic carries its sources' writes (server fan-out).** `RegisterView("v", "a", "b")` makes a write to `a` or `b` signal `collection/v` too. The client keeps the view live with `liveTopics: ['collection/v']` and needs no copy of the source list, so the Go registration (which `CheckViews` verifies) is the only list. A view of a registered view is signaled transitively.
5. **`subscribeTopic` takes `pb` first:** `subscribeTopic(pb, topic, onMessage)`. pbtsdb keeps one realtime connection per `PocketBase` instance (`$PBTSDB/src/transport.ts`, `entries` WeakMap), and every public realtime function takes `pb` first (`resetRealtime(pb)`, `disconnectRealtime(pb)`).
6. **Debounce is a coalescing window from the first message (100 ms), not a trailing debounce.** A trailing debounce never fires while messages keep arriving faster than its delay; a window from the first message bounds latency to 100 ms plus the fetch, and `reload()` already queues one follow-up when a message arrives during a fetch (`$PBTSDB/src/sync-adapter.ts`, `reload`).
7. **Core has no view collections today** (`grep viewQuery` over `tinycld/core/server/pb_migrations` and `tinycld/server/pb_migrations`: none). Core TS therefore only pins pbtsdb 2.1.0 and adds `collectionTopic` / `liveViewOptions` (`core/lib/change-signal.ts`) for the next units (`p5-report-engine`, `p5-report-builder`) and for packages with views.
8. **No in-app help topic.** Nothing here is user-facing; the user sees a report or a view update, which those units document.

## What was probed (facts the tasks rely on)

- **Hook order vs commit** (Go probe on `tests.NewTestApp()`): a record saved inside `RunInTransaction` that returns an error fires no `OnModelAfterCreateSuccess`; a committed one fires it after `RunInTransaction` returns, not during, with `e.App.IsTransactional() == false`. Source: `third_party/pocketbase/core/db.go:347-365` (`txInfo.OnComplete`). A raw `app.DB().NewQuery("INSERT …").Execute()` fires nothing.
- **Collection saves** fire the model hooks with `*core.Collection` (`TableName() == "_collections"`), which is not a collection, so the collection lookup skips them.
- **Broker:** a `subscriptions.DefaultClient` subscribed to `collection/zoo_animals` received a `Message{Name: "collection/zoo_animals", Data: []byte("{}")}` sent with `go client.Send(...)`. `DefaultClient.Send` blocks on an unbuffered channel, so each send runs in its own goroutine (`routine.FireAndForget`). `client.HasSubscription(topic)` is an exact match on the subscription string.
- **EXPLAIN PoC works.** `EXPLAIN SELECT * FROM {{view}}` returns columns `addr opcode p1 p2 p3 p4 p5 comment`. Each `OpenRead` has the root page in `p2`; `SELECT rootpage, tbl_name FROM sqlite_schema WHERE rootpage > 0` maps a page to its table, for tables and for indexes. For a view `SELECT a.id, a.name, (SELECT SUM(f.grams) FROM zoo_feedings f WHERE f.animal = a.id) AS grams FROM zoo_animals a WHERE EXISTS (SELECT 1 FROM zoo_keepers k WHERE k.animal = a.id)` the reads were `zoo_animals` (table), `zoo_feedings` (through the covering index `idx_feed_animal` only) and `zoo_keepers` (table). A view of that view (with a CTE) resolved to the same three base tables. CTEs add `OpenEphemeral`/`OpenAutoindex`, which have no root page and are ignored.
- **PocketBase's view parser refuses `UNION ALL`** in a view query; subquery columns and `EXISTS` are accepted. Test views below use only the accepted forms.
- **pbtsdb test server:** stock `pocketbase` 0.40.4 (`/opt/homebrew/bin/pocketbase`), started by `npm test` through `start-server-and-test`, which also stops it. It needs `$PBTSDB/.env` (gitignored; created from `.env.sample` during probing — if missing, `cp .env.sample .env`). A JSVM hook sending `new SubscriptionMessage({ name: topic, data: '{}' })` to `$app.subscriptionsBroker().clients()` that `hasSubscription(topic)` reached a listener registered through `realtimeClientFor(pb).subscribe('collection/authors', …)`, so a stock server can stand in for core in pbtsdb tests.
- **Composition tripwire:** `core/server/coreserver/composition_parity_test.go` holds golden hook counts for `Register`; adding three model hooks moves `OnModelAfterCreateSuccess` 4→5, `OnModelAfterUpdateSuccess` 4→5, `OnModelAfterDeleteSuccess` 3→4.
- **Topic namespace:** PocketBase matches record subscriptions by the prefix `<collectionNameOrId>/`. A topic `collection/x` would also get record events only from a collection named `collection`; none exists, and package collections carry their slug prefix.

## Review Focus

1. A raw-SQL write inside a transaction that rolls back, with `Touch` already called → no message (Task 3 test `TestTouchInsideRolledBackTransactionSendsNothing`).
2. A steady stream of writes, one every quarter window, for several windows → messages keep coming, at most one per window, never starved (Task 2 test `TestSteadyStreamIsNotStarved`; pbtsdb Task 8 test "keeps reloading under a steady stream").
3. A write committed after a live view's first fetch but before the server confirmed its topic → the view still shows it (Task 8 test "reloads once the topic is confirmed after the first load").
4. A signed-out realtime client subscribed to `collection/zoo_animals` → receives nothing (Task 2 test `TestSkipsUnauthenticatedAndUnsubscribedClients`).
5. A view that reads a collection only inside a subquery column, an `EXISTS`, or through a covering index → `CheckViews` names that collection (Task 4 test `TestCheckViewsNamesEveryUndeclaredRead`).

---

### Task 1: `changesignal` registry: topics and view fan-out

**Files:**
- Create: `$WS/tinycld/core/server/changesignal/registry.go`
- Test: `$WS/tinycld/core/server/changesignal/registry_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces (package `changesignal`, all used by Tasks 2–4):
  - `func Topic(collection string) string` — returns `"collection/" + collection`.
  - `func RegisterView(view string, sources ...string)` — panics on a blank view, no sources, a blank source, or a view listing itself; a second call for the same view unions the sources.
  - `func RegisteredViews() map[string][]string` — copy; each source list sorted.
  - `func topicsFor(collection string) []string` — `Topic(collection)` first, then the topics of every view that reads it directly or through another registered view, sorted.
  - `func coveredBy(view string) map[string]bool` — the view's declared sources plus, for each declared source that is itself a registered view, that view's covered set (transitive).
  - `func ResetForTesting()` — empties the registry.

- [ ] **Step 1: Write the failing tests**

```go
package changesignal

import (
	"reflect"
	"testing"
)

func TestTopic(t *testing.T) {
	if got := Topic("zoo_animals"); got != "collection/zoo_animals" {
		t.Fatalf("Topic = %q", got)
	}
}

func TestTopicsForAPlainCollectionIsItsOwnTopic(t *testing.T) {
	ResetForTesting()
	t.Cleanup(ResetForTesting)
	want := []string{"collection/zoo_animals"}
	if got := topicsFor("zoo_animals"); !reflect.DeepEqual(got, want) {
		t.Fatalf("topicsFor = %v, want %v", got, want)
	}
}

func TestTopicsForFansOutToViewsTransitively(t *testing.T) {
	ResetForTesting()
	t.Cleanup(ResetForTesting)
	RegisterView("zoo_fed", "zoo_animals", "zoo_feedings")
	RegisterView("zoo_fed_named", "zoo_fed")
	RegisterView("zoo_staff", "zoo_keepers")

	want := []string{"collection/zoo_feedings", "collection/zoo_fed", "collection/zoo_fed_named"}
	if got := topicsFor("zoo_feedings"); !reflect.DeepEqual(got, want) {
		t.Fatalf("topicsFor(zoo_feedings) = %v, want %v", got, want)
	}
	want = []string{"collection/zoo_keepers", "collection/zoo_staff"}
	if got := topicsFor("zoo_keepers"); !reflect.DeepEqual(got, want) {
		t.Fatalf("topicsFor(zoo_keepers) = %v, want %v", got, want)
	}
}

func TestRegisterViewUnionsRepeatedCalls(t *testing.T) {
	ResetForTesting()
	t.Cleanup(ResetForTesting)
	RegisterView("zoo_fed", "zoo_feedings")
	RegisterView("zoo_fed", "zoo_animals", "zoo_feedings")
	want := map[string][]string{"zoo_fed": {"zoo_animals", "zoo_feedings"}}
	if got := RegisteredViews(); !reflect.DeepEqual(got, want) {
		t.Fatalf("RegisteredViews = %v, want %v", got, want)
	}
}

func TestCoveredByExpandsRegisteredViewSources(t *testing.T) {
	ResetForTesting()
	t.Cleanup(ResetForTesting)
	RegisterView("zoo_fed", "zoo_animals", "zoo_feedings")
	RegisterView("zoo_fed_named", "zoo_fed")
	want := map[string]bool{"zoo_fed": true, "zoo_animals": true, "zoo_feedings": true}
	if got := coveredBy("zoo_fed_named"); !reflect.DeepEqual(got, want) {
		t.Fatalf("coveredBy = %v, want %v", got, want)
	}
}

func TestRegisterViewRefusesMalformedDeclarations(t *testing.T) {
	cases := map[string]func(){
		"blank view":   func() { RegisterView("", "zoo_animals") },
		"no sources":   func() { RegisterView("zoo_fed") },
		"blank source": func() { RegisterView("zoo_fed", "") },
		"reads itself": func() { RegisterView("zoo_fed", "zoo_fed") },
	}
	for name, register := range cases {
		t.Run(name, func(t *testing.T) {
			ResetForTesting()
			t.Cleanup(ResetForTesting)
			defer func() {
				if recover() == nil {
					t.Fatal("RegisterView did not panic")
				}
			}()
			register()
		})
	}
}

// Core itself declares no views: every view belongs to a package, which
// registers it from its own Register(app).
func TestCoreRegistersNoViews(t *testing.T) {
	if got := RegisteredViews(); len(got) != 0 {
		t.Fatalf("core registered views: %v", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./changesignal/...`
Expected: FAIL to build (`undefined: Topic`, `undefined: RegisterView`, …).

- [ ] **Step 3: Write the implementation**

```go
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
// reads, in a subquery, an EXISTS or a CTE included. A write to any source
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./changesignal/... && go vet -tags no_ui ./changesignal/... && gofmt -l changesignal`
Expected: `ok  tinycld.org/core/changesignal`, no vet output, no gofmt output.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/changesignal/registry.go core/server/changesignal/registry_test.go
git commit -m "feat(core): changesignal registry with topics and view fan-out"
```

---

### Task 2: Signals after commit, coalesced, data-free

**Files:**
- Create: `$WS/tinycld/core/server/changesignal/changesignal.go`
- Create: `$WS/tinycld/core/server/changesignal/helpers_test.go`
- Test: `$WS/tinycld/core/server/changesignal/changesignal_test.go`

**Interfaces:**
- Consumes: `Topic`, `topicsFor`, `ResetForTesting` (Task 1).
- Produces:
  - `const Window = 200 * time.Millisecond`
  - `func Register(app core.App)` — binds the three model hooks with `Window`; stores the signaler in `app.Store()` under `storeKey`.
  - `func register(app core.App, window time.Duration) *signaler` (tests).
  - `func (s *signaler) changed(collection string)` — schedules every topic of `topicsFor(collection)`.
  - `const storeKey = "tinycld.changesignal"`, `const payload = "{}"`.
  - Test helpers in `helpers_test.go`: `newZooApp(t, window) *tests.TestApp`, `listen(t, app, topic, signedIn bool) *listener`, `(*listener).collect(d time.Duration) []subscriptions.Message`, `saveAnimal(t, app core.App, name string) *core.Record`. Tasks 3 and 4 reuse them.

- [ ] **Step 1: Write the test helpers**

`helpers_test.go`:

```go
package changesignal

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/subscriptions"
)

// newZooApp is a test app with three fictional zoo collections and the
// change signal bound with the given window. zoo_feedings has a covering
// index on (animal, grams), so a query can read it through the index alone.
func newZooApp(t *testing.T, window time.Duration) *tests.TestApp {
	t.Helper()
	ResetForTesting()
	t.Cleanup(ResetForTesting)
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("NewTestApp: %v", err)
	}
	t.Cleanup(app.Cleanup)
	for _, name := range []string{"zoo_animals", "zoo_keepers", "zoo_feedings"} {
		col := core.NewBaseCollection(name)
		col.Fields.Add(
			&core.TextField{Name: "name"},
			&core.TextField{Name: "animal"},
			&core.NumberField{Name: "grams"},
		)
		if name == "zoo_feedings" {
			col.AddIndex("idx_zoo_feedings_animal", false, "animal, grams", "")
		}
		if err := app.Save(col); err != nil {
			t.Fatalf("save %s: %v", name, err)
		}
	}
	register(app, window)
	return app
}

type listener struct {
	client *subscriptions.DefaultClient
}

// listen registers a realtime client subscribed to topic. A signed-in
// client carries an auth record, as the realtime subscribe request sets it.
func listen(t *testing.T, app core.App, topic string, signedIn bool) *listener {
	t.Helper()
	client := subscriptions.NewDefaultClient()
	if signedIn {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			t.Fatal(err)
		}
		client.Set(apis.RealtimeClientAuthKey, core.NewRecord(users))
	}
	client.Subscribe(topic)
	app.SubscriptionsBroker().Register(client)
	t.Cleanup(func() { app.SubscriptionsBroker().Unregister(client.Id()) })
	return &listener{client: client}
}

// collect returns every message that arrives within d.
func (l *listener) collect(d time.Duration) []subscriptions.Message {
	var got []subscriptions.Message
	deadline := time.After(d)
	for {
		select {
		case msg := <-l.client.Channel():
			got = append(got, msg)
		case <-deadline:
			return got
		}
	}
}

func saveAnimal(t *testing.T, app core.App, name string) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("zoo_animals")
	if err != nil {
		t.Fatal(err)
	}
	rec := core.NewRecord(col)
	rec.Set("name", name)
	if err := app.Save(rec); err != nil {
		t.Fatalf("save animal: %v", err)
	}
	return rec
}
```

- [ ] **Step 2: Write the failing tests**

`changesignal_test.go`:

```go
package changesignal

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

const testWindow = 50 * time.Millisecond

func TestCreateUpdateDeleteEachSignal(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	rec := saveAnimal(t, app, "Leo")
	if got := l.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("create: %d messages, want 1", len(got))
	}
	rec.Set("name", "Leona")
	if err := app.Save(rec); err != nil {
		t.Fatal(err)
	}
	if got := l.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("update: %d messages, want 1", len(got))
	}
	if err := app.Delete(rec); err != nil {
		t.Fatal(err)
	}
	if got := l.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("delete: %d messages, want 1", len(got))
	}
}

func TestPayloadCarriesNoData(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	rec := saveAnimal(t, app, "Leo")
	got := l.collect(4 * testWindow)
	if len(got) != 1 {
		t.Fatalf("%d messages, want 1", len(got))
	}
	if got[0].Name != "collection/zoo_animals" {
		t.Fatalf("name = %q", got[0].Name)
	}
	if string(got[0].Data) != "{}" {
		t.Fatalf("payload = %q, want {}", got[0].Data)
	}
	if strings.Contains(string(got[0].Data), rec.Id) || strings.Contains(string(got[0].Data), "Leo") {
		t.Fatalf("payload leaks record data: %q", got[0].Data)
	}
}

func TestRolledBackTransactionSendsNothing(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	err := app.RunInTransaction(func(tx core.App) error {
		saveAnimal(t, tx, "Ghost")
		return errors.New("roll back")
	})
	if err == nil {
		t.Fatal("transaction did not fail")
	}
	if got := l.collect(4 * testWindow); len(got) != 0 {
		t.Fatalf("rolled-back write sent %d messages", len(got))
	}
}

func TestSignalWaitsForTheCommit(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	var duringTx int
	err := app.RunInTransaction(func(tx core.App) error {
		saveAnimal(t, tx, "Slow")
		duringTx = len(l.collect(3 * testWindow))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if duringTx != 0 {
		t.Fatalf("%d messages before the commit", duringTx)
	}
	if got := l.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("after commit: %d messages, want 1", len(got))
	}
}

func TestBatchInOneTransactionSendsOneMessage(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	err := app.RunInTransaction(func(tx core.App) error {
		for range 20 {
			saveAnimal(t, tx, "Herd")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := l.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("%d messages, want 1", len(got))
	}
}

func TestSeparateWritesInOneWindowSendOneMessage(t *testing.T) {
	// A long window makes "inside one window" certain on a slow machine.
	app := newZooApp(t, time.Second)
	l := listen(t, app, "collection/zoo_animals", true)

	for range 5 {
		saveAnimal(t, app, "Burst")
	}
	if got := l.collect(1500 * time.Millisecond); len(got) != 1 {
		t.Fatalf("burst: %d messages, want 1", len(got))
	}
	saveAnimal(t, app, "Later")
	if got := l.collect(1500 * time.Millisecond); len(got) != 1 {
		t.Fatalf("next window: %d messages, want 1", len(got))
	}
}

func TestSteadyStreamIsNotStarved(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	col, err := app.FindCollectionByNameOrId("zoo_animals")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	// t.Fatal must not run on this goroutine (go vet: testinggoroutine).
	go func() {
		defer close(done)
		for range 12 {
			rec := core.NewRecord(col)
			rec.Set("name", "Stream")
			if err := app.Save(rec); err != nil {
				t.Errorf("save: %v", err)
				return
			}
			time.Sleep(testWindow / 4)
		}
	}()
	got := l.collect(3 * testWindow)
	<-done
	if len(got) < 2 {
		t.Fatalf("%d messages in three windows of steady writes, want at least 2", len(got))
	}
}

func TestSkipsUnauthenticatedAndUnsubscribedClients(t *testing.T) {
	app := newZooApp(t, testWindow)
	signedOut := listen(t, app, "collection/zoo_animals", false)
	elsewhere := listen(t, app, "collection/zoo_keepers", true)

	saveAnimal(t, app, "Leo")
	if got := signedOut.collect(4 * testWindow); len(got) != 0 {
		t.Fatalf("signed-out client got %d messages", len(got))
	}
	if got := elsewhere.collect(testWindow); len(got) != 0 {
		t.Fatalf("client of another topic got %d messages", len(got))
	}
}

func TestViewTopicGetsItsSourcesWrites(t *testing.T) {
	app := newZooApp(t, testWindow)
	RegisterView("zoo_fed", "zoo_animals", "zoo_feedings")
	view := listen(t, app, "collection/zoo_fed", true)

	saveAnimal(t, app, "Leo")
	if got := view.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("view topic: %d messages, want 1", len(got))
	}
}

func TestCollectionSchemaSaveSendsNothing(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	col, err := app.FindCollectionByNameOrId("zoo_animals")
	if err != nil {
		t.Fatal(err)
	}
	col.Fields.Add(&core.TextField{Name: "note"})
	if err := app.Save(col); err != nil {
		t.Fatal(err)
	}
	if got := l.collect(4 * testWindow); len(got) != 0 {
		t.Fatalf("schema change sent %d messages", len(got))
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./changesignal/...`
Expected: FAIL to build (`undefined: register`).

- [ ] **Step 4: Write the implementation**

`changesignal.go` (the package doc comment is in `registry.go`; do not repeat it):

```go
package changesignal

import (
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/routine"
	"github.com/pocketbase/pocketbase/tools/subscriptions"

	"tinycld.org/core/logging"
)

var log = logging.ForPackage("changesignal")

// Window is how long a topic collects writes before its one message goes
// out. The window starts at the first write, so a steady stream of writes
// still sends one message per window.
const Window = 200 * time.Millisecond

const storeKey = "tinycld.changesignal"

// An empty JSON object, not empty bytes: pbtsdb drops an event whose data is
// not JSON, and a resumable realtime client adds its "seq" only to a JSON
// object.
const payload = "{}"

type signaler struct {
	app     core.App
	window  time.Duration
	mu      sync.Mutex
	pending map[string]bool
}

// Register binds the change signal to app's record writes. PocketBase runs
// the AfterSuccess model hooks after the transaction commits, so a
// rolled-back write sends nothing.
func Register(app core.App) {
	register(app, Window)
}

func register(app core.App, window time.Duration) *signaler {
	s := &signaler{app: app, window: window, pending: map[string]bool{}}
	// The store is shared with every transaction app cloned from app, which
	// is how Touch finds the signaler from inside a transaction.
	app.Store().Set(storeKey, s)
	onWrite := func(e *core.ModelEvent) error {
		if name := collectionOf(e.App, e.Model); name != "" {
			s.changed(name)
		}
		return e.Next()
	}
	app.OnModelAfterCreateSuccess().BindFunc(onWrite)
	app.OnModelAfterUpdateSuccess().BindFunc(onWrite)
	app.OnModelAfterDeleteSuccess().BindFunc(onWrite)
	return s
}

// collectionOf names the collection a written model belongs to, or "" for a
// model that is not a record (a collection schema, a log row).
func collectionOf(app core.App, model core.Model) string {
	switch m := model.(type) {
	case *core.Record:
		return m.Collection().Name
	case core.RecordProxy:
		return m.ProxyRecord().Collection().Name
	}
	if model.TableName() == core.LogsTableName {
		return ""
	}
	col, err := app.FindCachedCollectionByNameOrId(model.TableName())
	if err != nil {
		return ""
	}
	return col.Name
}

func (s *signaler) changed(collection string) {
	for _, topic := range topicsFor(collection) {
		s.schedule(topic)
	}
}

func (s *signaler) schedule(topic string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending[topic] {
		return
	}
	s.pending[topic] = true
	time.AfterFunc(s.window, func() {
		s.mu.Lock()
		delete(s.pending, topic)
		s.mu.Unlock()
		s.send(topic)
	})
}

// send delivers the message to every signed-in client subscribed to topic.
// A default client's Send blocks until its connection reads the message, so
// each send runs on its own goroutine.
func (s *signaler) send(topic string) {
	for _, client := range s.app.SubscriptionsBroker().Clients() {
		if !client.HasSubscription(topic) || !isSignedIn(client) {
			continue
		}
		routine.FireAndForget(func() {
			client.Send(subscriptions.Message{Name: topic, Data: []byte(payload)})
		})
	}
}

// isSignedIn reports whether the client's subscribe request carried an
// auth record. The payload is empty, but the timing of writes is still
// information, and no signed-out screen reads a live report.
func isSignedIn(client subscriptions.Client) bool {
	auth, _ := client.Get(apis.RealtimeClientAuthKey).(*core.Record)
	return auth != nil
}
```

`log` is first used by `Touch` in Task 3; Go accepts an unused package-level variable, so keep it here.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 -race ./changesignal/... && go vet -tags no_ui ./changesignal/... && gofmt -l changesignal`
Expected: `ok  tinycld.org/core/changesignal`; no race report, vet or gofmt output.

- [ ] **Step 6: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/changesignal/changesignal.go core/server/changesignal/helpers_test.go core/server/changesignal/changesignal_test.go
git commit -m "feat(core): send a coalesced, data-free change signal after each record write"
```

---

### Task 3: `Touch` for raw-SQL writers

**Files:**
- Modify: `$WS/tinycld/core/server/changesignal/changesignal.go` (append `Touch`)
- Test: `$WS/tinycld/core/server/changesignal/touch_test.go`

**Interfaces:**
- Consumes: `storeKey`, `signaler.changed`, `log` (Task 2); `newZooApp`, `listen`, `collect`, `RegisterView` (Tasks 1–2).
- Produces: `func Touch(app core.App, collection string)` — signals the collection's topics (and its views'); inside a transaction the signal waits for the commit and is dropped on rollback; an unknown collection logs a warning and sends nothing; an app without `Register` is a no-op.

- [ ] **Step 1: Write the failing tests**

```go
package changesignal

import (
	"errors"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func rawInsertAnimal(t *testing.T, app core.App, id string) {
	t.Helper()
	_, err := app.DB().
		NewQuery("INSERT INTO zoo_animals (id, name) VALUES ({:id}, 'raw')").
		Bind(dbx.Params{"id": id}).
		Execute()
	if err != nil {
		t.Fatalf("raw insert: %v", err)
	}
}

func TestRawSQLWriteSendsNothingWithoutTouch(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	rawInsertAnimal(t, app, "rawanimal000001")
	if got := l.collect(4 * testWindow); len(got) != 0 {
		t.Fatalf("raw write sent %d messages", len(got))
	}
}

func TestTouchSignalsTheCollectionAndItsViews(t *testing.T) {
	app := newZooApp(t, testWindow)
	RegisterView("zoo_fed", "zoo_animals")
	own := listen(t, app, "collection/zoo_animals", true)
	view := listen(t, app, "collection/zoo_fed", true)

	rawInsertAnimal(t, app, "rawanimal000002")
	Touch(app, "zoo_animals")
	if got := own.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("own topic: %d messages, want 1", len(got))
	}
	if got := view.collect(testWindow); len(got) != 1 {
		t.Fatalf("view topic: %d messages, want 1", len(got))
	}
}

func TestTouchInsideCommittedTransactionWaitsForTheCommit(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	var duringTx int
	err := app.RunInTransaction(func(tx core.App) error {
		rawInsertAnimal(t, tx, "rawanimal000003")
		Touch(tx, "zoo_animals")
		duringTx = len(l.collect(3 * testWindow))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if duringTx != 0 {
		t.Fatalf("%d messages before the commit", duringTx)
	}
	if got := l.collect(4 * testWindow); len(got) != 1 {
		t.Fatalf("after commit: %d messages, want 1", len(got))
	}
}

func TestTouchInsideRolledBackTransactionSendsNothing(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_animals", true)

	err := app.RunInTransaction(func(tx core.App) error {
		rawInsertAnimal(t, tx, "rawanimal000004")
		Touch(tx, "zoo_animals")
		return errors.New("roll back")
	})
	if err == nil {
		t.Fatal("transaction did not fail")
	}
	if got := l.collect(4 * testWindow); len(got) != 0 {
		t.Fatalf("rolled-back Touch sent %d messages", len(got))
	}
}

func TestTouchOfAnUnknownCollectionSendsNothing(t *testing.T) {
	app := newZooApp(t, testWindow)
	l := listen(t, app, "collection/zoo_typo", true)

	Touch(app, "zoo_typo")
	if got := l.collect(4 * testWindow); len(got) != 0 {
		t.Fatalf("unknown collection sent %d messages", len(got))
	}
}

func TestTouchWithoutRegisterIsANoOp(t *testing.T) {
	app := newZooApp(t, testWindow)
	app.Store().Remove(storeKey)
	Touch(app, "zoo_animals") // must not panic
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./changesignal/... -run 'Touch|RawSQL'`
Expected: FAIL to build (`undefined: Touch`).

- [ ] **Step 3: Write the implementation**

Append to `changesignal.go`:

```go
// Touch signals collection after a write that model hooks did not see: a
// raw app.DB() statement, a bulk INSERT … SELECT, a migration. Pass the
// app that ran the write; inside a transaction the signal waits for the
// commit and is dropped on a rollback.
func Touch(app core.App, collection string) {
	s, _ := app.Store().Get(storeKey).(*signaler)
	if s == nil {
		return
	}
	col, err := app.FindCachedCollectionByNameOrId(collection)
	if err != nil {
		log.Warn("touch names no collection", "collection", collection)
		return
	}
	name := col.Name
	if tx := app.TxInfo(); tx != nil {
		tx.OnComplete(func(txErr error) error {
			if txErr == nil {
				s.changed(name)
			}
			return nil
		})
		return
	}
	s.changed(name)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 -race ./changesignal/... && go vet -tags no_ui ./changesignal/... && gofmt -l changesignal`
Expected: `ok`, no output from vet or gofmt.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/changesignal/changesignal.go core/server/changesignal/touch_test.go
git commit -m "feat(core): changesignal.Touch for raw-SQL writes, after commit only"
```

---

### Task 4: `CheckViews`: prove declared view sources against SQLite bytecode

**Files:**
- Create: `$WS/tinycld/core/server/changesignal/viewcheck.go`
- Test: `$WS/tinycld/core/server/changesignal/viewcheck_test.go`

**Interfaces:**
- Consumes: `RegisteredViews`, `coveredBy`, `RegisterView` (Task 1); `newZooApp` (Task 2).
- Produces: `func CheckViews(app core.App) error` — nil when every registered view is a view collection, declares only existing collections, and reads only covered collections; otherwise one error naming every problem, views in name order. Packages call it from their tests after their migrations apply.

- [ ] **Step 1: Write the failing tests**

```go
package changesignal

import (
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// zoo_fed reads zoo_feedings only in a subquery column (through the covering
// index) and zoo_keepers only in an EXISTS: the reads PocketBase's view
// parser does not see.
const zooFedQuery = `SELECT a.id, a.name,
	(SELECT SUM(f.grams) FROM zoo_feedings f WHERE f.animal = a.id) AS grams
	FROM zoo_animals a
	WHERE EXISTS (SELECT 1 FROM zoo_keepers k WHERE k.animal = a.id)`

func saveView(t *testing.T, app core.App, name, query string) {
	t.Helper()
	view := core.NewViewCollection(name)
	view.ViewQuery = query
	if err := app.Save(view); err != nil {
		t.Fatalf("save view %s: %v", name, err)
	}
}

func viewApp(t *testing.T) core.App {
	t.Helper()
	app := newZooApp(t, time.Second)
	saveView(t, app, "zoo_fed", zooFedQuery)
	saveView(t, app, "zoo_fed_named", `WITH c AS (SELECT animal, COUNT(*) n FROM zoo_feedings GROUP BY animal)
		SELECT v.id, v.name, c.n FROM zoo_fed v LEFT JOIN c ON c.animal = v.id`)
	return app
}

func TestCheckViewsPassesAFullDeclaration(t *testing.T) {
	app := viewApp(t)
	RegisterView("zoo_fed", "zoo_animals", "zoo_feedings", "zoo_keepers")
	RegisterView("zoo_fed_named", "zoo_fed", "zoo_feedings")
	if err := CheckViews(app); err != nil {
		t.Fatalf("CheckViews: %v", err)
	}
}

func TestCheckViewsNamesEveryUndeclaredRead(t *testing.T) {
	app := viewApp(t)
	RegisterView("zoo_fed", "zoo_animals")
	err := CheckViews(app)
	if err == nil {
		t.Fatal("CheckViews passed a view that reads undeclared collections")
	}
	for _, want := range []string{
		`view "zoo_fed" reads "zoo_feedings"`,
		`view "zoo_fed" reads "zoo_keepers"`,
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not contain %q", err, want)
		}
	}
	if strings.Contains(err.Error(), `reads "zoo_animals"`) {
		t.Errorf("error names a declared source: %q", err)
	}
}

func TestCheckViewsCountsARegisteredViewsSources(t *testing.T) {
	app := viewApp(t)
	RegisterView("zoo_fed", "zoo_animals", "zoo_feedings", "zoo_keepers")
	RegisterView("zoo_fed_named", "zoo_fed")
	// zoo_fed_named reads zoo_feedings itself too (the CTE), and zoo_fed
	// covers it, so this passes.
	if err := CheckViews(app); err != nil {
		t.Fatalf("CheckViews: %v", err)
	}
}

func TestCheckViewsRefusesAnUnknownSource(t *testing.T) {
	app := viewApp(t)
	RegisterView("zoo_fed", "zoo_animals", "zoo_feedings", "zoo_keepers", "zoo_typo")
	err := CheckViews(app)
	if err == nil || !strings.Contains(err.Error(), `view "zoo_fed" declares "zoo_typo", which is not a collection`) {
		t.Fatalf("CheckViews = %v", err)
	}
}

func TestCheckViewsRefusesANonView(t *testing.T) {
	app := viewApp(t)
	RegisterView("zoo_animals", "zoo_keepers")
	RegisterView("zoo_missing", "zoo_keepers")
	err := CheckViews(app)
	if err == nil {
		t.Fatal("CheckViews passed")
	}
	for _, want := range []string{
		`view "zoo_animals" is a base collection, not a view`,
		`view "zoo_missing" is not a collection`,
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not contain %q", err, want)
		}
	}
}

func TestCheckViewsWithNoViewsPasses(t *testing.T) {
	app := newZooApp(t, time.Second)
	if err := CheckViews(app); err != nil {
		t.Fatalf("CheckViews: %v", err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./changesignal/... -run CheckViews`
Expected: FAIL to build (`undefined: CheckViews`).

- [ ] **Step 3: Write the implementation**

```go
package changesignal

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

// CheckViews compiles every registered view with SQLite's EXPLAIN and fails
// when its bytecode opens a table, or an index of a table, that the view's
// registration does not cover. Each OpenRead opcode names a root page, and
// sqlite_schema maps every root page to its table, so a read hidden in a
// subquery, an EXISTS, a CTE or a covering index is still seen. Call it from
// a package's tests after the package's migrations apply.
func CheckViews(app core.App) error {
	registered := RegisteredViews()
	if len(registered) == 0 {
		return nil
	}
	pages, err := rootPages(app)
	if err != nil {
		return err
	}
	names := make([]string, 0, len(registered))
	for name := range registered {
		names = append(names, name)
	}
	sort.Strings(names)
	var problems []string
	for _, name := range names {
		problems = append(problems, checkView(app, pages, name, registered[name])...)
	}
	if len(problems) > 0 {
		return errors.New("changesignal: " + strings.Join(problems, "; "))
	}
	return nil
}

func checkView(app core.App, pages map[int64]string, view string, sources []string) []string {
	col, err := app.FindCollectionByNameOrId(view)
	if err != nil {
		return []string{fmt.Sprintf("view %q is not a collection", view)}
	}
	if !col.IsView() {
		return []string{fmt.Sprintf("view %q is a %s collection, not a view", view, col.Type)}
	}
	var problems []string
	for _, source := range sources {
		if _, err := app.FindCollectionByNameOrId(source); err != nil {
			problems = append(problems, fmt.Sprintf("view %q declares %q, which is not a collection", view, source))
		}
	}
	read, err := tablesRead(app, pages, "SELECT * FROM {{"+col.Name+"}}")
	if err != nil {
		return append(problems, fmt.Sprintf("view %q: %v", view, err))
	}
	covered := coveredBy(view)
	for _, table := range read {
		if !covered[table] {
			problems = append(problems, fmt.Sprintf("view %q reads %q, which RegisterView does not declare", view, table))
		}
	}
	return problems
}

func rootPages(app core.App) (map[int64]string, error) {
	var rows []struct {
		RootPage int64  `db:"rootpage"`
		Table    string `db:"tbl_name"`
	}
	err := app.DB().
		NewQuery("SELECT rootpage, tbl_name FROM sqlite_schema WHERE rootpage > 0").
		All(&rows)
	if err != nil {
		return nil, fmt.Errorf("changesignal: read sqlite_schema: %w", err)
	}
	pages := make(map[int64]string, len(rows))
	for _, row := range rows {
		pages[row.RootPage] = row.Table
	}
	return pages, nil
}

// tablesRead lists, sorted, the tables of the main database that query
// opens for reading.
func tablesRead(app core.App, pages map[int64]string, query string) ([]string, error) {
	var ops []struct {
		Opcode string `db:"opcode"`
		P2     int64  `db:"p2"`
		P3     int64  `db:"p3"`
	}
	if err := app.DB().NewQuery("EXPLAIN " + query).All(&ops); err != nil {
		return nil, fmt.Errorf("explain: %w", err)
	}
	seen := map[string]bool{}
	for _, op := range ops {
		switch op.Opcode {
		case "VOpen":
			return nil, errors.New("reads a virtual table, which this check cannot map to a collection")
		case "OpenRead":
			if op.P3 != 0 {
				continue // not the main database
			}
			table, ok := pages[op.P2]
			if !ok {
				return nil, fmt.Errorf("opens root page %d, which no table or index owns", op.P2)
			}
			if !strings.HasPrefix(table, "sqlite_") {
				seen[table] = true
			}
		}
	}
	tables := make([]string, 0, len(seen))
	for table := range seen {
		tables = append(tables, table)
	}
	sort.Strings(tables)
	return tables, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 -race ./changesignal/... && go vet -tags no_ui ./changesignal/... && gofmt -l changesignal`
Expected: `ok`, no vet or gofmt output.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/changesignal/viewcheck.go core/server/changesignal/viewcheck_test.go
git commit -m "feat(core): changesignal.CheckViews proves view sources from EXPLAIN"
```

---

### Task 5: Wire the change signal into the shared composition

**Files:**
- Modify: `$WS/tinycld/core/server/coreserver/server.go` (`RegisterSharedCore`, after `search.Register(app)`; add the import `"tinycld.org/core/changesignal"`)
- Modify: `$WS/tinycld/core/server/coreserver/composition_parity_test.go` (`hostHookCounts`)

**Interfaces:**
- Consumes: `changesignal.Register(app core.App)` (Task 2).
- Produces: every composition (`Register`, and any composition that calls `RegisterSharedCore`) sends change signals.

- [ ] **Step 1: Update the golden counts first (the failing test)**

In `composition_parity_test.go` change exactly these three entries:

```go
	"OnModelAfterCreateSuccess":           5,
	"OnModelAfterDeleteSuccess":           4,
	"OnModelAfterUpdateSuccess":           5,
```

(from 4, 3 and 4). Keep the column alignment `gofmt` produces.

- [ ] **Step 2: Run the tripwire to verify it fails**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && go test -tags no_ui -count=1 ./coreserver/ -run TestRegisterBindsTheRecordedHandlerCounts`
Expected: FAIL, naming `OnModelAfterCreateSuccess` got 4 want 5 (and the other two).

- [ ] **Step 3: Register it**

In `RegisterSharedCore`, directly after the `search.Register(app)` call and its comment block:

```go
	// Data-free change signals (topic collection/<name>) after each committed
	// record write. Live reports and live view collections listen to them.
	// Shared: every composition serves the same live reports. Inert with no
	// subscriber; packages add views with changesignal.RegisterView.
	changesignal.Register(app)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld/core/server && gofmt -l coreserver changesignal && go vet -tags no_ui ./changesignal/... ./coreserver/ && go test -tags no_ui -count=1 ./changesignal/... ./coreserver/...`
Expected: no gofmt/vet output; `ok` for both packages.

Then the isolation guard:
Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld && /Users/nas/tmp/tinycld/books-purchases/node_modules/.bin/tsx scripts/check-core-isolation.ts`
Expected: exit 0 (the new code names only fictional `zoo_*` collections).

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/server/coreserver/server.go core/server/coreserver/composition_parity_test.go
git commit -m "feat(core): register the change signal in the shared composition"
```

---

### Task 6: `docs/packages.md`: Touch, RegisterView, CheckViews

**Files:**
- Modify: `$WS/tinycld/docs/packages.md` — the registry table in "### Registries: how core learns what a package provides", and a new subsection "### Change signals and live views" directly before "### Test build tag".

**Interfaces:**
- Consumes: the Go API of Tasks 1–4 and the pbtsdb API of Tasks 7–8 (`subscribeTopic`, `liveTopics`, version 2.1.0) and Task 10's `liveViewOptions`.
- Produces: package-author documentation. No in-app help topic: nothing here is user-facing (decision 8).

- [ ] **Step 1: Add the registry row**

After the row `| which collections to audit-log | \`audit.RegisterCollection\` |` add:

```markdown
| which view collections stay live, and the collections each view's SQL reads (see "Change signals and live views" below) | `changesignal.RegisterView` |
```

- [ ] **Step 2: Add the subsection**

Insert before `### Test build tag`:

````markdown
### Change signals and live views

After a record of any collection is created, updated or deleted and the write
commits, core sends a message on the realtime topic `collection/<name>`. The
payload is `{}`: the message says only that the collection changed, and when.
Messages are coalesced per topic over 200 ms, so a batch of writes sends one,
and they go only to signed-in realtime clients subscribed to the topic. A live
report subscribes to the topic of every collection it reads and runs again on
a message. On the client, pbtsdb (2.1.0 and later) provides
`subscribeTopic(pb, topic, onMessage)` and the collection option `liveTopics`.

**Raw SQL sends no signal.** A write through `app.DB()` (a raw `UPDATE`, a
bulk `INSERT … SELECT`, a migration) runs no model hook. After such a write to
a collection that a report can read, call `Touch` with the app that ran the
write:

```go
if _, err := txApp.DB().NewQuery("UPDATE zoo_feedings SET grams = 0").Execute(); err != nil {
    return err
}
changesignal.Touch(txApp, "zoo_feedings")
```

Inside a transaction the signal waits for the commit and is dropped on a
rollback.

**View collections.** PocketBase sends no record events for a view, so a view
is live only when it declares the collections its SQL reads. Do it from the
package's `Register(app)`:

```go
changesignal.RegisterView("zoo_fed", "zoo_animals", "zoo_feedings", "zoo_keepers")
```

A write to any source then also signals `collection/zoo_fed`. The client keeps
the view live with `liveTopics: ['collection/zoo_fed']`
(`...liveViewOptions('zoo_fed')` from `@tinycld/core/lib/change-signal`). List
every collection the SQL reads, including one read only in a subquery, an
`EXISTS` or a CTE: PocketBase's view parser reads only the outer FROM and
JOIN. A source may be another registered view. Pin the list in the package's
tests, after its migrations apply:

```go
if err := changesignal.CheckViews(app); err != nil {
    t.Fatal(err)
}
```

`CheckViews` compiles each registered view with SQLite `EXPLAIN` and fails
when its bytecode opens a table, or an index of a table, that the
registration does not cover.
````

- [ ] **Step 3: Check the result**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld && grep -n 'changesignal' docs/packages.md`
Expected: the table row, the `Touch`, `RegisterView` and `CheckViews` snippets. Read the rendered section once to confirm the nested code fences close.

- [ ] **Step 4: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add docs/packages.md
git commit -m "docs(core): change signals, Touch and RegisterView for package authors"
```

---

### Task 7: pbtsdb `subscribeTopic` (and the test server's signal route)

**Files:**
- Create: `$PBTSDB/pb_hooks/test-signal.pb.js` (test fixture: a route that sends topic messages, standing in for tinycld core)
- Modify: `$PBTSDB/src/transport.ts` (export `subscribeTopic`; add `subscribeTopic` to `Transport`)
- Modify: `$PBTSDB/src/core.ts` (export `subscribeTopic`)
- Test: `$PBTSDB/test/subscribe-topic.test.ts`
- Modify: `$PBTSDB/test/helpers.ts` (add `sendSignal`)
- Docs: `$PBTSDB/README.md` (new "### Change signals" under "Core Concepts", after "### Reconnects"), `$PBTSDB/llms.txt` (same API), `$PBTSDB/docs/internals.md` ("## Realtime client": one paragraph), `$PBTSDB/CHANGELOG.md` (`## [Unreleased]` → `### Added`)

**Interfaces:**
- Consumes: `entryFor(pb).client.subscribe(topic, listener)` (`src/realtime-client.ts`), which validates length (`RealtimeTopicTooLongError`) and resolves after the server confirmed the topic.
- Produces:
  - `export function subscribeTopic(pb: PocketBase, topic: string, onMessage: () => void): Promise<() => Promise<void>>`
  - `Transport.subscribeTopic: (topic: string, onMessage: () => void) => Promise<Unsubscribe>` (Task 8 uses it).
  - Test helper `sendSignal(topic: string, count?: number): Promise<void>` in `test/helpers.ts` — `POST /api/test/signal`.

- [ ] **Step 1: Make sure the test server can start**

Run: `cd /Users/nas/tmp/tinycld/books-purchases-pbtsdb && test -f .env || cp .env.sample .env`
Expected: `.env` exists (gitignored; never commit it).

- [ ] **Step 2: Add the signal route fixture**

`pb_hooks/test-signal.pb.js`:

```js
// Test fixture: sends `count` data-free messages on `topic` to every
// signed-in realtime client subscribed to it, the way tinycld core's
// changesignal package does after a write. The payload is '{}': pbtsdb drops
// an event whose data is not JSON.
routerAdd(
    'POST',
    '/api/test/signal',
    e => {
        const body = e.requestInfo().body
        const topic = String(body.topic || '')
        const count = Number(body.count || 1)
        const clients = $app.subscriptionsBroker().clients()
        for (let i = 0; i < count; i++) {
            for (const id in clients) {
                const client = clients[id]
                if (client.hasSubscription(topic) && client.get('auth')) {
                    client.send(new SubscriptionMessage({ name: topic, data: '{}' }))
                }
            }
        }
        return e.noContent(204)
    },
    $apis.requireAuth()
)
```

Add to `test/helpers.ts` (after `authenticateTestUser`):

```ts
/** Asks the test server to send `count` data-free messages on `topic`. */
export async function sendSignal(topic: string, count = 1): Promise<void> {
    await pb.send('/api/test/signal', { method: 'POST', body: { topic, count } })
}
```

- [ ] **Step 3: Write the failing tests**

`test/subscribe-topic.test.ts`:

```ts
import { waitFor } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { subscribeTopic } from '../src'
import { authenticateTestUser, clearAuth, pb, sendSignal } from './helpers'

// A message on `barrier` arrives after every message the server sent before
// it on the same connection, so waiting for it proves an earlier topic got
// nothing.
async function withBarrier(check: () => void): Promise<void> {
    const barrier = vi.fn()
    const unsubscribe = await subscribeTopic(pb, 'test/barrier', barrier)
    await sendSignal('test/barrier')
    await waitFor(() => expect(barrier).toHaveBeenCalled())
    check()
    await unsubscribe()
}

describe('subscribeTopic', () => {
    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterAll(() => {
        clearAuth()
    })

    it('calls onMessage, with no argument, once per message', async () => {
        const onMessage = vi.fn()
        const unsubscribe = await subscribeTopic(pb, 'collection/topic_a', onMessage)
        await sendSignal('collection/topic_a', 2)
        await waitFor(() => expect(onMessage).toHaveBeenCalledTimes(2))
        expect(onMessage.mock.calls).toEqual([[], []])
        await unsubscribe()
    })

    it('stops after unsubscribe', async () => {
        const onMessage = vi.fn()
        const unsubscribe = await subscribeTopic(pb, 'collection/topic_b', onMessage)
        await unsubscribe()
        await sendSignal('collection/topic_b')
        await withBarrier(() => expect(onMessage).not.toHaveBeenCalled())
    })

    it('keeps one subscriber when another on the same topic leaves', async () => {
        const first = vi.fn()
        const second = vi.fn()
        const unsubscribeFirst = await subscribeTopic(pb, 'collection/topic_c', first)
        const unsubscribeSecond = await subscribeTopic(pb, 'collection/topic_c', second)
        await unsubscribeFirst()
        await sendSignal('collection/topic_c')
        await waitFor(() => expect(second).toHaveBeenCalledTimes(1))
        expect(first).not.toHaveBeenCalled()
        await unsubscribeSecond()
    })

    it('ignores messages on other topics', async () => {
        const onMessage = vi.fn()
        const unsubscribe = await subscribeTopic(pb, 'collection/topic_d', onMessage)
        await sendSignal('collection/topic_other')
        await withBarrier(() => expect(onMessage).not.toHaveBeenCalled())
        await unsubscribe()
    })

    it('rejects an empty topic and a topic over 2500 characters', async () => {
        await expect(subscribeTopic(pb, '', vi.fn())).rejects.toThrow('topic is empty')
        await expect(subscribeTopic(pb, 'x'.repeat(2501), vi.fn())).rejects.toMatchObject({
            name: 'RealtimeTopicTooLongError',
        })
    })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases-pbtsdb && TEST=test/subscribe-topic.test.ts npm test`
Expected: FAIL (`subscribeTopic` is not exported). `npm test` starts and stops the server on 8210 itself; do not start one by hand.

- [ ] **Step 5: Implement**

In `src/transport.ts`, add to the `Transport` interface:

```ts
    /** Resolves once the server has the topic; see {@link subscribeTopic}. */
    subscribeTopic: (topic: string, onMessage: () => void) => Promise<Unsubscribe>
```

Add the public function (after `setRealtimeEventSource`):

```ts
/**
 * Calls `onMessage` for each message the server sends on `topic`, over
 * pbtsdb's shared realtime connection for `pb`. The message's data is not
 * passed on: a topic message, such as a data-free change signal, says only
 * that something changed, and the caller fetches what it needs. Resolves
 * once the server has the topic, so a fetch started after it resolves
 * cannot miss a change the server reports on it; resolves to the
 * unsubscribe function. Rejects an empty topic, and a topic over 2500
 * characters with `RealtimeTopicTooLongError`. A message whose data is not
 * JSON is dropped.
 *
 * @example
 * const unsubscribe = await subscribeTopic(pb, 'collection/books', () => void rerun())
 * await rerun()
 */
export function subscribeTopic(
    pb: PocketBase,
    topic: string,
    onMessage: () => void
): Promise<() => Promise<void>> {
    if (topic === '') return Promise.reject(new Error('subscribeTopic: topic is empty'))
    return entryFor(pb).client.subscribe(topic, () => onMessage())
}
```

In `transportFor`, add to the returned object:

```ts
        subscribeTopic: (topic, onMessage) => subscribeTopic(pb, topic, onMessage),
```

In `src/core.ts`, add `subscribeTopic` to the `export { … } from './transport'` list (alphabetical: after `subscribeSyncStatus`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases-pbtsdb && TEST=test/subscribe-topic.test.ts npm test`
Expected: 5 passed.

- [ ] **Step 7: Document**

- `README.md`: a "### Change signals" subsection after "### Reconnects": what `subscribeTopic` does, that it resolves after the server has the topic (subscribe first, then fetch), that `onMessage` gets no data, the example above, and a link-free sentence that a server such as tinycld sends `{}` on `collection/<name>` after a write. Add the entry to the Table of Contents if subsections are listed there.
- `llms.txt`: the same signature and the one-paragraph contract, next to `resetRealtime`.
- `docs/internals.md`, "## Realtime client": "`subscribeTopic` registers a listener on the shared client like a record topic does; the dispatcher still parses the data as JSON (for `seq`) and drops non-JSON data, and the listener is called with no argument."
- `CHANGELOG.md`, under `## [Unreleased]` add `### Added` with: "`subscribeTopic(pb, topic, onMessage)`: listen to a custom realtime topic, such as a data-free change signal, over pbtsdb's shared connection."

- [ ] **Step 8: Run the full checks**

Run: `cd /Users/nas/tmp/tinycld/books-purchases-pbtsdb && npm run checks && npm test`
Expected: typecheck and lint clean; every test file passes.

- [ ] **Step 9: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases-pbtsdb
git add pb_hooks/test-signal.pb.js src/transport.ts src/core.ts test/subscribe-topic.test.ts test/helpers.ts README.md llms.txt docs/internals.md CHANGELOG.md
git commit -m "feat: subscribeTopic for custom realtime topics"
```

---

### Task 8: pbtsdb `liveTopics` collection option

**Files:**
- Create: `$PBTSDB/pb_migrations/1763880000_create_author_book_counts_view.js` (test fixture view)
- Modify: `$PBTSDB/test/schema.ts` (regenerated by the test server's schema hook on boot; commit what it writes, never hand-edit)
- Modify: `$PBTSDB/src/types.ts` (`CreateCollectionOptions.liveTopics`)
- Modify: `$PBTSDB/src/build-collection.ts` (validation, `LIVE_TOPIC_WINDOW_MS`, `openLiveTopics`, lifecycle)
- Modify: `$PBTSDB/src/core.ts` (export `LIVE_TOPIC_WINDOW_MS`)
- Test: `$PBTSDB/test/live-topics.test.ts`
- Docs: `$PBTSDB/README.md` (the "### Change signals" subsection from Task 7, and the `createCollection()` options list), `$PBTSDB/llms.txt`, `$PBTSDB/docs/internals.md`, `$PBTSDB/CHANGELOG.md`

**Interfaces:**
- Consumes: `Transport.subscribeTopic` (Task 7); `adapter.reload` / `reloadFor(reason)` and the `status:change` lifecycle in `buildCollection`; `sendSignal` (Task 7).
- Produces:
  - `CreateCollectionOptions.liveTopics?: readonly string[]`
  - `export const LIVE_TOPIC_WINDOW_MS = 100`
  - Behavior: while the collection syncs (status `loading` or `ready`, until `cleaned-up`), each topic is subscribed; the first message opens a 100 ms window and the collection reloads once when it closes; when a topic is confirmed and the collection is already `ready`, it reloads once. Build throws for an empty topic or one over 2500 characters.

- [ ] **Step 1: Add the fixture view**

`pb_migrations/1763880000_create_author_book_counts_view.js`:

```js
/// <reference path="../pb_data/types.d.ts" />
// A view for liveTopics tests: PocketBase sends no record events for a view,
// so only a topic message can tell a client that a count changed.
migrate(
    app => {
        const view = new Collection({
            name: 'author_book_counts',
            type: 'view',
            listRule: "@request.auth.id != ''",
            viewRule: "@request.auth.id != ''",
            viewQuery: `SELECT a.id, a.name, COUNT(b.id) AS book_count
                FROM authors a LEFT JOIN books b ON b.author = a.id
                GROUP BY a.id`,
        })
        app.save(view)
    },
    app => {
        app.delete(app.findCollectionByNameOrId('author_book_counts'))
    }
)
```

Check the reference-path line against the other files in `pb_migrations/` and copy theirs exactly (drop it if they have none).

- [ ] **Step 2: Write the failing tests**

`test/live-topics.test.ts`:

```ts
import { eq, useLiveQuery } from '@tanstack/react-db'
import { renderHook, waitFor } from '@testing-library/react'
import type { SendOptions } from 'pocketbase'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createCollection, LIVE_TOPIC_WINDOW_MS, subscribeTopic } from '../src'
import { realtimeClientFor } from '../src/transport'
import { authenticateTestUser, clearAuth, newRecordId, pb, sendSignal } from './helpers'
import type { Schema } from './schema'

const TOPIC = 'collection/author_book_counts'
const VIEW_PATH = '/api/collections/author_book_counts/records'

function createCountsCollection(liveTopics: readonly string[] = [TOPIC]) {
    return createCollection<Schema>(pb)('author_book_counts', {
        syncMode: 'on-demand',
        realtime: 'query',
        liveTopics,
    })
}

async function createAuthor(): Promise<string> {
    const id = newRecordId()
    await pb.collection('authors').create({ id, name: `Live ${id}`, email: `${id}@live.test` })
    return id
}

async function createBook(author: string): Promise<void> {
    await pb.collection('books').create({ id: newRecordId(), title: 'Live', author })
}

const originalBeforeSend = pb.beforeSend
let viewRequests = 0
let holdRealtimePost: Promise<void> | undefined

function countRequests(): void {
    viewRequests = 0
    pb.beforeSend = async (url: string, options: SendOptions) => {
        if (url.includes(VIEW_PATH)) viewRequests += 1
        if (holdRealtimePost && url.endsWith('/api/realtime') && options.method === 'POST') {
            await holdRealtimePost
        }
        return { url, options }
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Waits until no view request has been sent for `quiet` ms. */
async function settle(quiet = 300): Promise<void> {
    let seen = -1
    while (seen !== viewRequests) {
        seen = viewRequests
        await sleep(quiet)
    }
}

function mountCount(counts: ReturnType<typeof createCountsCollection>, author: string) {
    return renderHook(() =>
        useLiveQuery(q => q.from({ c: counts }).where(({ c }) => eq(c.id, author)))
    )
}

// `topics()` lists a topic as soon as it is registered, before the server
// has it. Every subscriptions POST carries the whole list, so once a later
// subscribe resolves, every topic registered before it is confirmed too.
async function confirmTopics(): Promise<void> {
    const unsubscribe = await subscribeTopic(pb, 'test/confirm', () => undefined)
    await unsubscribe()
}

describe('liveTopics', () => {
    beforeAll(async () => {
        await authenticateTestUser()
    })

    afterEach(() => {
        pb.beforeSend = originalBeforeSend
        holdRealtimePost = undefined
    })

    afterAll(() => {
        clearAuth()
    })

    it('reloads the collection on a message', async () => {
        const author = await createAuthor()
        const counts = createCountsCollection()
        const { result } = mountCount(counts, author)
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(0))
        await confirmTopics()

        await createBook(author)
        await sendSignal(TOPIC)
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(1))
        await counts.cleanup()
    })

    it('coalesces a burst of messages into one reload', async () => {
        const author = await createAuthor()
        countRequests()
        const counts = createCountsCollection()
        const { result } = mountCount(counts, author)
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(0))
        await confirmTopics()
        await settle()
        const before = viewRequests

        await sendSignal(TOPIC, 5)
        await sleep(LIVE_TOPIC_WINDOW_MS * 4)
        await settle()
        expect(viewRequests - before).toBe(1)
        await counts.cleanup()
    })

    it('keeps reloading under a steady stream of messages', async () => {
        const author = await createAuthor()
        countRequests()
        const counts = createCountsCollection()
        const { result } = mountCount(counts, author)
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(0))
        await confirmTopics()
        await settle()
        const before = viewRequests

        for (let i = 0; i < 10; i++) {
            await sendSignal(TOPIC)
            await sleep(LIVE_TOPIC_WINDOW_MS / 2)
        }
        await settle()
        expect(viewRequests - before).toBeGreaterThanOrEqual(2)
        await counts.cleanup()
    })

    it('reloads once the topic is confirmed after the first load', async () => {
        const author = await createAuthor()
        let release: () => void = () => undefined
        holdRealtimePost = new Promise<void>(resolve => {
            release = resolve
        })
        countRequests()
        const counts = createCountsCollection()
        const { result } = mountCount(counts, author)
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(0))

        // Written after the first fetch, before the server has the topic:
        // no message can report it to this client.
        await createBook(author)
        release()
        await waitFor(() => expect(result.current.data?.[0]?.book_count).toBe(1))
        await counts.cleanup()
    })

    it('leaves its topics when the collection is cleaned up', async () => {
        const author = await createAuthor()
        const counts = createCountsCollection(['collection/live_cleanup'])
        const { result, unmount } = mountCount(counts, author)
        await waitFor(() => expect(result.current.data).toHaveLength(1))
        await waitFor(() =>
            expect(realtimeClientFor(pb).topics()).toContain('collection/live_cleanup')
        )
        unmount()
        await counts.cleanup()
        await waitFor(() =>
            expect(realtimeClientFor(pb).topics()).not.toContain('collection/live_cleanup')
        )
    })

    it('refuses an empty topic and a topic over 2500 characters at build', () => {
        expect(() => createCountsCollection([''])).toThrow('liveTopics')
        expect(() => createCountsCollection(['x'.repeat(2501)])).toThrow('liveTopics')
    })
})
```

If `pb.beforeSend`'s type in the installed `pocketbase` SDK differs from `(url, options: SendOptions) => Promise<{ url; options }>`, adapt the signature to the SDK's own type (read `node_modules/pocketbase/dist/pocketbase.es.d.ts`); never cast to `any`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/nas/tmp/tinycld/books-purchases-pbtsdb && TEST=test/live-topics.test.ts npm test`
Expected: FAIL — `LIVE_TOPIC_WINDOW_MS` not exported and `liveTopics` not in the options type (tsc in vitest may only warn; the runtime failure is "reloads the collection on a message" timing out at `book_count` 1). The server boot regenerates `test/schema.ts` with `AuthorBookCounts` / `author_book_counts`; check `git diff test/schema.ts` shows that addition.

- [ ] **Step 4: Implement**

`src/types.ts`, in `CreateCollectionOptions` after `realtime?: RealtimeMode` (keep the jsdoc style of the neighbors):

```ts
    /**
     * Realtime topics whose messages mean "this collection's rows may have
     * changed", such as the data-free change signal `collection/<name>` a
     * server sends after a write. While the collection syncs, the first
     * message on any of them opens a window of `LIVE_TOPIC_WINDOW_MS`
     * milliseconds, and the collection reloads (`collection.reload()`) once
     * when it closes. Use it for a view collection, for which PocketBase
     * sends no record events.
     *
     * @example
     * ```ts
     * const counts = c('author_book_counts', { liveTopics: ['collection/author_book_counts'] })
     * ```
     */
    liveTopics?: readonly string[]
```

`src/build-collection.ts`:

1. Import `REALTIME_TOPIC_MAX_LENGTH` from `./pocketbase-limits` (with the existing imports).
2. Near `REALTIME_MODES`, add:

```ts
/** How long the first message on a `liveTopics` topic waits for others before the reload. */
export const LIVE_TOPIC_WINDOW_MS = 100
```

3. After `assertRealtimeMode(realtimeMode)`:

```ts
    const liveTopics = [...new Set(options?.liveTopics ?? [])]
    for (const topic of liveTopics) {
        if (topic === '' || topic.length > REALTIME_TOPIC_MAX_LENGTH) {
            throw new Error(
                `Collection '${collectionName}': each liveTopics entry must be 1 to ${REALTIME_TOPIC_MAX_LENGTH} characters`
            )
        }
    }
```

4. After the `reloadFor` function, add:

```ts
    // A window from the first message, not a trailing debounce: a steady
    // stream of messages still reloads once per window. reload() queues one
    // follow-up for a message that arrives during a fetch.
    function openLiveTopics(): () => void {
        if (liveTopics.length === 0) return () => undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        let closed = false
        const onMessage = () => {
            if (timer !== undefined) return
            timer = setTimeout(() => {
                timer = undefined
                reloadFor('live topic')
            }, LIVE_TOPIC_WINDOW_MS)
        }
        const pending = liveTopics.map(topic =>
            transport.subscribeTopic(topic, onMessage).then(
                unsubscribe => {
                    if (closed) {
                        void unsubscribe()
                        return undefined
                    }
                    // A load that finished before the server had the topic
                    // may predate a change no message reported to us.
                    if (collection.isReady()) reloadFor('live topic confirmed')
                    return unsubscribe
                },
                (error: unknown) => {
                    logger.error('Failed to subscribe to a live topic', {
                        collectionName,
                        topic,
                        error,
                    })
                    return undefined
                }
            )
        )
        return () => {
            closed = true
            if (timer !== undefined) clearTimeout(timer)
            timer = undefined
            for (const unsubscribe of pending) void unsubscribe.then(fn => fn?.())
        }
    }
```

5. In the `status:change` handler, inside the `if (!removeTransportListeners && …)` branch, add `const removeLiveTopics = openLiveTopics()` and call `removeLiveTopics()` inside `removeTransportListeners`:

```ts
            const removeLiveTopics = openLiveTopics()
            removeTransportListeners = () => {
                removeLoadSource()
                removeReconnect()
                removeAuth()
                removeLiveTopics()
            }
```

6. `src/core.ts`: add `export { LIVE_TOPIC_WINDOW_MS } from './build-collection'` next to the existing `PbCollectionUtils` type export.

A non-resumed reconnect already reloads a ready collection whose record subscription is open (`transport.onReconnect` in the same block); every collection opens one in both realtime modes, so `liveTopics` needs no change there.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/nas/tmp/tinycld/books-purchases-pbtsdb && TEST=test/live-topics.test.ts npm test`
Expected: 6 passed.

- [ ] **Step 6: Document**

- `README.md`: in "### Change signals" (Task 7) add `liveTopics` with the view example, the 100 ms window, that it reloads once more when the topic is confirmed after the first load, and that it pairs with a server that signals a view's topic when the view's sources change. Add `liveTopics` to the `createCollection()` options list in "## API Reference".
- `llms.txt`: the option and `LIVE_TOPIC_WINDOW_MS`.
- `docs/internals.md`: one paragraph where collection lifecycle listeners are described (search for `onReconnect`): topics open with the transport listeners on `loading`/`ready` and close on `cleaned-up`; window from the first message; reload on confirmation when ready.
- `CHANGELOG.md` `### Added`: "`liveTopics` collection option: reload the collection on messages on custom realtime topics, coalesced over `LIVE_TOPIC_WINDOW_MS`; keeps view collections live with a server that sends change signals."

- [ ] **Step 7: Run the full checks**

Run: `cd /Users/nas/tmp/tinycld/books-purchases-pbtsdb && npm run checks && npm test`
Expected: clean typecheck and lint; every test file passes (the new view must not change other files' results; if one fails, find the root cause and fix it — never re-run to green).

- [ ] **Step 8: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases-pbtsdb
git add pb_migrations/1763880000_create_author_book_counts_view.js test/schema.ts src/types.ts src/build-collection.ts src/core.ts test/live-topics.test.ts README.md llms.txt docs/internals.md CHANGELOG.md
git commit -m "feat: liveTopics option reloads a collection on topic messages"
```

---

### Task 9: STOP for human approval to merge + publish pbtsdb 2.1.0

All Go work (Tasks 1–5), the core docs (Task 6) and the pbtsdb branch (Tasks 7–8) are done before this task. Nothing after it may start until the human confirms.

- [ ] **Step 1: Report and stop.** Tell the human:
  - pbtsdb branch `books/p5-change-signal` at `/Users/nas/tmp/tinycld/books-purchases-pbtsdb`, its commits (`git log --oneline a5c45d8..HEAD`), and the result of `npm run checks && npm test`.
  - The request: "stop for human approval to merge + publish pbtsdb 2.1.0" — open and merge the PR to `nathanstitt/pbtsdb` `main`, run `npm version 2.1.0` (moves `[Unreleased]` in `CHANGELOG.md` to `[2.1.0]` and commits `2.1.0`, as for 2.0.6), push the tag, and `npm publish`.
  - Decision 3 (signals only to signed-in clients) for confirmation.
- [ ] **Step 2: Wait.** Do not push, open a PR, version or publish unless the human says so in this stop.
- [ ] **Step 3: Verify the release** once the human confirms.

Run: `npm view pbtsdb@2.1.0 version`
Expected: `2.1.0`. If it prints nothing, the release is not out: stay stopped.

---

### Task 10: Core pins pbtsdb 2.1.0; topic helper for live views

Needs pbtsdb 2.1.0 on npm (Task 9).

**Files:**
- Modify: `$WS/tinycld/core/package-versions.json` (`"pbtsdb": "2.0.6"` → `"pbtsdb": "2.1.0"`)
- Modify: `$WS/tinycld/core/package.json` (`peerDependencies.pbtsdb`: `">=2.0.3 <3"` → `">=2.1.0 <3"`)
- Create: `$WS/tinycld/core/lib/change-signal.ts`
- Test: `$WS/tinycld/core/lib/change-signal.test.ts`

Do not edit the shell's `tinycld/package.json` `pbtsdb` entry or any root file: the pin reaches every member through the `overrides:` block that `scripts/write-workspace-root.ts` derives from `core/package-versions.json`.

**Interfaces:**
- Consumes: pbtsdb 2.1.0 `CreateCollectionOptions.liveTopics`, `subscribeTopic`.
- Produces (for `p5-report-engine`, `p5-report-builder` and packages with views):
  - `export function collectionTopic(name: string): string` — `collection/<name>`, the Go `changesignal.Topic` format.
  - `export function liveViewOptions(view: string): Pick<CreateCollectionOptions<Schema, keyof Schema>, 'liveTopics'>` — `{ liveTopics: [collectionTopic(view)] }`, spread into a view collection's options.

- [ ] **Step 1: Pin and install**

Edit the two files above, then:

Run: `cd /Users/nas/tmp/tinycld/books-purchases && pnpm install`
Then: `node -p "require('/Users/nas/tmp/tinycld/books-purchases/node_modules/pbtsdb/package.json').version"`
Expected: `2.1.0`. (Install only at the workspace root, never inside a member.)

- [ ] **Step 2: Write the failing test**

`core/lib/change-signal.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { collectionTopic, liveViewOptions } from './change-signal'

// The server's topic format (core/server/changesignal, Topic): the two
// sides must agree byte for byte, or a live view never hears its signal.
describe('change-signal topics', () => {
    it('names a collection topic as the server does', () => {
        expect(collectionTopic('zoo_animals')).toBe('collection/zoo_animals')
    })

    it('keeps a view live on its own topic', () => {
        expect(liveViewOptions('zoo_fed')).toEqual({ liveTopics: ['collection/zoo_fed'] })
    })
})
```

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld && /Users/nas/tmp/tinycld/books-purchases/node_modules/.bin/vitest run core/lib/change-signal.test.ts`
Expected: FAIL (cannot resolve `./change-signal`).

- [ ] **Step 3: Implement**

`core/lib/change-signal.ts`:

```ts
import type { Schema } from '@tinycld/core/types/pbSchema'
import type { CreateCollectionOptions } from 'pbtsdb'

// Topics of the server's data-free change signals (core/server/changesignal).
// A message on a topic says only that the collection, or a collection a view
// reads, changed; the subscriber fetches what it shows again.

/** The change-signal topic of a collection: `collection/<name>`. */
export function collectionTopic(name: string): string {
    return `collection/${name}`
}

/**
 * Options that keep a view collection live. The server signals the view's
 * own topic when a collection its SQL reads changes, as declared by the
 * package's `changesignal.RegisterView`.
 *
 * @example
 * newCollection('zoo_fed', { ...onDemand, ...liveViewOptions('zoo_fed') })
 */
export function liveViewOptions(view: string): Pick<CreateCollectionOptions<Schema, keyof Schema>, 'liveTopics'> {
    return { liveTopics: [collectionTopic(view)] }
}
```

Let Biome format the long signature (`biome format --write core/lib/change-signal.ts`).

- [ ] **Step 4: Run the checks**

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld && /Users/nas/tmp/tinycld/books-purchases/node_modules/.bin/vitest run core/lib/change-signal.test.ts`
Expected: 2 passed.

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld && /Users/nas/tmp/tinycld/books-purchases/node_modules/.bin/tinycld-pkg check`
Expected: biome, tsc and vitest pass for the `tinycld` member. (`pnpm exec tinycld-pkg check` triggers a workspace install here; call the binary directly.) A `Pick` of a key pbtsdb lacks fails tsc, so a green tsc also proves 2.1.0 is installed.

Run: `cd /Users/nas/tmp/tinycld/books-purchases/tinycld && /Users/nas/tmp/tinycld/books-purchases/node_modules/.bin/tsx scripts/check-core-isolation.ts && /Users/nas/tmp/tinycld/books-purchases/node_modules/.bin/tsx scripts/check-fork-drift.ts`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/nas/tmp/tinycld/books-purchases/tinycld
git add core/package-versions.json core/package.json core/lib/change-signal.ts core/lib/change-signal.test.ts
git commit -m "feat(core): pin pbtsdb 2.1.0; change-signal topic helpers for live views"
```

---

## Spec coverage

| Spec item (section 1, Testing, Risks, Security) | Task |
|---|---|
| Registry `changesignal`, topics `collection/<name>` | 1 |
| Hooks on OnModelAfter{Create,Update,Delete}Success, after commit | 2 |
| Send via `app.SubscriptionsBroker()`, coalesce per topic over 200 ms | 2 |
| Message carries no data; a test asserts it | 2 (`TestPayloadCarriesNoData`) |
| Raw SQL writes: `changesignal.Touch(app, collection)` | 3 |
| `RegisterView(view, sources...)`, declared list authoritative | 1, 2 (fan-out) |
| EXPLAIN `OpenRead` root-page proof of concept; test fails on an undeclared read | 4 (PoC probed: works) |
| pbtsdb `subscribeTopic(topic, onMessage)` | 7 |
| pbtsdb `liveTopics` → `collection.reload()`, debounced | 8 |
| A view collection opts in with its declared sources | 1 (server fan-out), 8 (`liveTopics`), 10 (`liveViewOptions`) |
| No fork change | all (no file under `third_party/pocketbase` changes) |
| Testing: after commit only, coalescing, empty payload, Touch, view dependency check | 2, 3, 4 |
| Testing: pbtsdb vitest for `subscribeTopic` and the debounced reload | 7, 8 |
| Risks: raw SQL writes — note in `docs/packages.md` | 6 |
| Security: change-signal messages carry no data | 2 |
| Pin in `core/package-versions.json`; publish human-gated | 9, 10 |
| Help topic: none (not user-facing) | decision 8 |
