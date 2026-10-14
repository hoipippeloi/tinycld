import type { EvalContext } from '@tinycld/core/lib/forms/logic'
import type { useEditorForm } from './use-editor-form'

export interface PreviewDialogProps {
    editor: ReturnType<typeof useEditorForm>
    context: EvalContext
    isOpen: boolean
    onClose: () => void
}

/** Placeholder with the final props so the editor shell compiles; the live preview replaces it. */
export function PreviewDialog(_props: PreviewDialogProps) {
    return null
}
