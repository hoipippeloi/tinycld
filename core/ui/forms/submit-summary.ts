import type { FieldErrors } from 'react-hook-form'

export type SubmitSummaryKind = 'all' | 'root'

interface SubmitSummaryState {
    errors: FieldErrors
    isSubmitted: boolean
    /** A wizard Next that failed counts as an attempt, before any submit. */
    attempted: boolean
}

/**
 * What the renderer's error summary lists and when it shows. `all` lists every
 * error once the form was submitted or a step attempted. `root` lists only the
 * no-field (server) error, and shows it whenever it exists: an edit save
 * patches without a submit, so `isSubmitted` would hide its refusal, and the
 * field errors already render inline in their cells. `root` reads only
 * `errors.root.message`: a nested root key (`errors.root.server`) is not
 * summarized.
 */
export function submitSummary(
    state: SubmitSummaryState,
    summary: SubmitSummaryKind
): { errors: FieldErrors; isEnabled: boolean } {
    if (summary === 'all')
        return { errors: state.errors, isEnabled: state.isSubmitted || state.attempted }
    if (!state.errors.root?.message) return { errors: {}, isEnabled: false }
    // A `{ root }` literal does not type-check: FieldErrors' index signature
    // clashes with its own `root` type, so the key is set on a typed object.
    const rootOnly: FieldErrors = {}
    rootOnly.root = state.errors.root
    return { errors: rootOnly, isEnabled: true }
}
