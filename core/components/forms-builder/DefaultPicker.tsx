import {
    coerceLiteral,
    type DefaultPick,
    expressionToPick,
    type PickMode,
    picksFor,
    pickToExpression,
} from '@tinycld/core/lib/forms/builder'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { useWatch } from '@tinycld/core/ui/form'
import { Menu } from '@tinycld/core/ui/menu'
import { PlainInput } from '@tinycld/core/ui/PlainInput'
import { useState } from 'react'
import { useFormState } from 'react-hook-form'
import { Pressable, Text, View } from 'react-native'
import { type Choice as ChipChoice, ChoiceChips, isMultipleField, optionsOf } from './rule-parts'
import type { useEditorForm } from './use-editor-form'

type Editor = ReturnType<typeof useEditorForm>

const MODE_LABELS: Record<PickMode, string> = {
    none: 'No default',
    literal: 'A value',
    today: 'Today',
    today_plus: 'Today plus days',
    me: 'The current user',
}

const INPUT_CLASS =
    'mt-1 border rounded-lg px-2.5 py-1.5 text-sm text-foreground bg-background border-border'

export interface DefaultPickerProps {
    editor: Editor
    fieldKey: string
    kind: string
}

interface Choice {
    id: string
    label: string
    pick: DefaultPick
}

/** The first pick a mode starts from when it is chosen; a multiple select starts from no options. */
function startingPick(mode: PickMode, isList: boolean): DefaultPick {
    if (mode === 'literal') return { mode: 'literal', value: isList ? [] : '' }
    if (mode === 'today_plus') return { mode: 'today_plus', days: 7 }
    return { mode }
}

/** A toggle's literal is On or Off, so it is offered as two choices instead of a typed value. */
function choicesFor(kind: string, isList: boolean): Choice[] {
    return picksFor(kind).flatMap((mode): Choice[] => {
        if (kind === 'toggle' && mode === 'literal')
            return [
                { id: 'on', label: 'On', pick: { mode: 'literal', value: true } },
                { id: 'off', label: 'Off', pick: { mode: 'literal', value: false } },
            ]
        return [{ id: mode, label: MODE_LABELS[mode], pick: startingPick(mode, isList) }]
    })
}

function labelFor(pick: DefaultPick, kind: string): string {
    if (kind === 'toggle' && pick.mode === 'literal') return pick.value === true ? 'On' : 'Off'
    return MODE_LABELS[pick.mode]
}

function isChoiceSelected(choice: Choice, current: DefaultPick, kind: string) {
    if (kind === 'toggle' && current.mode === 'literal' && choice.pick.mode === 'literal')
        return choice.pick.value === (current.value === true)
    return choice.pick.mode === current.mode
}

interface InputProps {
    pick: DefaultPick
    kind: string
    onChange: (pick: DefaultPick) => void
}

interface LiteralProps extends InputProps {
    /** A select's options; a select with none to offer is typed instead. */
    choices: ChipChoice[]
    isMultiple: boolean
    onBlur: () => void
}

function listOf(value: unknown): string[] {
    return Array.isArray(value) ? value : []
}

function singleOf(value: unknown): string[] {
    return typeof value === 'string' && value ? [value] : []
}

/** A select's default is one of its options, or for a multiple select a list of them. */
function OptionChips({
    pick,
    choices,
    isMultiple,
    onChange,
}: Omit<LiteralProps, 'kind' | 'onBlur'>) {
    if (pick.mode !== 'literal') return null
    const list = listOf(pick.value)
    const selected = isMultiple ? list : singleOf(pick.value)
    const toggle = (id: string) => {
        if (!isMultiple) return onChange({ mode: 'literal', value: id })
        const next = list.includes(id) ? list.filter(v => v !== id) : [...list, id]
        onChange({ mode: 'literal', value: next })
    }
    return (
        <View className="mt-1">
            <ChoiceChips
                choices={choices}
                selected={selected}
                onToggle={toggle}
                isMultiple={isMultiple}
                testID="form-default-option"
            />
        </View>
    )
}

function LiteralInput(props: LiteralProps) {
    const { pick, kind, choices, onChange, onBlur } = props
    const placeholder = useThemeColor('field-placeholder')
    if (pick.mode !== 'literal' || kind === 'toggle') return null
    if (kind === 'select' && choices.length) return <OptionChips {...props} />
    const text = String(pick.value)
    // The raw text is kept while typing so a number can pass through "1." on its way to "1.5".
    return (
        <PlainInput
            value={text}
            onChangeText={value => onChange({ mode: 'literal', value })}
            onBlur={() => {
                onChange({ mode: 'literal', value: coerceLiteral(kind, text) })
                onBlur()
            }}
            keyboardType={kind === 'number' ? 'numeric' : 'default'}
            placeholder={kind === 'date' ? 'YYYY-MM-DD' : undefined}
            placeholderTextColor={placeholder}
            className={INPUT_CLASS}
            accessibilityLabel="Default value"
            testID="form-default-value"
        />
    )
}

function DaysField({ days, onChange }: { days: number; onChange: (pick: DefaultPick) => void }) {
    // The typed text is local, so the field can be empty while the person retypes it.
    const [text, setText] = useState(String(days))
    const change = (value: string) => {
        setText(value)
        onChange({ mode: 'today_plus', days: Number.parseInt(value, 10) || 0 })
    }
    return (
        <PlainInput
            value={text}
            keyboardType="number-pad"
            onChangeText={change}
            className={INPUT_CLASS}
            accessibilityLabel="Days from today"
            testID="form-default-days"
        />
    )
}

function DaysInput({ pick, onChange }: InputProps) {
    if (pick.mode !== 'today_plus') return null
    return <DaysField days={pick.days} onChange={onChange} />
}

function DefaultError({ message }: { message: string | undefined }) {
    if (!message) return null
    return <Text className="text-xs text-danger mt-1">{message}</Text>
}

function useDefaultPicker(editor: Editor, fieldKey: string, kind: string) {
    const defaults = useWatch({ control: editor.form.control, name: 'defaults' })
    const fields = useWatch({ control: editor.form.control, name: 'fields' })
    const current = expressionToPick(defaults?.[fieldKey])
    const name = `defaults.${fieldKey}` as const
    const write = (pick: DefaultPick) => {
        const expr = pickToExpression(pick)
        editor.apply(def => {
            const { [fieldKey]: _old, ...rest } = def.defaults ?? {}
            return { ...def, defaults: expr === undefined ? rest : { ...rest, [fieldKey]: expr } }
        })
    }
    // A typed default is checked by the editor's schema once the input loses focus.
    const validate = () => {
        void editor.form.trigger(name)
    }
    const formState = useFormState({ control: editor.form.control, name })
    const error = editor.form.getFieldState(name, formState).error?.message
    const draft = { ...editor.form.getValues(), fields: fields ?? [] }
    const host = editor.host
    const isMultiple =
        kind === 'select' && host !== undefined && isMultipleField(draft, host, fieldKey)
    const choices = optionsOf(draft, fieldKey).map(o => ({ id: o.value, label: o.label }))
    return {
        current,
        write,
        validate,
        error,
        choices,
        isMultiple,
        modes: choicesFor(kind, isMultiple),
        label: labelFor(current, kind),
    }
}

export function DefaultPicker({ editor, fieldKey, kind }: DefaultPickerProps) {
    const p = useDefaultPicker(editor, fieldKey, kind)
    const { current, write, label } = p
    if (p.modes.length <= 1) return null
    const items = p.modes.map(choice => (
        <Menu.Item
            key={choice.id}
            label={choice.label}
            isSelected={isChoiceSelected(choice, current, kind)}
            onSelect={() => write(choice.pick)}
            testID={`form-default-${choice.id}`}
        />
    ))
    const trigger = (
        <Pressable
            className="border border-border rounded-md px-2 py-1 self-start"
            accessibilityLabel={`Default: ${label}`}
            testID="form-default-mode"
        >
            <Text className="text-foreground">{label}</Text>
        </Pressable>
    )
    return (
        <View className="mb-3">
            <Text className="text-sm font-semibold text-foreground mb-1">Default</Text>
            <Menu presentation="popover" trigger={trigger}>
                {items}
            </Menu>
            <LiteralInput
                pick={current}
                kind={kind}
                choices={p.choices}
                isMultiple={p.isMultiple}
                onChange={write}
                onBlur={p.validate}
            />
            <DaysInput key={fieldKey} pick={current} kind={kind} onChange={write} />
            <DefaultError message={p.error} />
        </View>
    )
}
