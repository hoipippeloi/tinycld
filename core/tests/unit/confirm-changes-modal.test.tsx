// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render as renderBare, waitFor } from '@testing-library/react'
import { useConnectivityStore } from '@tinycld/core/lib/stores/connectivity-store'
import { OverlayProvider } from '@tinycld/core/ui/overlay'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmChangesModal } from '../../components/setup/version-apply'

const render = (ui: ReactElement) => renderBare(<OverlayProvider>{ui}</OverlayProvider>)

const noDrops = async () => ({ droppedCollections: [], droppedFields: [] })

function input(container: HTMLElement) {
    const el = container.querySelector<HTMLInputElement>('rn-textinput')
    if (!el) throw new Error('no input rendered')
    return el
}

async function type(container: HTMLElement, value: string) {
    // mode: 'onChange' validates asynchronously; let it settle.
    await act(async () => {
        fireEvent.input(input(container), { target: { value } })
    })
}

async function press(el: HTMLElement) {
    await act(async () => {
        fireEvent.click(el)
    })
}

const downgrades = [
    { slug: 'mail', targetVersion: '1.0.0', isDowngrade: true },
    { slug: 'drive', targetVersion: '2.0.0', isDowngrade: true },
]

describe('ConfirmChangesModal', () => {
    beforeEach(() => useConnectivityStore.setState({ isOnline: true, isServerReachable: true }))
    afterEach(cleanup)

    it('applies only once every downgraded slug is typed', async () => {
        const onConfirm = vi.fn(async () => {})
        const { container, getByText } = render(
            <ConfirmChangesModal
                isOpen
                pendingChanges={downgrades}
                hasDowngrade
                fetchDropReport={noDrops}
                onCancel={() => {}}
                onConfirm={onConfirm}
            />
        )

        await type(container, 'mail')
        await press(getByText('Downgrade'))
        expect(onConfirm).not.toHaveBeenCalled()

        await type(container, 'mail, drive')
        await press(getByText('Downgrade'))
        await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    })

    it('applies an upgrade-only set without typing', async () => {
        const onConfirm = vi.fn(async () => {})
        const { getByText } = render(
            <ConfirmChangesModal
                isOpen
                pendingChanges={[{ slug: 'mail', targetVersion: '3.0.0', isDowngrade: false }]}
                hasDowngrade={false}
                fetchDropReport={noDrops}
                onCancel={() => {}}
                onConfirm={onConfirm}
            />
        )
        // The form validates on mount before Apply enables.
        await act(async () => {})
        await press(getByText('Apply'))
        await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    })

    it('shows an apply failure inline', async () => {
        const onConfirm = vi.fn(async () => {
            throw new Error('backup failed')
        })
        const { container, getByText, findByText } = render(
            <ConfirmChangesModal
                isOpen
                pendingChanges={downgrades.slice(0, 1)}
                hasDowngrade
                fetchDropReport={noDrops}
                onCancel={() => {}}
                onConfirm={onConfirm}
            />
        )
        await type(container, 'mail')
        await press(getByText('Downgrade'))
        expect(await findByText('backup failed')).toBeTruthy()
    })
})
