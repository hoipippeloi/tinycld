import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Platform } from 'react-native'
import { createFileDropController, extractDroppedFiles, isFileDrag } from './file-drop-controller'

interface UseFileDropOptions {
    onFiles: (files: File[]) => void
    /**
     * Whether this target takes files. A function is asked on each dragenter
     * and on drop, for a target whose answer is not known at render — one whose
     * answer depends on what it is drawn for — so a refusing target never
     * lights up.
     */
    isEnabled: boolean | (() => boolean)
    /**
     * A drop the gate refused, with its files, for a target that wants to say
     * why. With it, the drop is kept alive so the target can explain; without
     * it the cursor shows the refusal.
     */
    onRefused?: (files: File[]) => void
}

type RNViewRef = unknown

/**
 * Web-only drop-target hook for accepting files dragged from the OS.
 *
 * Returns a ref callback to attach to the drop-target React Native View. We attach
 * native DOM `dragenter` / `dragover` / `dragleave` / `drop` listeners imperatively
 * because react-native-web's <View> does not forward these events as props to the
 * underlying <div>. On native, the ref callback is a no-op and `isDragging` stays false.
 *
 * Drags that carry no OS files (in-page text or element drags) are ignored
 * entirely — no counter movement and no preventDefault, so their default
 * behavior is untouched. In-app card/tile drags (drax) never reach these
 * listeners at all: drax rides pointer gestures, not HTML5 drag events.
 *
 * Known gap: some browsers don't always fire a final `dragleave` when the user drags
 * out of the window entirely (over browser chrome or another app). The overlay can
 * "stick" until the next drag activity. Listening for `drop` resets reliably; the
 * stuck-overlay case clears on the next dragenter.
 */
export function useFileDrop({ onFiles, isEnabled, onRefused }: UseFileDropOptions): {
    isDragging: boolean
    dropRef: (node: RNViewRef) => void
} {
    const [isDragging, setIsDragging] = useState(false)
    const onFilesRef = useRef(onFiles)
    onFilesRef.current = onFiles
    const isEnabledRef = useRef(isEnabled)
    isEnabledRef.current = isEnabled
    const onRefusedRef = useRef(onRefused)
    onRefusedRef.current = onRefused
    const attachedNodeRef = useRef<HTMLElement | null>(null)

    const controller = useMemo(
        () =>
            createFileDropController({
                onChange: setIsDragging,
                onFiles: files => onFilesRef.current(files),
                isEnabled: true,
            }),
        []
    )

    const enabled = useCallback(() => {
        const current = isEnabledRef.current
        return typeof current === 'function' ? current() : current
    }, [])

    useEffect(() => {
        return () => {
            const el = attachedNodeRef.current
            if (el) {
                detachDropListeners(el)
                attachedNodeRef.current = null
            }
        }
    }, [])

    const dropRef = useCallback(
        (node: RNViewRef) => {
            if (Platform.OS !== 'web') return
            const el = isHtmlElement(node) ? node : null
            const previous = attachedNodeRef.current
            if (previous === el) return
            if (previous) detachDropListeners(previous)
            attachedNodeRef.current = el
            if (!el) return
            attachDropListeners(el, {
                onEnter: () => {
                    if (enabled()) controller.enter()
                },
                onOver: e => {
                    if (!e.dataTransfer) return
                    // A 'none' dropEffect makes the browser cancel the drop: it
                    // fires dragleave and never drop. A target that explains a
                    // refusal needs the drop, so it keeps 'copy'; the ring stays
                    // off because a refusing target never entered.
                    const keepDrop = enabled() || onRefusedRef.current != null
                    e.dataTransfer.dropEffect = keepDrop ? 'copy' : 'none'
                },
                // Safe on a refusing target that never entered: leave clamps the counter at zero.
                onLeave: () => controller.leave(),
                onDrop: e => {
                    const files = extractDroppedFiles(e.dataTransfer)
                    if (!enabled()) {
                        controller.reset()
                        if (files.length > 0) onRefusedRef.current?.(files)
                        return
                    }
                    controller.drop(files)
                },
            })
        },
        [controller, enabled]
    )

    return { isDragging, dropRef }
}

function isHtmlElement(node: unknown): node is HTMLElement {
    return (
        typeof node === 'object' &&
        node !== null &&
        typeof (node as HTMLElement).addEventListener === 'function' &&
        typeof (node as HTMLElement).removeEventListener === 'function'
    )
}

interface DropHandlers {
    onEnter: (e: DragEvent) => void
    onOver: (e: DragEvent) => void
    onLeave: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
}

const HANDLERS_KEY = '__tinycldDropHandlers__'

interface ElementWithHandlers extends HTMLElement {
    [HANDLERS_KEY]?: {
        enter: (e: DragEvent) => void
        over: (e: DragEvent) => void
        leave: (e: DragEvent) => void
        drop: (e: DragEvent) => void
    }
}

function attachDropListeners(el: HTMLElement, h: DropHandlers) {
    const wrapped = {
        enter: (e: DragEvent) => {
            if (!isFileDrag(e.dataTransfer)) return
            e.preventDefault()
            h.onEnter(e)
        },
        over: (e: DragEvent) => {
            if (!isFileDrag(e.dataTransfer)) return
            e.preventDefault()
            h.onOver(e)
        },
        leave: (e: DragEvent) => {
            if (!isFileDrag(e.dataTransfer)) return
            e.preventDefault()
            h.onLeave(e)
        },
        drop: (e: DragEvent) => {
            if (!isFileDrag(e.dataTransfer)) return
            e.preventDefault()
            h.onDrop(e)
        },
    }
    ;(el as ElementWithHandlers)[HANDLERS_KEY] = wrapped
    el.addEventListener('dragenter', wrapped.enter)
    el.addEventListener('dragover', wrapped.over)
    el.addEventListener('dragleave', wrapped.leave)
    el.addEventListener('drop', wrapped.drop)
}

function detachDropListeners(el: HTMLElement) {
    const wrapped = (el as ElementWithHandlers)[HANDLERS_KEY]
    if (!wrapped) return
    el.removeEventListener('dragenter', wrapped.enter)
    el.removeEventListener('dragover', wrapped.over)
    el.removeEventListener('dragleave', wrapped.leave)
    el.removeEventListener('drop', wrapped.drop)
    delete (el as ElementWithHandlers)[HANDLERS_KEY]
}
