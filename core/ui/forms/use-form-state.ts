import type { FormDefinition } from '@tinycld/core/lib/forms/definition'
import { type EvalContext, evaluate, type FormValues } from '@tinycld/core/lib/forms/logic'
import { buildSchema } from '@tinycld/core/lib/forms/values'
import type { FormHost } from '@tinycld/core/lib/packages/derive-form-hosts'
import { useMemo, useRef } from 'react'
import { type Control, type UseFormSetValue, useWatch } from 'react-hook-form'

/**
 * The effective state for the current values, recomputed on every change.
 * set_value actions fire once, when their rule becomes active; the ref holds
 * which rules were active on the last pass so a user's later edit is kept.
 */
export function useFormState(
    def: FormDefinition,
    host: FormHost,
    control: Control<FormValues>,
    ctx: EvalContext,
    setValue?: UseFormSetValue<FormValues>
) {
    const values = useWatch({ control }) as FormValues
    const previouslyActive = useRef<Set<string>>(new Set())
    const state = useMemo(() => evaluate(def, values, ctx), [def, values, ctx])
    const schema = useMemo(() => buildSchema(def, host, state), [def, host, state])
    const newlyActive = state.activeRules.filter(k => !previouslyActive.current.has(k))
    previouslyActive.current = new Set(state.activeRules)
    if (setValue && newlyActive.length > 0) {
        for (const r of def.rules) {
            if (!newlyActive.includes(r.key)) continue
            for (const a of r.actions) {
                if (a.action === 'set_value' && a.field in state.setValues) {
                    setValue(a.field, state.setValues[a.field])
                }
            }
        }
    }
    return { state, schema, values }
}

export type UseFormStateResult = ReturnType<typeof useFormState>
