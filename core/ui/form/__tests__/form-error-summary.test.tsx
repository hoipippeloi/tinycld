// @vitest-environment happy-dom

import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useForm } from '..'
import { FormErrorSummary } from '../FormErrorSummary'

// Real errors from a real form, so the shapes match what RHF produces at runtime.
function useErrors() {
    const form = useForm({ defaultValues: { name: '' } })
    return { form, errors: form.formState.errors }
}

describe('FormErrorSummary', () => {
    afterEach(cleanup)

    it('labels a field error with its field name', () => {
        const { result } = renderHook(useErrors)
        act(() => result.current.form.setError('name', { type: 'server', message: 'Required' }))
        const { getByText } = render(<FormErrorSummary isEnabled errors={result.current.errors} />)
        expect(getByText('name: Required')).not.toBeNull()
    })

    it('omits the field name when showFieldNames is off', () => {
        const { result } = renderHook(useErrors)
        act(() => result.current.form.setError('name', { type: 'server', message: 'Required' }))
        const { getByText } = render(
            <FormErrorSummary isEnabled showFieldNames={false} errors={result.current.errors} />
        )
        expect(getByText('Required')).not.toBeNull()
    })

    it('shows a root error as a plain message', () => {
        const { result } = renderHook(useErrors)
        act(() =>
            result.current.form.setError('root', { type: 'server', message: 'Could not save' })
        )
        const { getByText, queryByText } = render(
            <FormErrorSummary isEnabled errors={result.current.errors} />
        )
        expect(getByText('Could not save')).not.toBeNull()
        expect(queryByText(/root/)).toBeNull()
    })

    it('shows a nested root error as a plain message', () => {
        const { result } = renderHook(useErrors)
        act(() =>
            result.current.form.setError('root.server', { type: 'server', message: 'Rate limited' })
        )
        const { getByText } = render(<FormErrorSummary isEnabled errors={result.current.errors} />)
        expect(getByText('Rate limited')).not.toBeNull()
    })

    it('hides the title when title is null and keeps the default title otherwise', () => {
        const { result } = renderHook(useErrors)
        act(() => result.current.form.setError('name', { type: 'server', message: 'Required' }))
        const hidden = render(
            <FormErrorSummary isEnabled title={null} errors={result.current.errors} />
        )
        expect(hidden.queryByText('Please fix the following errors:')).toBeNull()
        expect(hidden.getByText('name: Required')).not.toBeNull()
        cleanup()
        const shown = render(<FormErrorSummary isEnabled errors={result.current.errors} />)
        expect(shown.getByText('Please fix the following errors:')).not.toBeNull()
    })

    it('renders the destructive variant with a destructive border and messages', () => {
        const { result } = renderHook(useErrors)
        act(() => result.current.form.setError('name', { type: 'server', message: 'Required' }))
        const { container, getByText } = render(
            <FormErrorSummary
                isEnabled
                variant="destructive"
                testID="summary"
                errors={result.current.errors}
            />
        )
        expect(container.querySelector('[testid="summary"]')?.className).toContain(
            'border-destructive'
        )
        expect(getByText('name: Required').className).toContain('text-destructive')
    })
})
