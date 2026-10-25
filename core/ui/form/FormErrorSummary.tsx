import type { FieldErrors } from 'react-hook-form'
import { Text, View } from 'react-native'

type ErrorEntry = {
    key: string
    message: string
}

const IGNORED_ERROR_KEYS = new Set(['type', 'ref', 'message', 'types'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null

const flattenErrorValue = (value: unknown, keyPath: string): ErrorEntry[] => {
    if (!value) return []

    if (Array.isArray(value)) {
        return value.flatMap((item, index) =>
            flattenErrorValue(item, keyPath ? `${keyPath}[${index}]` : `[${index}]`)
        )
    }

    if (isRecord(value)) {
        return flattenRecordErrors(value, keyPath)
    }

    return typeof value === 'string' ? [{ key: keyPath || 'form', message: value }] : []
}

const flattenRecordErrors = (record: Record<string, unknown>, keyPath: string): ErrorEntry[] => {
    const currentKey = keyPath || 'form'
    const entries: ErrorEntry[] = []

    const message = typeof record.message === 'string' ? record.message : null
    if (message) entries.push({ key: currentKey, message })

    if (isRecord(record.types)) {
        for (const val of Object.values(record.types)) {
            if (typeof val === 'string') entries.push({ key: currentKey, message: val })
        }
    }

    for (const [nestedKey, nestedValue] of Object.entries(record)) {
        if (IGNORED_ERROR_KEYS.has(nestedKey)) continue
        const nextKey = keyPath ? `${keyPath}.${nestedKey}` : nestedKey
        entries.push(...flattenErrorValue(nestedValue, nextKey))
    }

    return entries
}

// A form-level error (setError('root', …), or a bare string) is not about a
// named field, so it reads as a plain sentence rather than "root: …".
const FORM_LEVEL_KEY = /^(root|form)(\.|$)/

const entryText = (entry: ErrorEntry, showFieldNames: boolean) => {
    const message = entry.message || 'Invalid value'
    if (!showFieldNames || FORM_LEVEL_KEY.test(entry.key)) return message
    return `${entry.key}: ${message}`
}

const extractErrorEntries = (errors: FieldErrors): ErrorEntry[] =>
    Object.entries(errors).flatMap(([key, value]) => flattenErrorValue(value, key))

export interface FormErrorSummaryProps {
    errors: FieldErrors
    /** `null` hides the title line. */
    title?: string | null
    /** `destructive` is an outlined box with destructive-colored messages and no tinted fill. */
    variant?: 'soft' | 'destructive'
    testID?: string
    isEnabled?: boolean
    /**
     * Prefix each message with its field path. Turn off when the messages are
     * already full sentences and the paths are internal (`actions[0].params.x`).
     */
    showFieldNames?: boolean
}

export function FormErrorSummary({
    errors,
    title = 'Please fix the following errors:',
    testID,
    variant = 'soft',
    isEnabled = false,
    showFieldNames = true,
}: FormErrorSummaryProps) {
    if (!isEnabled) return null

    const errorEntries = extractErrorEntries(errors)
    if (errorEntries.length === 0) return null

    const isDestructive = variant === 'destructive'
    const boxClass = isDestructive
        ? 'border border-destructive rounded-md px-3 py-2 gap-1'
        : 'bg-danger-soft border border-danger-soft-foreground rounded-lg p-3 mb-3'
    const messageClass = isDestructive ? 'text-sm text-destructive' : 'text-xs text-danger mb-1'

    return (
        <View
            className={boxClass}
            testID={testID}
            accessibilityRole={isDestructive ? 'alert' : undefined}
        >
            {title === null ? null : (
                <Text className="text-sm font-semibold text-danger mb-2">{title}</Text>
            )}
            {errorEntries.map(entry => (
                <Text key={`${entry.key}-${entry.message}`} className={messageClass}>
                    {entryText(entry, showFieldNames)}
                </Text>
            ))}
        </View>
    )
}
