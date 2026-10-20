package pkgbuild

import "context"

// Hooks for the external test package (pkgbuild_test), which must stay
// external so it can import pkgbuildtest without a test import cycle.
var FetchMemberWith = fetchMemberWith

func CopyScaffoldExtras(srcRoot, buildDir string) error {
	return copyScaffoldExtras(context.Background(), srcRoot, buildDir)
}

type PackFn = packFn
