package coreserver

import (
	"context"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"tinycld.org/core/background"
	"tinycld.org/core/readonly"
)

// bootMailFn emails a notice to every administrator. ctx ends the sends.
type bootMailFn func(ctx context.Context, app core.App, n notice) error

const bootNoticesDroppedMsg = "boot notices dropped: the server stayed read-only past the wait; the next boot sends them again"

// startBootNotices tells administrators what the last boot found (a backup a
// rollback could not restore, an automatic upgrade that was rolled back) on
// the job runner. A send can wait on a mail server or a push service for many
// seconds, and the supervisor waits only 60 s for ready, which is sent after
// the OnServe chain: a send in the chain could turn a good boot into a
// failed one.
//
// The job writes to the database, so the runner holds the app's terminate
// until it ends. The terminate also ends the job's ctx, which ends every
// send, so what it waits for is a few database writes.
func startBootNotices(app core.App, mail bootMailFn) {
	background.For(app, "coreserver").Run("boot notices", func(jobCtx context.Context) {
		ctx, cancel := context.WithTimeout(jobCtx, readonly.TailWait)
		defer cancel()
		err := readonly.WhenWritable(ctx, func() error {
			reportUnrestored(jobCtx, app, mail)
			reconcileAutoUpgradeResults(app, time.Now(), func(n notice) {
				// send logs each failure; a blocked-upgrade notice is not retried.
				_ = mail(jobCtx, app, n)
			})
			return nil
		})
		if err != nil {
			srvLog.Warn(bootNoticesDroppedMsg, "err", err)
		}
	})
}

// mailAdmins is the production bootMailFn.
func mailAdmins(ctx context.Context, app core.App, n notice) error {
	return notifyAdmins(app, func(name, email, subj, html, text string) error {
		return sendContext(ctx, app, name, email, subj, html, text)
	}, n)
}
