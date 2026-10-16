// core/lib/editor/rich/__tests__/use-rich-editor.test.tsx
// @vitest-environment happy-dom
import { render, waitFor } from '@testing-library/react'
import { useEffect, useLayoutEffect } from 'react'
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import type { EditorResult } from '../../types'
import { useRichEditor } from '../use-rich-editor.web'

/**
 * Readiness on web, and the marker a collaborative surface carries.
 *
 * A configuration change (a handover's `generation`, or a new collaborative
 * document) makes tiptap replace its instance, but it does so in an EFFECT. The
 * render in between still hands back the outgoing instance, and the app's one
 * shared editor publishes whatever this hook returns to the surface that just
 * took it. Reporting that instance as ready is what let a surface render, and
 * focus, an editor that was about to be destroyed.
 */

interface Captured {
    result: EditorResult | null
}

interface Committed {
    isReady: boolean
    text: Promise<string>
}

function Harness({
    content,
    generation,
    captured,
    committed,
}: {
    content: string
    generation: number
    captured: Captured
    committed?: Committed[]
}) {
    const result = useRichEditor({ initialContent: content, generation })
    // A layout effect runs after the commit and BEFORE tiptap's own effect
    // swaps the instance, so it sees exactly what a consumer of this commit
    // sees. getText reads synchronously; only its wrapper is a promise.
    useLayoutEffect(() => {
        committed?.push({ isReady: result.isReady ?? false, text: result.editor.getText() })
    })
    useEffect(() => {
        captured.result = result
    }, [result, captured])
    return <result.EditorComponent />
}

test('a result is not ready while it still holds the instance built for the previous generation', async () => {
    const captured: Captured = { result: null }
    const committed: Committed[] = []

    const { rerender } = render(
        <Harness content="<p>alpha</p>" generation={0} captured={captured} />
    )
    await waitFor(() => expect(captured.result?.isReady).toBe(true))

    rerender(
        <Harness content="<p>beta</p>" generation={1} captured={captured} committed={committed} />
    )
    await waitFor(async () => expect(await captured.result?.editor.getText()).toContain('beta'))

    const readyTexts = await Promise.all(
        committed.filter(commit => commit.isReady).map(commit => commit.text)
    )
    expect(readyTexts.length).toBeGreaterThan(0)
    for (const text of readyTexts) expect(text).not.toContain('alpha')
})

function CollabHarness({ document }: { document: Y.Doc | null }) {
    const result = useRichEditor({
        collab: document ? { document, field: 'card:one' } : undefined,
    })
    return <result.EditorComponent />
}

test('a collaborative editor carries the bound marker', async () => {
    const { container } = render(<CollabHarness document={new Y.Doc()} />)

    await waitFor(() =>
        expect(container.querySelector('.ProseMirror')?.getAttribute('data-collab-ready')).toBe(
            'true'
        )
    )
})

test('a local editor is marked as not collaborative', async () => {
    const { container } = render(<CollabHarness document={null} />)

    await waitFor(() =>
        expect(container.querySelector('.ProseMirror')?.getAttribute('data-collab-ready')).toBe(
            'false'
        )
    )
})
