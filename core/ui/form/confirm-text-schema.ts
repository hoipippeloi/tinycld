import { z } from 'zod'

type ConfirmTextOptions = {
    ignoreCase?: boolean
    message?: string
}

/**
 * Schema for a "type X to confirm" field guarding a destructive action. The
 * form is valid only once the typed text matches `expected`, ignoring
 * surrounding whitespace on both sides.
 */
export function confirmTextSchema(expected: string, options: ConfirmTextOptions = {}) {
    const { ignoreCase = false, message = `Type ${expected.trim()} to confirm` } = options
    const normalize = (value: string) => (ignoreCase ? value.trim().toLowerCase() : value.trim())
    const target = normalize(expected)
    return z.object({
        confirm: z.string().refine(value => target !== '' && normalize(value) === target, message),
    })
}
