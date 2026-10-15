import type { FormField, SelectOption } from '@tinycld/core/lib/forms/definition'
import { resolveFragment } from '@tinycld/core/lib/forms/host'
import type { CollabDoc, FieldMode, FormHostUi } from '@tinycld/core/lib/forms/host-ui'
import type { FormValues } from '@tinycld/core/lib/forms/logic'
import { type ChecklistItem, resolveKind } from '@tinycld/core/lib/forms/values'
import type { FormHost } from '@tinycld/core/lib/packages/derive-form-hosts'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import {
    type Control,
    Controller,
    NumberInput,
    RadioInput,
    SelectInput,
    TextAreaInput,
    TextInput,
    Toggle,
} from '@tinycld/core/ui/form'
import { CheckSquare, Square } from 'lucide-react-native'
import type { ReactElement } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChecklistField } from './fields/ChecklistField'
import { DateField } from './fields/DateField'
import { FileField } from './fields/FileField'
import { RichTextField } from './fields/RichTextField'
import { UserField } from './fields/UserField'

export interface FieldInputProps {
    host: FormHost
    ui: FormHostUi | null
    field: FormField
    control: Control<FormValues>
    mode: FieldMode
    recordId?: string
    /** Options from a set_options rule, overriding the field's own. */
    options?: SelectOption[]
    collab?: CollabDoc | null
    /** Enter in a single-line input; the wizard moves to the next page. */
    onSubmitEditing?: () => void
}

type Resolved = ReturnType<typeof resolveKind>

interface KindProps extends FieldInputProps {
    resolved: Resolved
    disabled: boolean
    testID: string
    /** The field's label, read by assistive technology as the input's name. */
    label: string
}

function Uncontrolled<T>({
    name,
    control,
    render,
}: {
    name: string
    control: Control<FormValues>
    render: (value: T, onChange: (v: T) => void) => ReactElement
}) {
    return (
        <Controller
            control={control}
            name={name}
            render={({ field }) => render(field.value as T, field.onChange)}
        />
    )
}

function CheckboxRow({
    option,
    isChecked,
    onToggle,
    disabled,
}: {
    option: SelectOption
    isChecked: boolean
    onToggle: (v: string) => void
    disabled: boolean
}) {
    const fg = useThemeColor('foreground')
    const Icon = isChecked ? CheckSquare : Square
    return (
        <Pressable
            onPress={() => onToggle(option.value)}
            disabled={disabled}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: isChecked, disabled }}
            className="flex-row items-center py-1"
        >
            <Icon size={18} color={fg} />
            <Text className="text-foreground ml-2">{option.label}</Text>
        </Pressable>
    )
}

function CheckboxRows({
    options,
    selected,
    onToggle,
    disabled,
    testID,
    label,
}: {
    options: SelectOption[]
    selected: string[]
    onToggle: (v: string) => void
    disabled: boolean
    testID: string
    label: string
}) {
    return (
        <View testID={testID} accessibilityLabel={label}>
            {options.map(o => (
                <CheckboxRow
                    key={o.value}
                    option={o}
                    isChecked={selected.includes(o.value)}
                    onToggle={onToggle}
                    disabled={disabled}
                />
            ))}
        </View>
    )
}

function CheckboxGroup({
    name,
    control,
    options,
    disabled,
    testID,
    label,
}: {
    name: string
    control: Control<FormValues>
    options: SelectOption[]
    disabled: boolean
    testID: string
    label: string
}) {
    return (
        <Uncontrolled<string[] | null>
            name={name}
            control={control}
            render={(value, onChange) => {
                const selected = Array.isArray(value) ? value : []
                const toggle = (v: string) =>
                    onChange(
                        selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v]
                    )
                return (
                    <CheckboxRows
                        options={options}
                        selected={selected}
                        onToggle={toggle}
                        disabled={disabled}
                        testID={testID}
                        label={label}
                    />
                )
            }}
        />
    )
}

function NumberKind({ field, control, resolved, disabled, testID, label }: KindProps) {
    const { custom } = resolved
    const num = custom?.kind === 'number' ? custom : undefined
    return (
        <NumberInput
            control={control}
            hideError
            name={field.key}
            min={num?.min}
            max={num?.max}
            increment={num?.step}
            allowDecimal
            disabled={disabled}
            testID={testID}
            accessibilityLabel={label}
        />
    )
}

function selectDisplay(resolved: Resolved): 'dropdown' | 'radio' | 'checkbox' {
    const { custom, builtin } = resolved
    const sel = custom?.kind === 'select' ? custom : undefined
    const multiple = sel?.multiple ?? builtin?.multiple ?? false
    return multiple ? 'checkbox' : (sel?.display ?? 'dropdown')
}

/**
 * True when a built-in declared `chrome: 'bare'` and the form shows a record
 * (edit or read): the host component draws its own chrome, and the cell is only
 * the width wrapper. The design canvas keeps the labelled cell.
 */
export function rendersBare(host: FormHost, field: FormField, mode: FieldMode): boolean {
    if (mode !== 'edit' && mode !== 'read') return false
    return resolveKind(host, field).builtin?.chrome === 'bare'
}

/**
 * True when the input renders the field's label itself (a toggle, a radio
 * list, a single-choice list, a bare built-in on a record), so the cell does
 * not repeat it.
 */
export function rendersOwnLabel(
    host: FormHost,
    field: FormField,
    ui: FormHostUi | null,
    mode?: FieldMode
): boolean {
    if (mode && rendersBare(host, field, mode)) return true
    const resolved = resolveKind(host, field)
    if (hasHostComponent(resolved, ui)) return false
    if (resolved.kind === 'toggle') return true
    return resolved.kind === 'select' && selectDisplay(resolved) !== 'checkbox'
}

function SelectKind({ field, control, resolved, options, disabled, testID, label }: KindProps) {
    const sel = resolved.custom?.kind === 'select' ? resolved.custom : undefined
    const opts = options ?? sel?.options ?? []
    const display = selectDisplay(resolved)
    if (display === 'checkbox') {
        return (
            <CheckboxGroup
                name={field.key}
                control={control}
                options={opts}
                disabled={disabled}
                testID={testID}
                label={label}
            />
        )
    }
    if (display === 'radio') {
        return (
            <RadioInput
                control={control}
                hideError
                name={field.key}
                label={label}
                options={opts}
                disabled={disabled}
                wrapperProps={{ testID }}
            />
        )
    }
    return (
        <SelectInput
            control={control}
            hideError
            name={field.key}
            label={label}
            options={opts}
            disabled={disabled}
            wrapperProps={{ testID }}
        />
    )
}

function DateKind({ field, control, resolved, disabled, testID, label }: KindProps) {
    const withTime = resolved.custom?.kind === 'date' && resolved.custom.time
    return (
        <Uncontrolled<string | null>
            name={field.key}
            control={control}
            render={(v, set) => (
                <DateField
                    value={v}
                    onChange={set}
                    withTime={withTime}
                    disabled={disabled}
                    testID={testID}
                    accessibilityLabel={label}
                />
            )}
        />
    )
}

function UserKind({ field, control, resolved, disabled, testID, label }: KindProps) {
    const multiple =
        (resolved.custom?.kind === 'user' && resolved.custom.multiple) ||
        resolved.builtin?.multiple ||
        false
    return (
        <Uncontrolled<string | string[] | null>
            name={field.key}
            control={control}
            render={(v, set) => (
                <UserField
                    value={v}
                    onChange={set}
                    multiple={multiple}
                    disabled={disabled}
                    testID={testID}
                    accessibilityLabel={label}
                />
            )}
        />
    )
}

function ChecklistKind({
    field,
    control,
    resolved,
    ui,
    mode,
    recordId,
    disabled,
    testID,
    label,
}: KindProps) {
    const { builtin } = resolved
    const hostBacked = mode === 'edit' || mode === 'read'
    const mapper = builtin?.mapper && ui && hostBacked ? ui.mappers[builtin.mapper] : undefined
    return (
        <Uncontrolled<ChecklistItem[] | null>
            name={field.key}
            control={control}
            render={(v, set) => (
                <ChecklistField
                    value={v}
                    onChange={set}
                    mapper={mapper}
                    recordId={recordId}
                    disabled={disabled}
                    testID={testID}
                    accessibilityLabel={label}
                />
            )}
        />
    )
}

function FileKind({
    host,
    field,
    control,
    resolved,
    recordId,
    disabled,
    testID,
    label,
}: KindProps) {
    const file = resolved.custom?.kind === 'file' ? resolved.custom : undefined
    if (!recordId) return <Text className="text-muted-foreground">Add files after creating.</Text>
    return (
        <Uncontrolled<string[] | null>
            name={field.key}
            control={control}
            render={(v, set) => (
                <FileField
                    host={host}
                    fieldKey={field.key}
                    recordId={recordId}
                    value={v}
                    onChange={set}
                    multiple={file?.multiple ?? false}
                    accept={file?.accept ?? []}
                    disabled={disabled}
                    testID={testID}
                    accessibilityLabel={label}
                />
            )}
        />
    )
}

function isCollaborative(resolved: Resolved): boolean {
    const { custom, builtin } = resolved
    if (custom && 'collaborative' in custom && custom.collaborative) return true
    return builtin?.collaborative ?? false
}

function fragmentFor(
    host: FormHost,
    resolved: Resolved,
    key: string,
    recordId: string | undefined
): string | undefined {
    const template = host.collaborative?.fragment
    if (!isCollaborative(resolved) || !recordId || !template) return undefined
    return resolveFragment(template, recordId, key, resolved.kind === 'markdown' ? 'md' : 'html')
}

function RichTextKind({
    host,
    field,
    control,
    resolved,
    recordId,
    collab,
    disabled,
    testID,
    label,
}: KindProps) {
    const isMarkdown = resolved.kind === 'markdown'
    const fragment = fragmentFor(host, resolved, field.key, recordId)
    return (
        <Uncontrolled<string | null>
            name={field.key}
            control={control}
            render={(v, set) => (
                <RichTextField
                    fieldKey={field.key}
                    value={v}
                    onChange={set}
                    format={isMarkdown ? 'markdown' : 'html'}
                    collab={fragment ? collab : undefined}
                    fragment={fragment}
                    disabled={disabled}
                    testID={testID}
                    accessibilityLabel={label}
                />
            )}
        />
    )
}

function HostComponent(props: KindProps) {
    const { field, control, ui, mode, recordId, resolved, disabled, collab, host } = props
    const Component = ui?.components[resolved.builtin?.component ?? '']
    if (!Component) return null
    const fragment = fragmentFor(host, resolved, field.key, recordId)
    return (
        <Uncontrolled<unknown>
            name={field.key}
            control={control}
            render={(value, onChange) => (
                <Component
                    fieldKey={field.key}
                    label={field.label}
                    recordId={recordId}
                    value={value}
                    onChange={onChange}
                    mode={mode}
                    disabled={disabled}
                    collab={collab}
                    fragment={fragment}
                />
            )}
        />
    )
}

/** A host component replaces core rendering for any built-in that names one, the collaborative kinds included. */
function hasHostComponent(resolved: Resolved, ui: FormHostUi | null): boolean {
    const name = resolved.builtin?.component
    return Boolean(name && ui?.components[name])
}

function packageLabel(host: FormHost) {
    const slug = host.pkgSlug
    return slug.charAt(0).toUpperCase() + slug.slice(1)
}

/** The canvas never mounts a host component: it stands in for the package's own UI. */
function DesignPlaceholder({ host }: { host: FormHost }) {
    return (
        <View className="rounded-md border border-dashed border-border px-3 py-2">
            <Text className="text-muted-foreground text-sm">Shown by {packageLabel(host)}</Text>
        </View>
    )
}

function KindInput(props: KindProps) {
    const { field, control, resolved, disabled, testID, label } = props
    switch (resolved.kind) {
        case 'text':
            return (
                <TextInput
                    control={control}
                    hideError
                    name={field.key}
                    placeholder={field.placeholder}
                    editable={!disabled}
                    testID={testID}
                    accessibilityLabel={label}
                    onSubmitEditing={props.onSubmitEditing}
                />
            )
        case 'textarea':
            return (
                <TextAreaInput
                    control={control}
                    hideError
                    name={field.key}
                    placeholder={field.placeholder}
                    editable={!disabled}
                    testID={testID}
                    accessibilityLabel={label}
                />
            )
        case 'number':
            return <NumberKind {...props} />
        case 'toggle':
            return (
                <Toggle
                    control={control}
                    hideError
                    name={field.key}
                    label={label}
                    disabled={disabled}
                    wrapperProps={{ testID }}
                />
            )
        case 'select':
            return <SelectKind {...props} />
        case 'date':
            return <DateKind {...props} />
        case 'user':
            return <UserKind {...props} />
        case 'checklist':
            return <ChecklistKind {...props} />
        case 'file':
            return <FileKind {...props} />
        case 'markdown':
        case 'richtext':
            return <RichTextKind {...props} />
        default:
            return <Text className="text-muted-foreground">{field.label} has no input.</Text>
    }
}

export function FieldInput(props: FieldInputProps) {
    const resolved = resolveKind(props.host, props.field)
    const kindProps: KindProps = {
        ...props,
        resolved,
        disabled: props.mode === 'read' || props.mode === 'design',
        testID: `form-input-${props.field.key}`,
        label: props.field.label,
    }
    if (hasHostComponent(resolved, props.ui)) {
        if (props.mode === 'design') return <DesignPlaceholder host={props.host} />
        // A section is host chrome with no value of its own; it has nothing to show before the record exists.
        if (resolved.kind === 'section' && props.mode !== 'edit' && props.mode !== 'read')
            return null
        return <HostComponent {...kindProps} />
    }
    if (resolved.kind === 'section') return null
    return <KindInput {...kindProps} />
}
