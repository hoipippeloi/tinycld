package automation

import (
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
)

// runState is the engine's in-memory bookkeeping for one app: the provenance
// of its own writes, each rule's failure streak, and each rule's hourly send
// and post ceilings. It lives on the app, not in package variables: a rule
// id is unique only in its app, so a process-wide ledger would let one app's
// loop spend another app's ceiling or inherit its streak.
//
// In memory by design (see reserveEmailSend): a count that cannot be read
// must never be taken as permission to send.
type runState struct {
	engineWrites   sync.Map // recordID -> engineWrite
	failureStreaks sync.Map // ruleID -> int

	emailMu    sync.Mutex
	emailSends map[string][]time.Time // ruleID -> sends inside the rolling hour

	webhookMu    sync.Mutex
	webhookPosts map[string][]time.Time // ruleID -> posts inside the rolling hour
}

var runStateKey = appstate.NewKey[*runState]("automation.runState")

func runStateFor(app core.App) *runState {
	return runStateKey.GetOrInit(app, func() *runState {
		return &runState{
			emailSends:   map[string][]time.Time{},
			webhookPosts: map[string][]time.Time{},
		}
	})
}
