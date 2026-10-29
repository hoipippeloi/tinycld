// Custom bundle entry. `main` in package.json points here instead of straight at
// `expo-router/entry` so the crypto polyfill is installed before ANY route module
// is evaluated.
//
// Why this can't live in app/_layout.tsx: expo-router's entry pulls in
// `_ctx` (the require.context over `app/`), which eagerly requires the WHOLE
// route tree — app/(app)/_layout.tsx and everything it imports — during the
// static import graph, BEFORE app/_layout.tsx's own module body runs. That path
// reaches core/lib/pocketbase.ts (via DemoFollowUpModal → lib/auth), whose
// module scope calls createCollection(), and @tanstack/db's collection
// constructor calls crypto.randomUUID() at init. Hermes has no global crypto, so
// the app died at launch with "Property 'crypto' doesn't exist" before any
// handler could report it.
//
// Measured on the emitted iOS bundle (module init order): pocketbase.ts ran at
// eager position 1682 while lib/polyfill-crypto.ts ran at 4669. Import order
// inside app/_layout.tsx is irrelevant — the router had already walked the tree.
// Installing it here puts the polyfill at the front of the graph, ahead of the
// route context, which is the only position that can win that race.
// Every import below uses a RELATIVE specifier on purpose: this file is the
// bundle entry, resolved before any alias-dependent module, so it must not rely
// on tsconfig `paths` (`~/*`).

// diagnose-regexp must run FIRST — it wraps the global RegExp constructor to
// record the exact pattern compiled before a fatal. A regex Hermes can't handle
// aborts the process (RCTFatal/SIGABRT) before any handler sees which pattern,
// and the native crash report only shows `regExpConstructor` with no source.
// This shim is the primary diagnostic for the OTA-update crash; its captures are
// read by the global fatal handler + the report-bad upload. No-op on web/non-Hermes.
import './lib/diagnose-regexp'
// polyfill-dom-shim must run before anything that pulls in prosemirror-view
// (@tinycld/core/lib/editor/rich → @tiptap/* → @tiptap/pm/view, reached at RN
// top level by the shared editor's extensions). Something in our Expo SDK 55 stack
// installs a partial `document` on Hermes that breaks prosemirror-view's
// top-level browser sniff; the shim fills the missing `documentElement.style`
// slot. See lib/polyfill-dom-shim.ts for the why. This had the same too-late
// problem as crypto — it ran at init position 4673 while prosemirror-view
// initialized at 4266 — so hoisting it here fixes that latent bug too.
import './lib/polyfill-dom-shim'
// polyfill-crypto installs crypto.randomUUID (see the header comment above for
// why this position, and not app/_layout.tsx, is the one that works).
import './lib/polyfill-crypto'
// capture-server-handoff must run before expo-router reads the URL on web; see
// core/lib/server-handoff-capture.ts.
import './lib/capture-server-handoff'

// The three lines below are expo-router/entry inlined, with one change: on
// web the route chunks for the opening URL are fetched BEFORE the first
// render. Expo Router wraps each route in React.lazy; a chunk that is already
// loaded resolves synchronously and mounts with no Suspense fallback, which is
// what skips React's 300ms fallback throttle per nested layout. See
// lib/route-prefetch.ts. `@expo/metro-runtime` must stay the first of these
// imports (Fast Refresh on web).
import '@expo/metro-runtime'
import { App } from 'expo-router/build/qualified-entry'
import { renderRootComponent } from 'expo-router/build/renderRootComponent'
import { prefetchBootRoutes } from './lib/route-prefetch'

// Native registers the root synchronously, during bundle evaluation; only the
// web prefetch returns a promise to wait on.
const bootRoutes = prefetchBootRoutes()
if (bootRoutes) {
    bootRoutes.then(() => renderRootComponent(App))
} else {
    renderRootComponent(App)
}
