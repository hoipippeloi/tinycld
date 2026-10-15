import type { SplitValues } from '@tinycld/core/lib/forms/values'
import { useEffect, useRef } from 'react'
import type { useFormEdit } from './use-form-edit'

type Edit = Pick<ReturnType<typeof useFormEdit>, 'form' | 'patch' | 'markSaved'>

export const AUTO_PATCH_DELAY_MS = 400

/**
 * Saves an edit form as the user changes it: each change restarts a short
 * timer; when it fires, `patch()` collects the dirty keys, `save` writes them
 * and the keys are marked saved. A change that lands while a save is in
 * flight waits for it, so two writes never race. A `reset` (the live row
 * arriving) leaves nothing dirty, so it saves nothing.
 *
 * Subscribes to the form outside React's render cycle (`form.subscribe`), so
 * typing never re-renders the screen that owns the form.
 */
export function useAutoPatch(
    edit: Edit,
    save: (split: SplitValues) => Promise<void>,
    delayMs = AUTO_PATCH_DELAY_MS
) {
    const latest = useRef({ edit, save })
    latest.current = { edit, save }
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const inFlight = useRef<Promise<void> | null>(null)
    const queued = useRef(false)
    // `form.formState` is a render-time snapshot and goes stale without re-renders; the subscription is the live source.
    const isDirty = useRef(false)

    useEffect(() => {
        const run = async () => {
            if (inFlight.current) {
                queued.current = true
                return
            }
            const { edit: current, save: write } = latest.current
            if (!isDirty.current) return
            inFlight.current = (async () => {
                const split = await current.patch()
                if (!split) return
                await write(split)
                current.markSaved([
                    ...Object.keys(split.columns),
                    ...Object.keys(split.fields),
                    ...Object.keys(split.rows),
                ])
            })().finally(() => {
                inFlight.current = null
                if (queued.current) {
                    queued.current = false
                    void run()
                }
            })
            await inFlight.current
        }
        const schedule = () => {
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => void run(), delayMs)
        }
        const unsubscribe = edit.form.subscribe({
            formState: { values: true, isDirty: true },
            callback: state => {
                isDirty.current = Boolean(state.isDirty)
                if (isDirty.current) schedule()
            },
        })
        return () => {
            unsubscribe()
            if (timer.current) clearTimeout(timer.current)
        }
    }, [edit.form, delayMs])
}
