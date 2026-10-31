package coreserver

import (
	"context"

	"github.com/pocketbase/pocketbase/core"
	"tinycld.org/core/installjob"
	"tinycld.org/core/pkgbuild"
	"tinycld.org/core/syscfg"
)

// runBuildPipeline turns an assembled build dir into a runnable one via the
// shared pkgbuild pipeline. The Pipeline value is constructed PER INVOCATION,
// not at init: binaryName is set by Register() after package init, and
// the app's SystemConfig values (the Sentry keys the export steps read) must be the
// live settings at build time.
func runBuildPipeline(ctx context.Context, app core.App, job *installjob.Job, buildDir, buildID string) (buildOutput, error) {
	p := pkgbuild.Pipeline{
		BinaryName: binaryName,
		// Through the seam, not SystemSettings(app) directly. A self-rebuild only ever
		// runs on a deployment that administers its own settings — an org on a
		// managed deployment never registers the install endpoints, because its
		// supervisor owns its deploys — so the two resolve identically today.
		// Using the seam keeps that true if a supervising composition ever gains
		// this path, rather than silently building with an empty Sentry DSN.
		ConfigValue: func(key string) string { return syscfg.Get(app, key) },
	}
	return p.ExecuteContext(ctx, installJobSink{job}, buildDir, buildID)
}
