import type { FieldErrors } from 'react-hook-form'

/**
 * Whether a submit button gated on validity should be enabled.
 *
 * `setError()` forces `isValid` to false until the next validation, so after a
 * server refusal reported with `setError('root', …)` a button gated on
 * `isValid` alone stays disabled until the user edits a field — yet retrying
 * unchanged input is legitimate (a dropped connection, a wrong password the
 * user re-types in a password manager). A root error therefore never blocks
 * the button: `handleSubmit` still re-validates every field, and clears the
 * root error, before it calls the submit handler.
 */
export function isFormSubmittable({ isValid, errors }: { isValid: boolean; errors: FieldErrors }) {
    return isValid || errors.root !== undefined
}
