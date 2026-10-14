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
import { Platform, View } from 'react-native'
import { ZodError } from 'zod'
import { KindPicker } from './KindPicker'
import { PageHeader } from './PageHeader'
import { type CanvasDrag, orderOf, useCanvasDrag, useDragHandle } from './use-canvas-drag'
import type { useEditorForm } from './use-editor-form'

type Editor = ReturnType<typeof useEditorForm>
type DraftField = DraftDefinition['fields'][number]

export interface CanvasProps {
    editor: Editor
    context: EvalContext
    /**
     * Created by the caller with `useEditorCanvasDrag`, so the canvas's
     * ScrollView can feed `drag.onScroll` and lock scrolling while
     * `drag.draggingKey` is set.
     */
    drag: CanvasDrag
}

/** The drag controller for an editor's canvas: moves land in the editor's draft. */
export function useEditorCanvasDrag(editor: Editor) {
    return useCanvasDrag({
        getOrder: () => orderOf(editor.form.getValues()),
        onMove: (key, page, index) => editor.apply(def => moveField(def, key, page, index)),
    })
}

/**
 * The draft as the renderer can draw it. A draft is briefly invalid while it
 * is edited (an options list emptied before a new row is typed); the canvas
 * then keeps the last valid definition instead of crashing. The watched draft
 * fields are returned too: editor errors are indexed by them.
 */
function useCanvasDefinition(control: Control<DraftDefinition>) {
    const [version, pages, fields] = useWatch({ control, name: ['version', 'pages', 'fields'] })
    const lastGood = useRef<FormDefinition | null>(null)
    const definition = useMemo(() => {
        if (!pages || !fields) return lastGood.current
        try {
            lastGood.current = normalizeDraft({ version, pages, fields })
        } catch (error) {
            if (!(error instanceof ZodError)) throw error
        }
        return lastGood.current
    }, [version, pages, fields])
    return { definition, draftFields: fields ?? [] }
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

function errorsByKey(errors: FieldErrors<DraftDefinition>, fields: DraftField[]) {
    const out: Record<string, string> = {}
    fields.forEach((field, index) => {
        const message = firstMessage(errors.fields?.[index])
        if (message) out[field.key] = message
    })
    return out
}

// Without it a touch drag on web scrolls the page instead of moving the cell.
const HANDLE_STYLE = Platform.select({ web: { touchAction: 'none' } as Record<string, unknown> })

function DragHandle({ fieldKey, drag }: { fieldKey: string; drag: CanvasDrag }) {
    const { handlers } = useDragHandle(drag, fieldKey)
    const muted = useThemeColor('muted-foreground')
    return (
        <View
            {...handlers}
            accessibilityLabel="Drag to reorder"
            className="mr-1"
            style={HANDLE_STYLE}
            testID={`form-handle-${fieldKey}`}
        >
            <GripVertical size={14} color={muted} />
        </View>
    )
}

function deleteHintFor(hasFields: boolean) {
    return hasFields ? 'Move its fields first' : 'A form needs one page'
}

interface DesignInputs {
    editor: Editor
    definition: FormDefinition
    draftFields: DraftField[]
    drag: CanvasDrag
}

function designOptionsFor({ editor, definition, draftFields, drag }: DesignInputs): DesignOptions {
    const hasFields = (page: FormPage) => definition.fields.some(f => f.page === page.key)
    const canDelete = (page: FormPage) => definition.pages.length > 1 && !hasFields(page)
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
        onCellLayout: drag.cellLayout,
        onPageLayout: drag.pageLayout,
        onCellMeasure: drag.registerCell,
        onPageMeasure: drag.registerPage,
        dropTarget: drag.dropTarget,
        errors: errorsByKey(editor.form.formState.errors, draftFields),
    }
}

export function Canvas({ editor, context, drag }: CanvasProps) {
    const { definition, draftFields } = useCanvasDefinition(editor.form.control)
    // FormRenderer's inputs need a form instance; in design mode its values never matter.
    const inert = useForm<FormValues>({ defaultValues: {} })
    const addNewPage = () => editor.apply(def => addPage(def, 'New page'))
    if (!editor.host || !definition) return null
    const design = designOptionsFor({ editor, definition, draftFields, drag })
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
