// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render as renderBare, waitFor } from '@testing-library/react'
import { useConnectivityStore } from '@tinycld/core/lib/stores/connectivity-store'
import { OverlayProvider } from '@tinycld/core/ui/overlay'
import { PromptDialog } from '@tinycld/core/ui/PromptDialog'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const render = (ui: ReactElement) => renderBare(<OverlayProvider>{ui}</OverlayProvider>)

function input(container: HTMLElement) {
    const el = container.querySelector<HTMLInputElement>('rn-textinput')
    if (!el) throw new Error('no input rendered')
    return el
}

describe('PromptDialog', () => {
    beforeEach(() => useConnectivityStore.setState({ isOnline: true, isServerReachable: true }))
    afterEach(cleanup)

    it('submits the trimmed value', async () => {
        const onSubmit = vi.fn()
        const { container, getByText } = render(
            <PromptDialog isOpen onClose={() => {}} onSubmit={onSubmit} title="Rename" />
        )
        // mode: 'onChange' validates asynchronously; let it settle so Save enables.
        await act(async () => {
            fireEvent.input(input(container), { target: { value: '  Roadmap  ' } })
        })
        await act(async () => {
            fireEvent.click(getByText('Save'))
        })
        await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Roadmap'))
    })

    it('does not submit a blank value when required', async () => {
        const onSubmit = vi.fn()
        const { container, getByText } = render(
            <PromptDialog isOpen onClose={() => {}} onSubmit={onSubmit} title="Rename" required />
        )
        await act(async () => {
            fireEvent.input(input(container), { target: { value: '   ' } })
        })
        await act(async () => {
            fireEvent.click(getByText('Save'))
        })
        expect(onSubmit).not.toHaveBeenCalled()
    })

    it('starts from defaultValue again after a reopen', () => {
        const props = { onClose: () => {}, onSubmit: () => {}, title: 'Rename' }
        const { container, rerender } = render(
            <PromptDialog isOpen {...props} defaultValue="Draft" />
        )
        fireEvent.input(input(container), { target: { value: 'typed then cancelled' } })
        rerender(
            <OverlayProvider>
                <PromptDialog isOpen={false} {...props} defaultValue="Draft" />
            </OverlayProvider>
        )
        rerender(
            <OverlayProvider>
                <PromptDialog isOpen {...props} defaultValue="Draft" />
            </OverlayProvider>
        )
        expect(input(container).value).toBe('Draft')
    })

    it('shows a server error under the input', () => {
        const { getByText } = render(
            <PromptDialog
                isOpen
                onClose={() => {}}
                onSubmit={() => {}}
                title="Rename"
                errorMessage="Name already taken"
            />
        )
        expect(getByText('Name already taken')).not.toBeNull()
    })
})
