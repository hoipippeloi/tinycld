// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ActionResultRow } from '../../components/rules/RunHistory'

// A skipped action is neither a success nor a failure: the run history names
// it "Skipped", gives the reason, and keeps the danger color for real errors.

afterEach(cleanup)

describe('ActionResultRow', () => {
    it('shows a skipped action as Skipped with its reason, in a neutral color', () => {
        const { container } = render(
            <ActionResultRow
                result={{
                    ref: 'core:send-email',
                    status: 'skipped',
                    message: 'The message was sent automatically.',
                }}
            />
        )
        expect(container.textContent).toContain('Skipped')
        expect(container.textContent).toContain('The message was sent automatically.')
        expect(container.innerHTML).not.toContain('text-danger')
        expect(container.innerHTML).not.toContain('text-success')
        expect(container.innerHTML).toContain('text-muted-foreground')
    })

    it('keeps the danger color for an error', () => {
        const { container } = render(
            <ActionResultRow
                result={{ ref: 'core:send-email', status: 'error', message: 'boom' }}
            />
        )
        expect(container.textContent).not.toContain('Skipped')
        expect(container.innerHTML).toContain('text-danger')
    })

    it('marks an ok action as a success', () => {
        const { container } = render(
            <ActionResultRow result={{ ref: 'core:send-email', status: 'ok' }} />
        )
        expect(container.textContent).not.toContain('Skipped')
        expect(container.innerHTML).toContain('text-success')
    })
})
