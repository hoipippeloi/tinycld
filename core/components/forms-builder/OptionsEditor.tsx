import type { DraftDefinition } from '@tinycld/core/lib/forms/builder'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { type Control, TextInput, useFieldArray, useWatch } from '@tinycld/core/ui/form'
import { ChevronDown, ChevronUp, X } from 'lucide-react-native'
import type { ComponentType } from 'react'
import { Pressable, Text, View } from 'react-native'

export interface OptionsEditorProps {
    control: Control<DraftDefinition>
    fieldIndex: number
}

interface RowActions {
    onRemove: () => void
    onUp: () => void
    onDown: () => void
    canRemove: boolean
    canUp: boolean
    canDown: boolean
}

interface IconActionProps {
    icon: ComponentType<{ size: number; color: string }>
    onPress: () => void
    isDisabled: boolean
    label: string
    testID: string
    /** Bottom padding lines it up with a labelled input; a plain row passes its own. */
    className?: string
}

export function IconAction({
    icon: Icon,
    onPress,
    isDisabled,
    label,
    testID,
    className = 'pb-5',
}: IconActionProps) {
    const fg = useThemeColor('foreground')
    const muted = useThemeColor('muted-foreground')
    return (
        <Pressable
            onPress={onPress}
            disabled={isDisabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: isDisabled }}
            testID={testID}
            className={className}
        >
            <Icon size={16} color={isDisabled ? muted : fg} />
        </Pressable>
    )
}

function OptionRow({
    control,
    fieldIndex,
    index,
    actions,
}: {
    control: Control<DraftDefinition>
    fieldIndex: number
    index: number
    actions: RowActions
}) {
    return (
        <View className="flex-row items-end gap-2">
            <View className="flex-1">
                <TextInput
                    control={control}
                    name={`fields.${fieldIndex}.options.${index}.label`}
                    label="Label"
                />
            </View>
            <View className="flex-1">
                <TextInput
                    control={control}
                    name={`fields.${fieldIndex}.options.${index}.value`}
                    label="Value"
                />
            </View>
            <IconAction
                icon={ChevronUp}
                onPress={actions.onUp}
                isDisabled={!actions.canUp}
                label="Move option up"
                testID={`form-option-up-${index}`}
            />
            <IconAction
                icon={ChevronDown}
                onPress={actions.onDown}
                isDisabled={!actions.canDown}
                label="Move option down"
                testID={`form-option-down-${index}`}
            />
            <IconAction
                icon={X}
                onPress={actions.onRemove}
                isDisabled={!actions.canRemove}
                label="Remove option"
                testID={`form-option-remove-${index}`}
            />
        </View>
    )
}

/** The lowest n whose `option_n` is not a value yet, so a new row never repeats one. */
export function firstFreeNumber(taken: Set<string>): number {
    let n = 1
    while (taken.has(`option_${n}`)) n += 1
    return n
}

function useOptions(control: Control<DraftDefinition>, fieldIndex: number) {
    // The path exists only on a select field; this editor mounts only for one.
    const name = `fields.${fieldIndex}.options` as `fields.${number}.options`
    const options = useFieldArray({ control, name })
    const count = options.fields.length
    const actionsFor = (index: number): RowActions => ({
        onRemove: () => options.remove(index),
        onUp: () => options.move(index, index - 1),
        onDown: () => options.move(index, index + 1),
        canRemove: count > 1,
        canUp: index > 0,
        canDown: index < count - 1,
    })
    // Watched, because typed values do not reach `options.fields`.
    const current = useWatch({ control, name }) ?? []
    const add = () => {
        const n = firstFreeNumber(new Set(current.map(o => o.value)))
        options.append({ value: `option_${n}`, label: `Option ${n}` })
    }
    return { rows: options.fields, actionsFor, add }
}

export function OptionsEditor({ control, fieldIndex }: OptionsEditorProps) {
    const { rows, actionsFor, add } = useOptions(control, fieldIndex)
    const items = rows.map((row, index) => (
        <OptionRow
            key={row.id}
            control={control}
            fieldIndex={fieldIndex}
            index={index}
            actions={actionsFor(index)}
        />
    ))
    return (
        <View className="mb-3">
            <Text className="text-sm font-semibold text-foreground mb-1">Options</Text>
            {items}
            <Button
                variant="outline"
                size="sm"
                onPress={add}
                testID="form-option-add"
                className="self-start"
            >
                <ButtonText>Add option</ButtonText>
            </Button>
        </View>
    )
}
