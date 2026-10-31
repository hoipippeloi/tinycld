package coreserver

// InjectPublicConfigForTest exposes the SPA shell's config injection to the
// external two-app tests, which cannot reach unexported code.
var InjectPublicConfigForTest = injectPublicConfig
