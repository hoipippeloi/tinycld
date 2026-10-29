// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gizmos, partsDefinition } from '../../../lib/forms/__tests__/table-fixtures'
import { byTestId, TableHarness } from './table-harness'

afterEach(cleanup)

describe('table validation in the renderer', () => {
    it('a wizard Next with an empty required cell shows the column message', async () => {
        const onSubmit = vi.fn()
        const { container } = render(
            <TableHarness
                host={gizmos}
                definition={partsDefinition}
                initialValues={{ name: 'N', parts: [] }}
                layout="wizard"
                onSubmit={onSubmit}
            />
        )
        fireEvent.click(byTestId(container, 'form-table-parts-add'))
        fireEvent.click(byTestId(container, 'form-wizard-next'))
        await waitFor(() => expect(container.textContent).toContain('Label is required'))
        expect(container.textContent).toContain('Qty is required')
        expect(container.textContent).not.toContain('expected')
        expect(onSubmit).not.toHaveBeenCalled()
    })
})
