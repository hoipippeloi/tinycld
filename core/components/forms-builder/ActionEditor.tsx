import {
    ACTION_LABELS,
    type ActionKind,
    actionsFor,
    coerceLiteral,
    type DraftDefinition,
    expressionToPick,
    kindOf,
} from '@tinycld/core/lib/forms/builder'
import type { FormHostDef } from '@tinycld/core/lib/forms/host'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { type Control, TextInput } from '@tinycld/core/ui/form'
import { PlainInput } from '@tinycld/core/ui/PlainInput'
import { useState } from 'react'
import { useFieldArray, useWatch } from 'react-hook-form'
import { View } from 'react-native'
import { firstFreeNumber } from './OptionsEditor'
import {
    type Choice,
    ChoiceChips,
    type DraftAction,
    optionsOf,
    PickMenu,
    RemoveButton,
    RULE_INPUT_CLASS,
} from './rule-parts'
import type { useEditorForm } from './use-editor-form'

type Editor = ReturnType<typeof useEditorForm>
type Target = { field: string } | { page: string }
type SetValue = Extract<DraftAction, { action: 'set_value' }>['value']

export interface ActionEditorProps {
    editor: Editor
    ruleIndex: number
    index: number
    onRemove: () => void
}

function targetOf(action: DraftAction): Target {
    if ('page' in action && action.page) return { page: action.page }
    return { field: 'field' in action && action.field ? action.field : '' }
}

function targetKindOf(draft: DraftDefinition, host: FormHostDef, target: Target): string {
    if ('page' in target) return 'page'
    return kindOf(draft, host, target.field) ?? 'text'
}

/**
 * A fresh action of this verb on this target. What a verb carries (options,
 * a value) belongs to the old target, so it starts over rather than carrying across.
 */
export function buildAction(verb: ActionKind, target: Target, draft: DraftDefinition): DraftAction {
    if ('page' in target) return { action: verb === 'hide' ? 'hide' : 'show', page: target.page }
    const field = target.field
    switch (verb) {
        case 'set_options':
            return { action: verb, field, options: optionsOf(draft, field) }
        case 'set_value':
            return { action: verb, field, value: null }
        default:
            return { action: verb, field }
    }
}

interface NumberTextProps {
    value: number | null
    onChange: (value: number | null) => void
    label: string
    testID: string
}

function NumberText({ value, onChange, label, testID }: NumberTextProps) {
    const placeholder = useThemeColor('field-placeholder')
    // The typed text is local, so "-" and "1." can pass on their way to a number.
    const [text, setText] = useState(value === null ? '' : String(value))
    const change = (next: string) => {
        setText(next)
        const n = coerceLiteral('number', next)
        onChange(next.trim() !== '' && typeof n === 'number' ? n : null)
    }
    return (
        <PlainInput
            value={text}
            onChangeText={change}
            keyboardType="numeric"
            placeholderTextColor={placeholder}
            className={RULE_INPUT_CLASS}
            accessibilityLabel={label}
            testID={testID}
        />
    )
}

const DATE_MODES: Choice[] = [
    { id: 'literal', label: 'A date' },
    { id: 'today', label: 'Today' },
    { id: 'today_plus', label: 'Today plus days' },
]

const DATE_STARTS: Record<string, SetValue> = {
    literal: null,
    today: { today: [] },
    today_plus: { addDays: [{ today: [] }, 7] },
}

interface ValueInputProps {
    value: SetValue
    onChange: (value: SetValue) => void
    testID: string
}

function DateLiteral({
    text,
    onChange,
    testID,
    isVisible,
}: { text: string; isVisible: boolean } & Omit<ValueInputProps, 'value'>) {
    const placeholder = useThemeColor('field-placeholder')
    if (!isVisible) return null
    return (
        <PlainInput
            value={text}
            onChangeText={next => onChange(next === '' ? null : next)}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={placeholder}
            className={RULE_INPUT_CLASS}
            accessibilityLabel="Date"
            testID={`${testID}-date`}
        />
    )
}

function DaysText({
    days,
    onChange,
    testID,
    isVisible,
}: { days: number; isVisible: boolean } & Omit<ValueInputProps, 'value'>) {
    if (!isVisible) return null
    const write = (n: number | null) => onChange({ addDays: [{ today: [] }, Math.trunc(n ?? 0)] })
    return (
        <NumberText
            value={days}
            onChange={write}
            label="Days from today"
            testID={`${testID}-days`}
        />
    )
}

/** A day, today, or today plus a number of days. */
function DateValue({ value, onChange, testID }: ValueInputProps) {
    const pick = expressionToPick(value)
    const mode = pick.mode === 'none' ? 'literal' : pick.mode
    const text = pick.mode === 'literal' ? String(pick.value) : ''
    const days = pick.mode === 'today_plus' ? pick.days : 7
    return (
        <View className="gap-1">
            <ChoiceChips
                choices={DATE_MODES}
                selected={[mode]}
                onToggle={id => onChange(DATE_STARTS[id])}
                testID={`${testID}-mode`}
            />
            <DateLiteral
                text={text}
                onChange={onChange}
                testID={testID}
                isVisible={mode === 'literal'}
            />
            <DaysText
                days={days}
                onChange={onChange}
                testID={testID}
                isVisible={pick.mode === 'today_plus'}
            />
        </View>
    )
}

const TOGGLE_CHOICES: Choice[] = [
    { id: 'on', label: 'On' },
    { id: 'off', label: 'Off' },
]

function toggleSelected(value: SetValue): string[] {
    if (value === true) return ['on']
    if (value === false) return ['off']
    return []
}

const TEXT_KINDS = new Set(['text', 'textarea', 'markdown', 'richtext'])

interface SetValueInputProps extends ValueInputProps {
    kind: string
    choices: Choice[]
}

/** The value set_value writes, entered the way its target's kind holds it. */
function SetValueInput({ kind, choices, value, onChange, testID }: SetValueInputProps) {
    const placeholder = useThemeColor('field-placeholder')
    if (kind === 'select')
        return (
            <ChoiceChips
                choices={choices}
                selected={typeof value === 'string' ? [value] : []}
                onToggle={onChange}
                testID={testID}
            />
        )
    if (kind === 'toggle')
        return (
            <ChoiceChips
                choices={TOGGLE_CHOICES}
                selected={toggleSelected(value)}
                onToggle={id => onChange(id === 'on')}
                testID={testID}
            />
        )
    if (kind === 'date') return <DateValue value={value} onChange={onChange} testID={testID} />
    if (kind === 'user')
        return (
            <ChoiceChips
                choices={[{ id: 'me', label: 'The current user' }]}
                selected={expressionToPick(value).mode === 'me' ? ['me'] : []}
                onToggle={() => onChange({ me: [] })}
                testID={testID}
            />
        )
    if (kind === 'number')
        return (
            <NumberText
                value={typeof value === 'number' ? value : null}
                onChange={onChange}
                label="Value"
                testID={testID}
            />
        )
    if (!TEXT_KINDS.has(kind)) return null
    return (
        <PlainInput
            value={typeof value === 'string' ? value : ''}
            onChangeText={next => onChange(coerceLiteral(kind, next))}
            placeholderTextColor={placeholder}
            className={RULE_INPUT_CLASS}
            accessibilityLabel="Value"
            testID={testID}
        />
    )
}

interface OptionsProps {
    control: Control<DraftDefinition>
    ruleIndex: number
    index: number
}

function useActionOptions({ control, ruleIndex, index }: OptionsProps) {
    // The path exists only on a set_options action; this editor mounts only for one.
    const name =
        `rules.${ruleIndex}.actions.${index}.options` as `rules.${number}.actions.${number}.options`
    const options = useFieldArray({ control, name })
    // Watched, because typed values do not reach `options.fields`.
    const current = useWatch({ control, name }) ?? []
    const add = () => {
        const n = firstFreeNumber(new Set(current.map(o => o.value)))
        options.append({ value: `option_${n}`, label: `Option ${n}` })
    }
    return {
        name,
        rows: options.fields,
        remove: options.remove,
        add,
        canRemove: options.fields.length > 1,
    }
}

/** The options a set_options action leaves the target with. */
function SetOptionsEditor(props: OptionsProps) {
    const { name, rows, remove, add, canRemove } = useActionOptions(props)
    const t = `${props.ruleIndex}-${props.index}`
    const items = rows.map((row, i) => (
        <View key={row.id} className="flex-row items-end gap-2">
            <View className="flex-1">
                <TextInput control={props.control} name={`${name}.${i}.label`} label="Label" />
            </View>
            <View className="flex-1">
                <TextInput control={props.control} name={`${name}.${i}.value`} label="Value" />
            </View>
            <OptionRemove
                isVisible={canRemove}
                onPress={() => remove(i)}
                testID={`form-action-option-remove-${t}-${i}`}
            />
        </View>
    ))
    return (
        <View className="w-full">
            {items}
            <Button
                variant="outline"
                size="sm"
                onPress={add}
                className="self-start"
                testID={`form-action-option-add-${t}`}
            >
                <ButtonText>Add option</ButtonText>
            </Button>
        </View>
    )
}

function OptionRemove({
    isVisible,
    onPress,
    testID,
}: {
    isVisible: boolean
    onPress: () => void
    testID: string
}) {
    if (!isVisible) return null
    return (
        <View className="pb-5">
            <RemoveButton label="Remove option" onPress={onPress} testID={testID} />
        </View>
    )
}

interface ActionValueProps extends OptionsProps {
    action: DraftAction
    kind: string
    choices: Choice[]
    onChange: (action: DraftAction) => void
}

function ActionValue({ action, kind, choices, onChange, ...options }: ActionValueProps) {
    // Keyed by target: a retarget replaces the options outside this field array.
    if (action.action === 'set_options') return <SetOptionsEditor key={action.field} {...options} />
    if (action.action !== 'set_value') return null
    return (
        <SetValueInput
            // A new target starts a fresh input, dropping the old target's typed text.
            key={action.field}
            kind={kind}
            choices={choices}
            value={action.value}
            onChange={value => onChange({ ...action, value })}
            testID={`form-action-value-${options.ruleIndex}-${options.index}`}
        />
    )
}

function useAction(editor: Editor, ruleIndex: number, index: number) {
    const name = `rules.${ruleIndex}.actions.${index}` as const
    const action = useWatch({ control: editor.form.control, name })
    const host = editor.host
    if (!host || !action) return null
    const draft = editor.form.getValues()
    const target = targetOf(action)
    const kind = targetKindOf(draft, host, target)
    const write = (next: DraftAction) => editor.form.setValue(name, next, { shouldDirty: true })
    // A new target may not allow the current verb; it falls back to the first one it does.
    const retarget = (next: Target) => {
        const allowed = actionsFor(targetKindOf(draft, host, next))
        const verb = allowed.includes(action.action) ? action.action : allowed[0]
        write(buildAction(verb, next, draft))
    }
    const isTarget = (t: Target) =>
        'page' in t
            ? 'page' in target && target.page === t.page
            : 'field' in target && target.field === t.field
    const targets: { id: string; label: string; target: Target }[] = [
        ...draft.fields.map(f => ({ id: f.key, label: f.label, target: { field: f.key } })),
        ...draft.pages.map(p => ({
            id: `page:${p.key}`,
            label: `Page: ${p.title}`,
            target: { page: p.key },
        })),
    ]
    const targetItems = targets.map(t => ({
        id: t.id,
        label: t.label,
        isSelected: isTarget(t.target),
        onSelect: () => retarget(t.target),
    }))
    const verbItems = actionsFor(kind).map(verb => ({
        id: verb,
        label: ACTION_LABELS[verb],
        isSelected: verb === action.action,
        onSelect: () => {
            if (verb !== action.action) write(buildAction(verb, target, draft))
        },
    }))
    const targetLabel = targets.find(t => isTarget(t.target))?.label ?? 'Field'
    const choices =
        'field' in target
            ? optionsOf(draft, target.field).map(o => ({ id: o.value, label: o.label }))
            : []
    return { action, kind, write, targetItems, verbItems, targetLabel, choices }
}

export function ActionEditor({ editor, ruleIndex, index, onRemove }: ActionEditorProps) {
    const a = useAction(editor, ruleIndex, index)
    if (!a) return null
    const t = `${ruleIndex}-${index}`
    return (
        <View className="flex-row flex-wrap items-center gap-1.5" testID={`form-action-${t}`}>
            <PickMenu
                label={ACTION_LABELS[a.action.action]}
                purpose="Action"
                items={a.verbItems}
                testID={`form-action-kind-${t}`}
            />
            <PickMenu
                label={a.targetLabel}
                purpose="Action target"
                items={a.targetItems}
                testID={`form-action-target-${t}`}
            />
            <ActionValue
                action={a.action}
                kind={a.kind}
                choices={a.choices}
                onChange={a.write}
                control={editor.form.control}
                ruleIndex={ruleIndex}
                index={index}
            />
            <RemoveButton
                label="Remove action"
                onPress={onRemove}
                testID={`form-action-${t}-remove`}
            />
        </View>
    )
}
