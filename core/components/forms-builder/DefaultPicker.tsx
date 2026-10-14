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
import { Pressable, Text, View } from 'react-native'
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

/** The first pick a mode starts from when it is chosen. */
function startingPick(mode: PickMode): DefaultPick {
    if (mode === 'literal') return { mode: 'literal', value: '' }
    if (mode === 'today_plus') return { mode: 'today_plus', days: 7 }
    return { mode }
}

/** A toggle's literal is On or Off, so it is offered as two choices instead of a typed value. */
function choicesFor(kind: string): Choice[] {
    return picksFor(kind).flatMap((mode): Choice[] => {
        if (kind === 'toggle' && mode === 'literal')
            return [
                { id: 'on', label: 'On', pick: { mode: 'literal', value: true } },
                { id: 'off', label: 'Off', pick: { mode: 'literal', value: false } },
            ]
        return [{ id: mode, label: MODE_LABELS[mode], pick: startingPick(mode) }]
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

function LiteralInput({ pick, kind, onChange }: InputProps) {
    const placeholder = useThemeColor('field-placeholder')
    if (pick.mode !== 'literal' || kind === 'toggle') return null
    const text = String(pick.value)
    // The raw text is kept while typing so a number can pass through "1." on its way to "1.5".
    return (
        <PlainInput
            value={text}
            onChangeText={value => onChange({ mode: 'literal', value })}
            onBlur={() => onChange({ mode: 'literal', value: coerceLiteral(kind, text) })}
            keyboardType={kind === 'number' ? 'numeric' : 'default'}
            placeholderTextColor={placeholder}
            className={INPUT_CLASS}
            accessibilityLabel="Default value"
            testID="form-default-value"
        />
    )
}

function DaysInput({ pick, onChange }: InputProps) {
    if (pick.mode !== 'today_plus') return null
    return (
        <PlainInput
            value={String(pick.days)}
            keyboardType="number-pad"
            onChangeText={v => onChange({ mode: 'today_plus', days: Number.parseInt(v, 10) || 0 })}
            className={INPUT_CLASS}
            accessibilityLabel="Days from today"
            testID="form-default-days"
        />
    )
}

function useDefaultPicker(editor: Editor, fieldKey: string, kind: string) {
    const defaults = useWatch({ control: editor.form.control, name: 'defaults' })
    const current = expressionToPick(defaults?.[fieldKey])
    const write = (pick: DefaultPick) => {
        const expr = pickToExpression(pick)
        editor.apply(def => {
            const { [fieldKey]: _old, ...rest } = def.defaults ?? {}
            return { ...def, defaults: expr === undefined ? rest : { ...rest, [fieldKey]: expr } }
        })
    }
    return { current, write, choices: choicesFor(kind), label: labelFor(current, kind) }
}

export function DefaultPicker({ editor, fieldKey, kind }: DefaultPickerProps) {
    const { current, write, choices, label } = useDefaultPicker(editor, fieldKey, kind)
    if (choices.length <= 1) return null
    const items = choices.map(choice => (
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
            accessibilityLabel="Default"
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
            <LiteralInput pick={current} kind={kind} onChange={write} />
            <DaysInput pick={current} kind={kind} onChange={write} />
        </View>
    )
}
