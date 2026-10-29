import { log } from '@tinycld/core/lib/logger'
import { useEffect, useRef } from 'react'
import type { PatchResult, useFormEdit } from './use-form-edit'

type Edit = Pick<ReturnType<typeof useFormEdit>, 'form' | 'patch' | 'markSaved'>

export const AUTO_PATCH_DELAY_MS = 400

/**
 * Saves an edit form as the user changes it: each change restarts a short
 * timer; when it fires, `patch()` collects the dirty keys, `save` writes them
 * and the keys are marked saved. A change that lands while a save is in
 * flight waits for it, so two writes never race. A `reset` (the live row
 * arriving) leaves nothing dirty, so it saves nothing.
 *
 * `save` may throw: the error is logged, the keys stay dirty, and the next
 * change (or unmount) tries again. Pending changes are flushed on unmount.
 *
 * Subscribes to the form outside React's render cycle (`form.subscribe`), so
 * typing never re-renders the screen that owns the form.
 */
export function useAutoPatch(
    edit: Edit,
    save: (split: Omit<PatchResult, 'written'>) => Promise<void>,
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
                try {
                    const result = await current.patch()
                    if (!result) return
                    const { written, ...split } = result
                    await write(split)
                    current.markSaved(written)
                } catch (err) {
                    log.error('forms.auto-patch', err)
                }
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
            timer.current = setTimeout(() => {
                timer.current = null
                void run()
            }, delayMs)
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
            if (!timer.current) return
            clearTimeout(timer.current)
            timer.current = null
            void run()
        }
    }, [edit.form, delayMs])
}
