import { type Control, type FieldValues, type Path, useController } from 'react-hook-form'
import { Pressable, Text, View, type ViewProps } from 'react-native'

export type SelectOption = {
    label: string
    value: string
}

export type SelectInputProps<T extends FieldValues = Record<string, unknown>> = {
    name: Path<T>
    control: Control<T>
    label: string
    /** Keeps `label` as the group's accessible name but does not draw it, as in a table cell under its header. */
    hideLabel?: boolean
    options: SelectOption[]
    hint?: string
    /** The caller renders the error itself (a form cell does), so the input only colours its border. */
    hideError?: boolean
    horizontal?: boolean
    disabled?: boolean
    wrapperProps?: ViewProps
}

export function SelectInput<T extends FieldValues = Record<string, unknown>>({
    name,
    control,
    label,
    hideLabel = false,
    options,
    hint,
    hideError = false,
    horizontal = false,
    disabled = false,
    wrapperProps = {},
}: SelectInputProps<T>) {
    const {
        field,
        fieldState: { error },
    } = useController({ name, control })

    const hasError = !!error

    return (
        <View className="gap-1.5 mb-3" {...wrapperProps}>
            {label && !hideLabel ? (
                <Text className="text-sm font-semibold text-foreground">{label}</Text>
            ) : null}
            <View
                accessibilityRole="radiogroup"
                accessibilityLabel={label}
                className={horizontal ? 'flex-row gap-2 flex-wrap' : 'flex-col gap-1'}
            >
                {options.map(option => {
                    const isSelected = field.value === option.value
                    return (
                        <Pressable
                            key={option.value}
                            accessibilityLabel={option.label}
                            onPress={() => field.onChange(option.value)}
                            disabled={disabled}
                            accessibilityRole="radio"
                            // A radio's state is "checked"; ARIA ignores aria-selected
                            // on it, so a reader would call every option unchecked.
                            accessibilityState={{ checked: isSelected, disabled }}
                            aria-checked={isSelected}
                            aria-disabled={disabled}
                            className={`border rounded-lg py-2 px-4 items-center ${isSelected ? 'border-primary bg-primary' : 'border-border bg-transparent'}`}
                            style={{
                                flex: horizontal ? 1 : undefined,
                                minWidth: horizontal ? 80 : undefined,
                            }}
                        >
                            <Text
                                className={`text-sm font-medium ${isSelected ? 'text-primary-foreground' : 'text-foreground'}`}
                            >
                                {option.label}
                            </Text>
                        </Pressable>
                    )
                })}
            </View>
            {hint && !hasError ? <Text className="text-xs text-muted">{hint}</Text> : null}
            {hasError && !hideError ? (
                <Text className="text-xs text-danger">{error.message}</Text>
            ) : null}
        </View>
    )
}
