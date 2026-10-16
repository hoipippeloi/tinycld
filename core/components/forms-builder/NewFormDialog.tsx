import { PromptDialog } from '@tinycld/core/ui/PromptDialog'

export interface NewFormDialogProps {
    isOpen: boolean
    onClose: () => void
    onCreate: (name: string) => void
    isSubmitting: boolean
    errorMessage?: string | null
}

export function NewFormDialog({
    isOpen,
    onClose,
    onCreate,
    isSubmitting,
    errorMessage,
}: NewFormDialogProps) {
    return (
        <PromptDialog
            isOpen={isOpen}
            onClose={onClose}
            onSubmit={onCreate}
            title="New form"
            description="A form is a record type. Its name shows in the type selector."
            placeholder="Bug"
            confirmLabel="Create"
            required
            maxLength={120}
            isSubmitting={isSubmitting}
            errorMessage={errorMessage}
        />
    )
}
