import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Menu } from '@tinycld/core/ui/menu'
import { ChevronDown } from 'lucide-react-native'
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
    /** Called after the form value changes to a different option, so a caller can clear dependent fields in the change event itself. */
    onValueChange?: (value: string) => void
    wrapperProps?: ViewProps
    /** `dropdown` collapses a long list into a 44pt trigger that opens a menu; item test ids are `${testID}-${value}`. */
    presentation?: 'buttons' | 'dropdown'
    /** Shown in the dropdown trigger while no option matches the value. */
    placeholder?: string
    testID?: string
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
    onValueChange,
    wrapperProps = {},
    presentation = 'buttons',
    placeholder = '',
    testID,
}: SelectInputProps<T>) {
    const {
        field,
        fieldState: { error },
    } = useController({ name, control })

    const hasError = !!error
    const isDropdown = presentation === 'dropdown'

    const choose = (value: string) => {
        const changed = field.value !== value
        field.onChange(value)
        if (changed) onValueChange?.(value)
    }

    return (
        <View className="gap-1.5 mb-3" {...wrapperProps}>
            {label && !hideLabel ? (
                <Text className="text-sm font-semibold text-foreground">{label}</Text>
            ) : null}
            <DropdownField
                isVisible={isDropdown}
                value={field.value}
                options={options}
                placeholder={placeholder}
                label={label}
                disabled={disabled}
                hasError={hasError && !hideError}
                testID={testID}
                onChoose={choose}
            />
            <ButtonGroup
                isVisible={!isDropdown}
                label={label}
                horizontal={horizontal}
                disabled={disabled}
                options={options}
                value={field.value}
                onChoose={choose}
            />
            {hint && !hasError ? <Text className="text-xs text-muted">{hint}</Text> : null}
            {hasError && !hideError ? (
                <Text className="text-xs text-danger">{error.message}</Text>
            ) : null}
        </View>
    )
}

interface ChoiceProps {
    label: string
    disabled: boolean
    options: SelectOption[]
    value: string
    onChoose: (value: string) => void
}

function ButtonGroup({
    isVisible,
    label,
    horizontal,
    disabled,
    options,
    value,
    onChoose,
}: ChoiceProps & { isVisible: boolean; horizontal: boolean }) {
    if (!isVisible) return null
    return (
        <View
            accessibilityRole="radiogroup"
            accessibilityLabel={label}
            className={horizontal ? 'flex-row gap-2 flex-wrap' : 'flex-col gap-1'}
        >
            {options.map(option => {
                const isSelected = value === option.value
                return (
                    <Pressable
                        key={option.value}
                        accessibilityLabel={option.label}
                        onPress={() => onChoose(option.value)}
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
    )
}

function DropdownField({
    isVisible,
    label,
    disabled,
    options,
    value,
    onChoose,
    placeholder,
    hasError,
    testID,
}: ChoiceProps & {
    isVisible: boolean
    placeholder: string
    hasError: boolean
    testID?: string
}) {
    const muted = useThemeColor('muted-foreground')
    if (!isVisible) return null
    const shown = options.find(option => option.value === value)?.label ?? placeholder
    const trigger = (
        <Pressable
            className={`flex-row items-center justify-between gap-2 border rounded-md px-3 ${hasError ? 'border-danger' : 'border-border'}`}
            style={{ minHeight: 44 }}
            accessibilityLabel={`${label}: ${shown}`}
            disabled={disabled}
            aria-disabled={disabled}
            accessibilityState={{ disabled }}
            testID={testID}
        >
            <Text className="text-foreground text-sm">{shown}</Text>
            <ChevronDown size={12} color={muted} />
        </Pressable>
    )
    return (
        <Menu presentation="popover" trigger={trigger}>
            {options.map(option => (
                <Menu.Item
                    key={option.value}
                    label={option.label}
                    isSelected={option.value === value}
                    onSelect={() => onChoose(option.value)}
                    testID={testID ? `${testID}-${option.value}` : undefined}
                />
            ))}
        </Menu>
    )
}
