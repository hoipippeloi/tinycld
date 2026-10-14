import type { FormField, SelectOption } from '@tinycld/core/lib/forms/definition'
import { resolveFragment } from '@tinycld/core/lib/forms/host'
import type { CollabDoc, FieldMode, FormHostUi } from '@tinycld/core/lib/forms/host-ui'
import type { FormValues } from '@tinycld/core/lib/forms/logic'
import { type ChecklistItem, resolveKind } from '@tinycld/core/lib/forms/values'
import type { FormHost } from '@tinycld/core/lib/packages/derive-form-hosts'
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
import type { ReactElement } from 'react'
import { Text } from 'react-native'
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
}

type Resolved = ReturnType<typeof resolveKind>

interface KindProps extends FieldInputProps {
    resolved: Resolved
    disabled: boolean
    testID: string
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

function CheckboxRows({
    options,
    selected,
    onToggle,
    disabled,
}: {
    options: SelectOption[]
    selected: string[]
    onToggle: (v: string) => void
    disabled: boolean
}) {
    return (
        <>
            {options.map(o => (
                <Text
                    key={o.value}
                    onPress={disabled ? undefined : () => onToggle(o.value)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected.includes(o.value) }}
                    className="text-foreground py-1"
                >
                    {selected.includes(o.value) ? '☑' : '☐'} {o.label}
                </Text>
            ))}
        </>
    )
}

function CheckboxGroup({
    name,
    control,
    options,
    disabled,
}: {
    name: string
    control: Control<FormValues>
    options: SelectOption[]
    disabled: boolean
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
                    />
                )
            }}
        />
    )
}

function NumberKind({ field, control, resolved, disabled }: KindProps) {
    const { custom } = resolved
    const num = custom?.kind === 'number' ? custom : undefined
    return (
        <NumberInput
            control={control}
            name={field.key}
            min={num?.min}
            max={num?.max}
            increment={num?.step}
            disabled={disabled}
        />
    )
}

function SelectKind({ field, control, resolved, options, disabled }: KindProps) {
    const { custom, builtin } = resolved
    const sel = custom?.kind === 'select' ? custom : undefined
    const opts = options ?? sel?.options ?? []
    const display = sel?.display ?? 'dropdown'
    const multiple = sel?.multiple ?? builtin?.multiple ?? false
    if (multiple || display === 'checkbox') {
        return (
            <CheckboxGroup name={field.key} control={control} options={opts} disabled={disabled} />
        )
    }
    if (display === 'radio') {
        return <RadioInput control={control} name={field.key} label="" options={opts} />
    }
    return <SelectInput control={control} name={field.key} label="" options={opts} />
}

function DateKind({ field, control, resolved, disabled, testID }: KindProps) {
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
                />
            )}
        />
    )
}

function UserKind({ field, control, resolved, disabled, testID }: KindProps) {
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
                />
            )}
        />
    )
}

function FileKind({ host, field, control, resolved, recordId, disabled, testID }: KindProps) {
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

function RichTextKind({
    host,
    field,
    control,
    resolved,
    recordId,
    collab,
    disabled,
    testID,
}: KindProps) {
    const isMarkdown = resolved.kind === 'markdown'
    const template = host.collaborative?.fragment
    const fragment =
        isCollaborative(resolved) && recordId && template
            ? resolveFragment(template, recordId, field.key, isMarkdown ? 'md' : 'html')
            : undefined
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
                />
            )}
        />
    )
}

function HostComponent({ field, control, ui, mode, recordId, resolved }: KindProps) {
    const Component = ui?.components[resolved.builtin?.component ?? '']
    if (!Component) return null
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
                />
            )}
        />
    )
}

function hasHostComponent(resolved: Resolved, ui: FormHostUi | null): boolean {
    const name = resolved.builtin?.component
    if (!name || !ui?.components[name]) return false
    // The core editor renders markdown and richtext builtins; a host component does not replace it.
    return resolved.kind !== 'markdown' && resolved.kind !== 'richtext'
}

function KindInput(props: KindProps) {
    const { field, control, resolved, disabled, testID } = props
    switch (resolved.kind) {
        case 'text':
            return (
                <TextInput
                    control={control}
                    name={field.key}
                    placeholder={field.placeholder}
                    editable={!disabled}
                    testID={testID}
                />
            )
        case 'textarea':
            return (
                <TextAreaInput
                    control={control}
                    name={field.key}
                    placeholder={field.placeholder}
                    editable={!disabled}
                    testID={testID}
                />
            )
        case 'number':
            return <NumberKind {...props} />
        case 'toggle':
            return <Toggle control={control} name={field.key} label="" disabled={disabled} />
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
    }
    if (hasHostComponent(resolved, props.ui)) {
        // A section is host chrome with no value of its own; it has nothing to show before the record exists.
        if (resolved.kind === 'section' && props.mode !== 'edit' && props.mode !== 'read')
            return null
        return <HostComponent {...kindProps} />
    }
    if (resolved.kind === 'section') return null
    return <KindInput {...kindProps} />
}
