import {
    type Attributes,
    type ComponentType,
    createElement,
    type FunctionComponent,
    use,
} from 'react'

type ChunkModule<P> = { default: ComponentType<P> }

// Expo's async-require (expo/src/async-require/asyncRequireModule.ts) returns a
// promise that also carries `_result`: the module itself when the split chunk
// has already run (web) or the bundle is not split (native), otherwise a
// promise. Expo Router reads the same field to mount a loaded route without
// suspending; this helper does the same for our own lazy components.
type ChunkPromise<P> = Promise<ChunkModule<P>> & { _result?: unknown }

// The thenable protocol React's `use` reads: a fulfilled thenable is returned
// synchronously, with no suspension.
type FulfilledChunk<P> = Promise<ChunkModule<P>> & { status: 'fulfilled'; value: ChunkModule<P> }

export type PreloadableComponent<P> = FunctionComponent<P> & {
    /** Start loading the chunk now so the first render mounts without a fallback. */
    preload: () => Promise<unknown>
}

function loadedModule<P>(pending: ChunkPromise<P>): ChunkModule<P> | null {
    const result = pending._result
    if (result && typeof result === 'object' && !('then' in result)) {
        return result as ChunkModule<P>
    }
    return null
}

function asFulfilled<P>(loaded: ChunkModule<P>): FulfilledChunk<P> {
    return Object.assign(Promise.resolve(loaded), { status: 'fulfilled' as const, value: loaded })
}

/**
 * A lazily imported component, minus the Suspense fallback once its chunk is
 * loaded.
 *
 * `React.lazy` always suspends on the first render, even when the browser
 * already has the chunk: it commits a fallback and then waits out React's
 * 300ms Suspense throttle before the content can commit. `use` returns a
 * fulfilled thenable synchronously, so a chunk that was preloaded mounts on
 * its first render with no fallback and no throttle. A chunk still in flight
 * suspends exactly as with `React.lazy`. The chunk stays its own bundle,
 * fetched on demand: only the timing of the first mount changes.
 */
export function lazyChunk<P extends object>(
    factory: () => Promise<ChunkModule<P>>
): PreloadableComponent<P> {
    let pending: Promise<ChunkModule<P>> | null = null
    const load = () => {
        if (pending) return pending
        const started = factory() as ChunkPromise<P>
        const loaded = loadedModule(started)
        pending = loaded ? asFulfilled(loaded) : started
        return pending
    }
    const Component: FunctionComponent<P> = props => {
        const chunk = use(load())
        return createElement(chunk.default, props as Attributes & P)
    }
    return Object.assign(Component, { preload: load })
}
