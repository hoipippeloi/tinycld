import {
    addField,
    addPage,
    type DraftDefinition,
    moveField,
    newCustomField,
    normalizeDraft,
    removePage,
    renamePage,
} from '@tinycld/core/lib/forms/builder'
import type { CustomKind, FormDefinition, FormPage } from '@tinycld/core/lib/forms/definition'
import type { EvalContext, FormValues } from '@tinycld/core/lib/forms/logic'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { type DesignOptions, FormRenderer } from '@tinycld/core/ui/forms'
import { GripVertical } from 'lucide-react-native'
import { useMemo, useRef } from 'react'
import { type Control, type FieldErrors, useForm, useWatch } from 'react-hook-form'
import { View } from 'react-native'
import { ZodError } from 'zod'
import { KindPicker } from './KindPicker'
import { PageHeader } from './PageHeader'
import { type CanvasDrag, type PageOrder, useCanvasDrag, useDragHandle } from './use-canvas-drag'
import type { useEditorForm } from './use-editor-form'

type Editor = ReturnType<typeof useEditorForm>

export interface CanvasProps {
    editor: Editor
    context: EvalContext
}

/**
 * The draft as the renderer can draw it. A draft is briefly invalid while it
 * is edited (an options list emptied before a new row is typed); the canvas
 * then keeps the last valid definition instead of crashing.
 */
function useCanvasDefinition(control: Control<DraftDefinition>): FormDefinition | null {
    const [version, pages, fields] = useWatch({ control, name: ['version', 'pages', 'fields'] })
    const lastGood = useRef<FormDefinition | null>(null)
    return useMemo(() => {
        if (!pages || !fields) return lastGood.current
        try {
            lastGood.current = normalizeDraft({ version, pages, fields })
        } catch (error) {
            if (!(error instanceof ZodError)) throw error
        }
        return lastGood.current
    }, [version, pages, fields])
}

function orderOf(def: FormDefinition | null): PageOrder[] {
    if (!def) return []
    return def.pages.map(p => ({
        page: p.key,
        keys: def.fields.filter(f => f.page === p.key).map(f => f.key),
    }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

/** The first message in a field's error subtree; `ref` points at an element, not an error. */
function firstMessage(error: unknown): string | undefined {
    if (!isRecord(error)) return undefined
    if (typeof error.message === 'string' && error.message) return error.message
    for (const [key, child] of Object.entries(error)) {
        if (key === 'ref') continue
        const message = firstMessage(child)
        if (message) return message
    }
    return undefined
}

function errorsByKey(errors: FieldErrors<DraftDefinition>, fields: { key: string }[]) {
    const out: Record<string, string> = {}
    fields.forEach((field, index) => {
        const message = firstMessage(errors.fields?.[index])
        if (message) out[field.key] = message
    })
    return out
}

function DragHandle({ fieldKey, drag }: { fieldKey: string; drag: CanvasDrag }) {
    const { handlers } = useDragHandle(drag, fieldKey)
    const muted = useThemeColor('muted-foreground')
    return (
        <View
            {...handlers}
            accessibilityLabel="Drag to reorder"
            className="mr-1"
            testID={`form-handle-${fieldKey}`}
        >
            <GripVertical size={14} color={muted} />
        </View>
    )
}

function deleteHintFor(hasFields: boolean) {
    return hasFields ? 'Move its fields first' : 'A form needs one page'
}

function designOptionsFor(
    editor: Editor,
    definition: FormDefinition | null,
    drag: CanvasDrag
): DesignOptions {
    const pageOf = (key: string) => definition?.fields.find(f => f.key === key)?.page ?? ''
    const hasFields = (page: FormPage) => Boolean(definition?.fields.some(f => f.page === page.key))
    const canDelete = (page: FormPage) => (definition?.pages.length ?? 0) > 1 && !hasFields(page)
    const addFieldTo = (page: string, kind: CustomKind) => {
        const taken = new Set(editor.form.getValues('fields').map(f => f.key))
        const field = newCustomField(kind, 'New field', page, taken)
        editor.apply(def => addField(def, field))
        editor.select(field.key)
    }
    return {
        selectedKey: editor.selectedKey ?? undefined,
        onSelect: editor.select,
        renderHandle: key => <DragHandle fieldKey={key} drag={drag} />,
        renderPageHeader: page => (
            <PageHeader
                page={page}
                canDelete={canDelete(page)}
                deleteHint={deleteHintFor(hasFields(page))}
                onRename={title => editor.apply(def => renamePage(def, page.key, title))}
                onDelete={() => editor.applyRemoval(def => removePage(def, page.key))}
            />
        ),
        renderPageFooter: page => (
            <KindPicker
                onPick={kind => addFieldTo(page.key, kind)}
                testID={`form-add-field-${page.key}`}
            />
        ),
        onCellLayout: (key, rect) => drag.cellLayout(key, pageOf(key), rect),
        onPageLayout: drag.pageLayout,
        dropTarget: drag.dropTarget,
        errors: errorsByKey(editor.form.formState.errors, definition?.fields ?? []),
    }
}

export function Canvas({ editor, context }: CanvasProps) {
    const definition = useCanvasDefinition(editor.form.control)
    // FormRenderer's inputs need a form instance; in design mode its values never matter.
    const inert = useForm<FormValues>({ defaultValues: {} })
    const drag = useCanvasDrag({
        order: orderOf(definition),
        onMove: (key, page, index) => editor.apply(def => moveField(def, key, page, index)),
    })
    const design = designOptionsFor(editor, definition, drag)
    const addNewPage = () => editor.apply(def => addPage(def, 'New page'))
    if (!editor.host || !definition) return null
    return (
        <View testID="form-canvas">
            <FormRenderer
                host={editor.host}
                ui={null}
                definition={definition}
                layout="design"
                form={inert}
                context={context}
                design={design}
            />
            <Button
                variant="ghost"
                size="sm"
                onPress={addNewPage}
                className="self-start mt-2"
                testID="form-add-page"
            >
                <ButtonText>Add page</ButtonText>
            </Button>
        </View>
    )
}
