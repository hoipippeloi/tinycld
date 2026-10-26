import { createFormControl, type FieldErrors, type FieldValues } from 'react-hook-form'
import { describe, expect, it } from 'vitest'
import { submitSummary } from '../submit-summary'

type Form = ReturnType<typeof createFormControl<FieldValues>>

/**
 * The errors a real form holds after `set` runs. react-hook-form's type for
 * `errors.root` cannot be written as a literal, so the test builds it the way
 * a refusal does, with setError.
 */
function errorsAfter(set: (form: Form) => void): FieldErrors {
    const form = createFormControl<FieldValues>({ defaultValues: { name: '', email: '' } })
    let errors: FieldErrors = {}
    const stop = form.subscribe({
        formState: { errors: true },
        callback: state => {
            errors = { ...(state.errors ?? {}) }
        },
    })
    set(form)
    stop()
    return errors
}

const setFieldErrors = (form: Form) => {
    form.setError('name', { type: 'too_small', message: 'Name is required' })
    form.setError('email', { type: 'invalid_format', message: 'Enter a valid email' })
}
const setRootError = (form: Form) =>
    form.setError('root', {
        type: 'server',
        message: 'This record has sub-records, so it cannot be deleted.',
    })

const fieldErrors = errorsAfter(setFieldErrors)
const rootError = errorsAfter(setRootError)
const both = errorsAfter(form => {
    setFieldErrors(form)
    setRootError(form)
})

describe('the error fixtures', () => {
    it('hold the field and root errors the form was given', () => {
        expect(Object.keys(both).sort()).toEqual(['email', 'name', 'root'])
        expect(Object.keys(fieldErrors).sort()).toEqual(['email', 'name'])
        expect(rootError.root?.message).toBe(
            'This record has sub-records, so it cannot be deleted.'
        )
    })
})

describe("submitSummary with 'all'", () => {
    it('lists every error once the form was submitted or a step was attempted, as before', () => {
        expect(submitSummary({ errors: both, isSubmitted: true, attempted: false }, 'all')).toEqual(
            { errors: both, isEnabled: true }
        )
        expect(submitSummary({ errors: both, isSubmitted: false, attempted: true }, 'all')).toEqual(
            { errors: both, isEnabled: true }
        )
        expect(
            submitSummary({ errors: both, isSubmitted: false, attempted: false }, 'all')
        ).toEqual({ errors: both, isEnabled: false })
    })
})

describe("submitSummary with 'root'", () => {
    it('drops field errors and keeps only the root error', () => {
        const summary = submitSummary({ errors: both, isSubmitted: true, attempted: false }, 'root')
        expect(summary.errors).toEqual({ root: rootError.root })
        expect(summary.isEnabled).toBe(true)
    })

    it('shows a root error that no submit marked, as an edit save leaves it', () => {
        expect(
            submitSummary({ errors: rootError, isSubmitted: false, attempted: false }, 'root')
        ).toEqual({ errors: { root: rootError.root }, isEnabled: true })
    })

    it('stays hidden with only field errors, even after a submit', () => {
        expect(
            submitSummary({ errors: fieldErrors, isSubmitted: true, attempted: true }, 'root')
        ).toEqual({ errors: {}, isEnabled: false })
    })
})
