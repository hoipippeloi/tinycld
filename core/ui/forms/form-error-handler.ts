import {
    errorToString,
    extractValidationErrors,
    type FormErrorHandler,
    handleMutationErrorsWithForm,
} from '@tinycld/core/lib/errors'
import type { FormHostDef } from '@tinycld/core/lib/forms/host'
import type { FormValues } from '@tinycld/core/lib/forms/logic'

export interface HostFieldErrors {
    /** A message about the record's form as a whole. */
    root?: string
    /** Messages keyed by the form's own field keys. */
    fields: Record<string, string>
}

type HostColumns = Pick<FormHostDef, 'fieldsColumn' | 'formColumn'>

/**
 * Maps the host hook's error keys onto the form: `<fieldsColumn>.<key>`
 * becomes `<key>`, and `<formColumn>` (the record's form itself) becomes a
 * form-level message. A built-in column error already uses the field key.
 */
export function mapHostErrors(host: HostColumns, errors: Record<string, string>): HostFieldErrors {
    const prefix = `${host.fieldsColumn}.`
    const out: HostFieldErrors = { fields: {} }
    for (const [key, message] of Object.entries(errors)) {
        if (key === host.formColumn) out.root = message
        else out.fields[key.startsWith(prefix) ? key.slice(prefix.length) : key] = message
    }
    return out
}

/**
 * The `onError` for a host's create or update mutation: server field errors
 * land on their fields, a form-level error on the form root, and anything
 * else goes to `handleMutationErrorsWithForm` (a toast).
 */
export function formErrorHandler(
    host: HostColumns,
    form: Pick<FormErrorHandler<FormValues>, 'setError' | 'getValues'>,
    operation?: string
) {
    const delegate = handleMutationErrorsWithForm({
        setError: form.setError,
        getValues: form.getValues,
        operation,
    })
    return (error: unknown) => {
        const found = extractValidationErrors(error)
        if (!found) {
            delegate(error)
            return
        }
        const { root, fields } = mapHostErrors(host, found)
        if (root) form.setError('root', { type: 'server', message: root })
        if (Object.keys(fields).length === 0) return
        // Re-keyed for the form; a key the form does not know still ends in the toast.
        delegate({ message: errorToString(error), errors: fields })
    }
}
