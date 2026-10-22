import {
    kindOf,
    moveField,
    type Removed,
    referencesOf,
    removeField,
} from '@tinycld/core/lib/forms/builder'
import { FIELD_WIDTHS, type FieldWidth } from '@tinycld/core/lib/forms/definition'
import { findBuiltin } from '@tinycld/core/lib/forms/host'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { ConfirmDialog } from '@tinycld/core/ui/ConfirmDialog'
import { NumberInput, RadioInput, TextInput, Toggle, useWatch } from '@tinycld/core/ui/form'
import { useState } from 'react'
import { Text, View } from 'react-native'
import { DefaultPicker } from './DefaultPicker'
import { OptionsEditor } from './OptionsEditor'
import { PickMenu } from './rule-parts'
import { orderOf, positionOf } from './use-canvas-drag'
import { removalParts, type useEditorForm } from './use-editor-form'

type Editor = ReturnType<typeof useEditorForm>

const KIND_LABELS: Record<string, string> = {
    text: 'Text',
    textarea: 'Long text',
    number: 'Number',
    date: 'Date',
    toggle: 'Toggle',
    select: 'Choice list',
    user: 'Person',
    checklist: 'Checklist',
    richtext: 'Rich text',
    markdown: 'Markdown',
    file: 'File',
    computed: 'Calculated value',
    table: 'Table',
    custom: 'Built-in',
    section: 'Section',
}
const WIDTH_LABELS: Record<FieldWidth, string> = {
    full: 'Full',
    half: 'Half',
    third: 'Third',
    quarter: 'Quarter',
}
const WIDTH_OPTIONS = FIELD_WIDTHS.map(w => ({ value: w, label: WIDTH_LABELS[w] }))
const DISPLAY_OPTIONS = [
    { value: 'dropdown', label: 'Dropdown' },
    { value: 'radio', label: 'Radio buttons' },
    { value: 'checkbox', label: 'Checkboxes' },
]
/** A table draws rows and a calculated value its result: neither shows a placeholder. */
const NO_PLACEHOLDER = new Set(['table', 'computed'])
/** A calculated value is never typed in, so the record cannot require it. */
const NO_REQUIRED = new Set(['computed'])

export interface FieldPropertiesProps {
    editor: Editor
    fieldKey: string
}

function ReadOnlyRow({ label, value, testID }: { label: string; value: string; testID: string }) {
    return (
        <View className="mb-3" testID={testID}>
            <Text className="text-sm font-semibold text-foreground">{label}</Text>
            <Text className="text-muted-foreground">{value}</Text>
        </View>
    )
}

interface KindSectionProps {
    editor: Editor
    index: number
    kind: string
    isVisible: boolean
}

function KindSection({ editor, index, kind, isVisible }: KindSectionProps) {
    const { control } = editor.form
    if (!isVisible) return null
    switch (kind) {
        case 'select':
            return (
                <>
                    <OptionsEditor control={control} fieldIndex={index} />
                    <RadioInput
                        control={control}
                        name={`fields.${index}.display`}
                        label="Show as"
                        options={DISPLAY_OPTIONS}
                    />
                    <Toggle
                        control={control}
                        name={`fields.${index}.multiple`}
                        label="Allow several"
                    />
                </>
            )
        case 'number':
            return (
                <>
                    <NumberInput
                        control={control}
                        name={`fields.${index}.min`}
                        label="Minimum"
                        allowDecimal
                    />
                    <NumberInput
                        control={control}
                        name={`fields.${index}.max`}
                        label="Maximum"
                        allowDecimal
                    />
                    <NumberInput
                        control={control}
                        name={`fields.${index}.step`}
                        label="Step"
                        min={0}
                        allowDecimal
                    />
                </>
            )
        case 'date':
            return <Toggle control={control} name={`fields.${index}.time`} label="Include a time" />
        case 'text':
            return (
                <NumberInput
                    control={control}
                    name={`fields.${index}.maxLength`}
                    label="Maximum length"
                    min={1}
                />
            )
        case 'textarea':
            return (
                <NumberInput
                    control={control}
                    name={`fields.${index}.rows`}
                    label="Rows"
                    min={1}
                    max={40}
                />
            )
        case 'file':
            return (
                <>
                    <Toggle
                        control={control}
                        name={`fields.${index}.multiple`}
                        label="Allow several files"
                    />
                    <TextInput
                        control={control}
                        name={`fields.${index}.acceptText`}
                        label="Accepted types"
                        hint="Comma separated, e.g. image/*, application/pdf"
                    />
                </>
            )
        case 'user':
            return (
                <Toggle
                    control={control}
                    name={`fields.${index}.multiple`}
                    label="Allow several people"
                />
            )
        case 'richtext':
        case 'markdown':
            return (
                <Toggle
                    control={control}
                    name={`fields.${index}.collaborative`}
                    label="Collaborative editing"
                    hint={collaborativeHint(Boolean(editor.host?.collaborative))}
                    disabled={!editor.host?.collaborative}
                />
            )
        default:
            return null
    }
}

function collaborativeHint(isSupported: boolean) {
    if (!isSupported) return 'This record type does not support collaborative editing.'
    return 'Several people edit at once, after the record exists.'
}

function removalMessage(refs: Removed | null) {
    const base = 'Stored values stay in the records, hidden.'
    const parts = refs ? removalParts(refs) : []
    if (!parts.length) return base
    return `${base} This also removes ${parts.join(', ')}.`
}

function useFieldProperties(editor: Editor, fieldKey: string) {
    // Watched, so the panel follows the field when a drag or a removal shifts its index.
    const fields = useWatch({ control: editor.form.control, name: 'fields' }) ?? []
    const index = fields.findIndex(f => f.key === fieldKey)
    const field = fields[index]
    const host = editor.host
    const builtin = host && field?.kind === 'builtin' ? findBuiltin(host, fieldKey) : undefined
    const draft = { ...editor.form.getValues(), fields }
    const kind = host ? (kindOf(draft, host, fieldKey) ?? 'text') : 'text'
    // The delete confirm is local UI state.
    const [isConfirming, setIsConfirming] = useState(false)
    const message = removalMessage(isConfirming ? referencesOf(draft, fieldKey) : null)
    const remove = () => {
        setIsConfirming(false)
        editor.applyRemoval(def => removeField(def, fieldKey))
    }
    return { index, field, builtin, kind, isConfirming, setIsConfirming, message, remove }
}

/**
 * Where the field sits: its page, and its place among that page's fields.
 * Dragging does the same; this is the way that needs no pointer, for a
 * keyboard or a screen reader.
 */
function usePlacement(editor: Editor, fieldKey: string) {
    const { control } = editor.form
    const pages = useWatch({ control, name: 'pages' }) ?? []
    const fields = useWatch({ control, name: 'fields' }) ?? []
    const order = orderOf({ pages, fields })
    const at = positionOf(fieldKey, order)
    const count = order.find(o => o.page === at?.page)?.keys.length ?? 0
    const moveTo = (page: string, index: number) =>
        editor.apply(def => moveField(def, fieldKey, page, index))
    const pageItems = pages.map(page => ({
        id: page.key,
        label: page.title,
        isSelected: page.key === at?.page,
        // A new page takes the field at its end; its own page leaves it where it is.
        onSelect: () => {
            if (page.key !== at?.page) moveTo(page.key, Number.MAX_SAFE_INTEGER)
        },
    }))
    const pageLabel = pages.find(p => p.key === at?.page)?.title ?? ''
    return {
        pageItems,
        pageLabel,
        canMoveUp: Boolean(at && at.index > 0),
        canMoveDown: Boolean(at && at.index < count - 1),
        moveUp: () => at && moveTo(at.page, at.index - 1),
        moveDown: () => at && moveTo(at.page, at.index + 1),
    }
}

function PlacementSection({ editor, fieldKey }: { editor: Editor; fieldKey: string }) {
    const p = usePlacement(editor, fieldKey)
    return (
        <View className="mb-3 gap-1.5">
            <Text className="text-sm font-semibold text-foreground">Page</Text>
            <View className="flex-row flex-wrap items-center gap-2">
                <PickMenu
                    label={p.pageLabel}
                    purpose="Page"
                    items={p.pageItems}
                    testID="form-prop-page"
                />
                <Button
                    variant="outline"
                    size="sm"
                    onPress={p.moveUp}
                    isDisabled={!p.canMoveUp}
                    accessibilityLabel="Move up"
                    testID="form-prop-move-up"
                >
                    <ButtonText>Move up</ButtonText>
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onPress={p.moveDown}
                    isDisabled={!p.canMoveDown}
                    accessibilityLabel="Move down"
                    testID="form-prop-move-down"
                >
                    <ButtonText>Move down</ButtonText>
                </Button>
            </View>
        </View>
    )
}

interface DeleteSectionProps {
    isVisible: boolean
    isConfirming: boolean
    message: string
    onPress: () => void
    onClose: () => void
    onConfirm: () => void
}

function DeleteSection({
    isVisible,
    isConfirming,
    message,
    onPress,
    onClose,
    onConfirm,
}: DeleteSectionProps) {
    if (!isVisible) return null
    return (
        <>
            <Button
                variant="destructive"
                size="sm"
                onPress={onPress}
                testID="form-prop-delete"
                className="self-start mt-4"
            >
                <ButtonText>Delete field</ButtonText>
            </Button>
            <ConfirmDialog
                isOpen={isConfirming}
                onClose={onClose}
                onConfirm={onConfirm}
                title="Delete field"
                message={message}
                confirmLabel="Delete"
                isDestructive
                requiresServer={false}
            />
        </>
    )
}

function PlaceholderInput({
    editor,
    index,
    isVisible,
}: {
    editor: Editor
    index: number
    isVisible: boolean
}) {
    if (!isVisible) return null
    return (
        <TextInput
            control={editor.form.control}
            name={`fields.${index}.placeholder`}
            label="Placeholder"
        />
    )
}

interface RequiredToggleProps {
    editor: Editor
    index: number
    isHostRequired: boolean
    isVisible: boolean
}

function RequiredToggle({ editor, index, isHostRequired, isVisible }: RequiredToggleProps) {
    if (!isVisible) return null
    return (
        <Toggle
            control={editor.form.control}
            name={`fields.${index}.required`}
            label="Required"
            disabled={isHostRequired}
            hint={isHostRequired ? 'The record always needs it' : undefined}
        />
    )
}

export function FieldProperties({ editor, fieldKey }: FieldPropertiesProps) {
    const p = useFieldProperties(editor, fieldKey)
    const { control } = editor.form
    if (p.index < 0 || !p.field) return null
    const i = p.index
    const isCustom = p.field.kind !== 'builtin'
    const isHostRequired = Boolean(p.builtin?.required)
    return (
        <View testID="form-properties">
            <TextInput control={control} name={`fields.${i}.label`} label="Label" />
            <ReadOnlyRow label="Key" value={fieldKey} testID="form-prop-key" />
            <ReadOnlyRow
                label="Kind"
                value={KIND_LABELS[p.kind] ?? p.kind}
                testID="form-prop-kind"
            />
            <TextInput control={control} name={`fields.${i}.description`} label="Description" />
            <PlaceholderInput editor={editor} index={i} isVisible={!NO_PLACEHOLDER.has(p.kind)} />
            <PlacementSection editor={editor} fieldKey={fieldKey} />
            <RadioInput
                control={control}
                name={`fields.${i}.width`}
                label="Width"
                options={WIDTH_OPTIONS}
            />
            <RequiredToggle
                editor={editor}
                index={i}
                isHostRequired={isHostRequired}
                isVisible={!NO_REQUIRED.has(p.kind)}
            />
            <Toggle
                control={control}
                name={`fields.${i}.hidden`}
                label="Hidden"
                disabled={isHostRequired}
                hint={isHostRequired ? 'Required by the record' : undefined}
            />
            <DefaultPicker editor={editor} fieldKey={fieldKey} kind={p.kind} />
            <KindSection editor={editor} index={i} kind={p.kind} isVisible={isCustom} />
            <DeleteSection
                isVisible={isCustom}
                isConfirming={p.isConfirming}
                message={p.message}
                onPress={() => p.setIsConfirming(true)}
                onClose={() => p.setIsConfirming(false)}
                onConfirm={p.remove}
            />
        </View>
    )
}
