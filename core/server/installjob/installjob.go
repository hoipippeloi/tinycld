// Package installjob owns the "one package operation at a time" interlock of
// each app and the job it tracks.
//
// It exists as its own package because MORE THAN ONE composition serves the
// package-install API: the deployment that rebuilds itself in process, and one
// whose deploys ride a supervisor's control socket. Both must see the SAME
// running job for an app — the interlock is what stops two operations mutating
// one data dir at once. The interlock lives on the app, so every package that
// reaches it through this one sees the same slot, and two apps in one process
// never see each other's.
//
// The mutex is deliberately NOT exported. Callers claim, read, or release
// through the functions here, so there is no way to hold the lock across a
// caller's own work and no second lock ordering to reason about.
package installjob

import (
	"crypto/rand"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/appstate"
)

// Event is one server-sent event on a job's progress stream.
type Event struct {
	Event string `json:"event"`
	Data  any    `json:"data"`
}

// ProgressData is the payload of a "progress" Event.
type ProgressData struct {
	Step     string `json:"step"`
	Progress int    `json:"progress"`
	Message  string `json:"message"`
	// StepProgress is the current step's own completion (0-100), sent only by
	// a step that can measure it.
	StepProgress *int `json:"stepProgress,omitempty"`
}

// CompleteData is the payload of a "complete" Event.
type CompleteData struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

// VersionChange is one {slug → target version} entry of a version_change
// operation. It lives here because Job carries the ordered set.
type VersionChange struct {
	Slug          string `json:"slug"`
	TargetVersion string `json:"targetVersion"`
}

// Job is one package operation. Its exported fields are set by the composition
// that claimed it; the listener set and the fields Progress/Step/LogLines are
// mutated only through this package's methods, which hold the per-job lock.
type Job struct {
	ID      string
	Action  string // "install", "uninstall", "revert", or "version_change"
	Slug    string
	NpmPkg  string
	BuildID string // revert target (action == "revert")
	// Changes is the ordered set a version_change applies together.
	Changes []VersionChange
	// Trigger says who started the job: "manual" (a person) or "auto" (the
	// upgrade scheduler). Recorded on the install log so a boot after a
	// rollback can tell the two apart.
	Trigger  string
	Progress int
	Step     string
	Status   string // "running", "success", "failed", "rolled_back"
	Error    string
	LogLines []string
	Done     chan struct{}

	mu        sync.Mutex
	listeners []chan Event
	// owner is the interlock Claim gave this job, so Release clears that
	// app's slot and no other.
	owner atomic.Pointer[interlock]
}

// ---------- the interlock ----------

// interlock is one app's single-flight slot.
type interlock struct {
	mu      sync.Mutex
	current *Job
	// held is set once the app's process has asked to be replaced and keeps
	// running until it is stopped. From then on the interlock never clears:
	// any new job would work on data and a build that the next process
	// already owns.
	held bool
}

var interlockKey = appstate.NewKey[*interlock]("installjob.interlock")

func interlockOf(app core.App) *interlock {
	return interlockKey.GetOrInit(app, func() *interlock { return &interlock{} })
}

// New mints a job with an open Done channel. It does NOT claim the interlock
// — pass it to Claim.
//
// The id is a timestamp plus a random suffix. Several apps in one process
// can each start an operation in the same millisecond, and the install
// progress savers are keyed by job id, so a timestamp alone would let one
// app's progress land on another app's log row.
func New(action, slug, npmPkg string) *Job {
	return &Job{
		ID:     fmt.Sprintf("job_%d_%s", time.Now().UnixMilli(), strings.ToLower(rand.Text()[:8])),
		Action: action,
		Slug:   slug,
		NpmPkg: npmPkg,
		Status: "running",
		Done:   make(chan struct{}),
	}
}

// Claim installs job as app's running one, or reports the job already
// running. The check and the set happen under one lock, so two callers racing
// cannot both believe they won.
func Claim(app core.App, job *Job) (busy *Job, ok bool) {
	il := interlockOf(app)
	il.mu.Lock()
	defer il.mu.Unlock()
	if il.current != nil {
		return il.current, false
	}
	il.current = job
	job.owner.Store(il)
	return nil, true
}

// Current reports app's running job, or nil.
func Current(app core.App) *Job {
	il := interlockOf(app)
	il.mu.Lock()
	defer il.mu.Unlock()
	return il.current
}

// Running reports whether any job holds app's interlock.
func Running(app core.App) bool {
	return Current(app) != nil
}

// Release clears the interlock job was claimed on. Safe to call on a job that
// no longer holds it (a late unwind after a restart), or never did, which is
// why it compares before clearing.
func Release(job *Job) {
	il := job.owner.Load()
	if il == nil {
		return
	}
	il.mu.Lock()
	defer il.mu.Unlock()
	if il.current == job && !il.held {
		il.current = nil
	}
}

// HoldForReplacement keeps app's interlock claimed for the rest of the
// process, so Claim refuses every later job on app. The caller is normally the
// job that holds it; when nothing does, a placeholder job takes the slot, so a
// busy answer still has a job to describe.
func HoldForReplacement(app core.App) {
	il := interlockOf(app)
	il.mu.Lock()
	defer il.mu.Unlock()
	il.held = true
	if il.current == nil {
		placeholder := New("restart", "", "")
		placeholder.owner.Store(il)
		il.current = placeholder
	}
}

// Info is the shape the API returns for a busy interlock.
func (j *Job) Info() map[string]any {
	j.mu.Lock()
	defer j.mu.Unlock()
	return map[string]any{
		"jobId":  j.ID,
		"action": j.Action,
		"slug":   j.Slug,
		"status": j.Status,
	}
}

// ---------- per-job state ----------

// Subscribe adds a listener for this job's events and returns it. The channel
// is buffered; Emit drops rather than blocks, so a slow client cannot stall a
// running install.
func (j *Job) Subscribe(buffer int) chan Event {
	ch := make(chan Event, buffer)
	j.mu.Lock()
	defer j.mu.Unlock()
	j.listeners = append(j.listeners, ch)
	return ch
}

// SubscribeWithHistory adds a listener AND returns the job's state as of the
// same instant, under one lock. A late-connecting client needs both: the
// backlog it missed and the live stream, with no window between them where an
// event could be recorded into neither.
func (j *Job) SubscribeWithHistory(buffer int) (ch chan Event, history []string, status, errMsg string) {
	ch = make(chan Event, buffer)
	j.mu.Lock()
	defer j.mu.Unlock()
	j.listeners = append(j.listeners, ch)
	history = make([]string, len(j.LogLines))
	copy(history, j.LogLines)
	return ch, history, j.Status, j.Error
}

// Unsubscribe removes a listener.
func (j *Job) Unsubscribe(ch chan Event) {
	j.mu.Lock()
	defer j.mu.Unlock()
	for i, existing := range j.listeners {
		if existing == ch {
			j.listeners = append(j.listeners[:i], j.listeners[i+1:]...)
			return
		}
	}
}

// RecordProgress advances the job and fans the update out to its listeners.
// Returns the log line it recorded so the caller can log it with its own
// package's logger.
func (j *Job) RecordProgress(step string, progress int, message string) string {
	return j.record(ProgressData{Step: step, Progress: progress, Message: message})
}

// RecordStepProgress is RecordProgress plus the step's own completion. The log
// line keeps the plain format: a replay needs only the latest step progress,
// and the next live event carries it.
func (j *Job) RecordStepProgress(step string, progress, stepProgress int, message string) string {
	return j.record(ProgressData{Step: step, Progress: progress, Message: message, StepProgress: &stepProgress})
}

func (j *Job) record(pd ProgressData) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.Step = pd.Step
	j.Progress = pd.Progress
	line := fmt.Sprintf("[%d%%] %s: %s", pd.Progress, pd.Step, pd.Message)
	j.LogLines = append(j.LogLines, line)
	j.fanout(Event{Event: "progress", Data: pd})
	return line
}

// RecordComplete fans a terminal event out to the job's listeners.
func (j *Job) RecordComplete(status, errMsg string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.fanout(Event{Event: "complete", Data: CompleteData{Status: status, Error: errMsg}})
}

// AppendLog records a line without touching the progress percentage.
func (j *Job) AppendLog(line string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.LogLines = append(j.LogLines, line)
}

// Snapshot copies the log lines under the lock, for a reader that must not race
// a running job.
func (j *Job) Snapshot() []string {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]string, len(j.LogLines))
	copy(out, j.LogLines)
	return out
}

// fanout must be called with j.mu held. A listener that cannot keep up drops
// the event rather than blocking the install.
func (j *Job) fanout(evt Event) {
	for _, ch := range j.listeners {
		select {
		case ch <- evt:
		default:
		}
	}
}
