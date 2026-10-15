// Side-effect import from the bundle entry (index.js): removes a web server
// handoff from the URL before the router reads it. No-op on native.
import { captureServerHandoff } from '@tinycld/core/lib/server-handoff-capture'

captureServerHandoff()
