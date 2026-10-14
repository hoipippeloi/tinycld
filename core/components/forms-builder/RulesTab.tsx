import type { useEditorForm } from './use-editor-form'

export interface RulesTabProps {
    editor: ReturnType<typeof useEditorForm>
    isVisible: boolean
}

/** Placeholder with the final props so the editor shell compiles; the rules editor replaces it. */
export function RulesTab(_props: RulesTabProps) {
    return null
}
