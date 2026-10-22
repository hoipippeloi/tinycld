import { coerceLiteral, type DraftDefinition } from '@tinycld/core/lib/forms/builder'
import type { SelectOption } from '@tinycld/core/lib/forms/definition'
import { type FormHostDef, findBuiltin } from '@tinycld/core/lib/forms/host'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { PlainInput } from '@tinycld/core/ui/PlainInput'
import { X } from 'lucide-react-native'
import { useState } from 'react'
import { type Control, get, useFormState } from 'react-hook-form'
import { Pressable, Text, View } from 'react-native'
import { firstMessage } from './editor-errors'

export type DraftRule = NonNullable<DraftDefinition['rules']>[number]
export type DraftCondition = DraftRule['when'][number]
export type DraftAction = DraftRule['actions'][number]

export const RULE_INPUT_CLASS =
    'border rounded-lg px-2.5 py-1.5 text-sm text-foreground bg-background border-border min-w-[120px]'

/** A custom select's options; any other field has none to offer. */
export function optionsOf(draft: DraftDefinition, key: string): SelectOption[] {
    const field = draft.fields.find(f => f.key === key)
    return field && 'options' in field ? field.options : []
}

/** Whether the field holds a list of values (a multiple select or user field). */
export function isMultipleField(draft: DraftDefinition, host: FormHostDef, key: string): boolean {
    const field = draft.fields.find(f => f.key === key)
    if (!field) return false
    if (field.kind === 'builtin') return findBuiltin(host, key)?.multiple === true
    return 'multiple' in field && field.multiple === true
}

export { type PickItem, PickMenu } from '@tinycld/core/ui/pick-menu'

export interface Choice {
    id: string
    label: string
}

interface ChoiceChipsProps {
    choices: Choice[]
    selected: string[]
    onToggle: (id: string) => void
    /** Several may be on at once (a checkbox each) rather than one (a radio each). */
    isMultiple?: boolean
    testID: string
}

/** Inline choices for a value: each chip's test id is `${testID}-${id}`. */
export function ChoiceChips({
    choices,
    selected,
    onToggle,
    isMultiple = false,
    testID,
}: ChoiceChipsProps) {
    const chips = choices.map(choice => {
        const isOn = selected.includes(choice.id)
        return (
            <Pressable
                key={choice.id}
                onPress={() => onToggle(choice.id)}
                accessibilityRole={isMultiple ? 'checkbox' : 'radio'}
                accessibilityState={{ checked: isOn }}
                className={`rounded-md px-2 py-1 border ${isOn ? 'border-primary bg-muted' : 'border-border'}`}
                testID={`${testID}-${choice.id}`}
            >
                <Text className="text-foreground text-sm">{choice.label}</Text>
            </Pressable>
        )
    })
    return <View className="flex-row flex-wrap gap-1">{chips}</View>
}

export function RemoveButton({
    label,
    onPress,
    testID,
}: {
    label: string
    onPress: () => void
    testID: string
}) {
    const fg = useThemeColor('foreground')
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            testID={testID}
            className="p-1"
        >
            <X size={14} color={fg} />
        </Pressable>
    )
}

interface InlineErrorProps {
    control: Control<DraftDefinition>
    /** Dot path of the value the message is about. */
    name: string
    testID: string
}

/** The editor's error for one value, under the input that holds it. */
export function InlineError({ control, name, testID }: InlineErrorProps) {
    const { errors } = useFormState({ control })
    const message = firstMessage(get(errors, name))
    if (!message) return null
    return (
        <Text className="w-full text-xs text-danger" accessibilityRole="alert" testID={testID}>
            {message}
        </Text>
    )
}

interface NumberTextProps {
    value: number | null
    onChange: (value: number | null) => void
    label: string
    placeholder?: string
    /** What the owner stores for text that is not a number yet; null unless it stores 0. */
    emptyAs?: number | null
    testID: string
}

const textOf = (value: number | null) => (value === null ? '' : String(value))

function readNumber(text: string, emptyAs: number | null): number | null {
    const n = coerceLiteral('number', text)
    return text.trim() !== '' && typeof n === 'number' ? n : emptyAs
}

/** A typed number; anything that is not one yet ('', '-') is `emptyAs`. */
export function NumberText({
    value,
    onChange,
    label,
    placeholder,
    emptyAs = null,
    testID,
}: NumberTextProps) {
    const placeholderColor = useThemeColor('field-placeholder')
    // The typed text is local, so "-" and "1." can pass on their way to a number.
    const [text, setText] = useState(textOf(value))
    // A reset or a reload replaces the value under the text: then show the value,
    // so the input never shows a number the draft does not hold.
    const shown = readNumber(text, emptyAs) === value ? text : textOf(value)
    const change = (next: string) => {
        setText(next)
        onChange(readNumber(next, emptyAs))
    }
    return (
        <PlainInput
            value={shown}
            onChangeText={change}
            keyboardType="numeric"
            placeholder={placeholder}
            placeholderTextColor={placeholderColor}
            className={RULE_INPUT_CLASS}
            accessibilityLabel={label}
            testID={testID}
        />
    )
}

/** A label over a value that cannot be edited here, such as a key or a kind. */
export function ReadOnlyRow({
    label,
    value,
    testID,
}: {
    label: string
    value: string
    testID: string
}) {
    return (
        <View className="mb-3" testID={testID}>
            <Text className="text-sm font-semibold text-foreground">{label}</Text>
            <Text className="text-muted-foreground">{value}</Text>
        </View>
    )
}
