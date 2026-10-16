import { useToastStore } from '@tinycld/core/lib/stores/toast-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { widgetHost } from '../../../lib/forms/__tests__/fixtures'
import { formErrorHandler, mapHostErrors } from '../form-error-handler'

vi.mock('@tinycld/core/lib/pocketbase', () => ({
    notificationsCollection: {
        insert: vi.fn(() => ({ when: () => Promise.resolve() })),
    },
}))
vi.mock('@tinycld/core/lib/notifications', () => ({
    showOsNotification: vi.fn(() => Promise.resolve()),
}))

// The shape the PocketBase SDK rejects with: ClientResponseError.response is
// the parsed body, whose `data` maps each failing field to { code, message }.
function clientResponseError(data: Record<string, { code: string; message: string }>) {
    return {
        status: 400,
        message: 'Failed to update record.',
        response: { code: 400, message: 'Failed to update record.', data },
    }
}

function fakeForm(values: Record<string, unknown>) {
    return { setError: vi.fn(), getValues: () => values }
}

describe('mapHostErrors', () => {
    it('strips the json column prefix and lifts the form column to the root', () => {
        expect(
            mapHostErrors(widgetHost, {
                'fields.steps': 'Steps is required',
                due: 'Due is required',
                form: 'This form does not belong to this record type.',
            })
        ).toEqual({
            root: 'This form does not belong to this record type.',
            fields: { steps: 'Steps is required', due: 'Due is required' },
        })
    })
})

describe('formErrorHandler', () => {
    beforeEach(() => useToastStore.setState({ toasts: [] }))
    afterEach(() => useToastStore.setState({ toasts: [] }))

    it('puts a custom field error on the field', () => {
        const form = fakeForm({ name: 'n', steps: '' })
        formErrorHandler(
            widgetHost,
            form
        )(
            clientResponseError({
                'fields.steps': { code: 'validation_required', message: 'Steps is required' },
            })
        )
        expect(form.setError).toHaveBeenCalledWith(
            'steps',
            expect.objectContaining({ message: 'Steps is required' })
        )
        expect(useToastStore.getState().toasts).toHaveLength(0)
    })

    it('puts an error about the record form on the form root', () => {
        const form = fakeForm({ name: 'n' })
        formErrorHandler(
            widgetHost,
            form
        )(
            clientResponseError({
                form: { code: 'validation_unknown_form', message: 'Wrong form' },
            })
        )
        expect(form.setError).toHaveBeenCalledWith(
            'root',
            expect.objectContaining({ message: 'Wrong form' })
        )
        expect(useToastStore.getState().toasts).toHaveLength(0)
    })

    it('falls back to a toast for a key the form does not have', () => {
        const form = fakeForm({ name: 'n' })
        formErrorHandler(
            widgetHost,
            form
        )(clientResponseError({ 'fields.ghost': { code: 'x', message: 'Unknown field ghost' } }))
        expect(form.setError).not.toHaveBeenCalled()
        const toasts = useToastStore.getState().toasts
        expect(toasts).toHaveLength(1)
        expect(toasts[0].body).toContain('Failed to update record.')
    })

    it('falls back to a toast for an error that is not a validation error', () => {
        const form = fakeForm({ name: 'n' })
        formErrorHandler(widgetHost, form)(new Error('Network unreachable'))
        expect(useToastStore.getState().toasts[0].body).toContain('Network unreachable')
    })
})
