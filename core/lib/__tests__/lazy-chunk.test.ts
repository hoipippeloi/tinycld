import { createElement, Suspense } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { lazyChunk } from '../lazy-chunk'

const Hello = () => createElement('span', null, 'hello')

function render(Component: Parameters<typeof createElement>[0]) {
    return renderToString(
        createElement(Suspense, { fallback: 'loading' }, createElement(Component))
    )
}

describe('lazyChunk', () => {
    it('mounts a loaded chunk on the first render, with no fallback', () => {
        // What Expo's async-require returns once the chunk has run: a promise
        // whose `_result` is the module itself.
        const loaded = Object.assign(Promise.resolve({ default: Hello }), {
            _result: { default: Hello },
        })
        const html = render(lazyChunk(() => loaded))
        expect(html).toContain('hello')
        expect(html).not.toContain('loading')
    })

    it('still suspends while the chunk is loading', () => {
        const pending = Object.assign(Promise.resolve({ default: Hello }), {
            _result: Promise.resolve({ default: Hello }),
        })
        const html = render(lazyChunk(() => pending))
        expect(html).toContain('loading')
        expect(html).not.toContain('hello')
    })

    it('preload runs the import without rendering', () => {
        const factory = vi.fn(() => Promise.resolve({ default: Hello }))
        const Component = lazyChunk(factory)
        expect(factory).not.toHaveBeenCalled()
        Component.preload()
        expect(factory).toHaveBeenCalledTimes(1)
    })
})
