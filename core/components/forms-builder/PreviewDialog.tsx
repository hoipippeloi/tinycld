import { definitionSchema } from '@tinycld/core/lib/forms/definition'
import { applyDefaults, type EvalContext, evaluate } from '@tinycld/core/lib/forms/logic'
import { buildSchema } from '@tinycld/core/lib/forms/values'
import type { FormHost } from '@tinycld/core/lib/packages/derive-form-hosts'
import { Dialog } from '@tinycld/core/ui/dialog'
import { FormRenderer, useHostUi, useSchemaRefResolver } from '@tinycld/core/ui/forms'
import { EMPTY_DEFINITION, EMPTY_STATE } from '@tinycld/core/ui/forms/empty-schema'
import { useForm } from 'react-hook-form'
import { Text } from 'react-native'
import { fromDraft, type useEditorForm } from './use-editor-form'

export interface PreviewDialogProps {
    editor: ReturnType<typeof useEditorForm>
    context: EvalContext
    isOpen: boolean
    onClose: () => void
}

type PreviewBodyProps = Omit<PreviewDialogProps, 'isOpen'> & { host: FormHost }

function PreviewBody({ editor, host, context, onClose }: PreviewBodyProps) {
    const ui = useHostUi(host)
    const parsed = definitionSchema.safeParse(fromDraft(editor.form.getValues(), host))
    const definition = parsed.success ? parsed.data : null
    const defaults = definition ? applyDefaults(definition, context) : {}
    const initialSchema = definition
        ? buildSchema(definition, host, evaluate(definition, defaults, context))
        : buildSchema(EMPTY_DEFINITION, host, EMPTY_STATE)
    const { schemaRef, resolver } = useSchemaRefResolver(initialSchema)
    const form = useForm({ resolver, defaultValues: defaults })

    if (!definition) {
        const issue = parsed.success ? undefined : parsed.error.issues[0]
        return (
            <Text className="text-destructive">
                {issue?.path.join('.')} {issue?.message}
            </Text>
        )
    }
    return (
        <FormRenderer
            host={host}
            ui={ui}
            definition={definition}
            layout={definition.pages.length > 1 ? 'wizard' : 'sections'}
            form={form}
            context={context}
            schemaRef={schemaRef}
            submitLabel="Done"
            onSubmit={onClose}
        />
    )
}

export function PreviewDialog({ editor, context, isOpen, onClose }: PreviewDialogProps) {
    const { host } = editor
    return (
        <Dialog
            isOpen={isOpen}
            onClose={onClose}
            title="Preview"
            size="xl"
            testID="form-preview-dialog"
        >
            <Dialog.Body>
                {isOpen && host ? (
                    <PreviewBody editor={editor} host={host} context={context} onClose={onClose} />
                ) : null}
            </Dialog.Body>
        </Dialog>
    )
}
