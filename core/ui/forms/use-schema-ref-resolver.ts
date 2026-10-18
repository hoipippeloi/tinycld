import type { FormValues } from '@tinycld/core/lib/forms/logic'
import { zodResolver } from '@tinycld/core/ui/form'
import { useRef } from 'react'
import type { Resolver } from 'react-hook-form'
import type { ZodType } from 'zod'

export type FormSchema = ZodType<FormValues, FormValues>

/**
 * A resolver that validates against whatever schema the ref holds at call time.
 * The renderer keeps the ref current, so rules like required-if validate live
 * without reaching into react-hook-form internals.
 */
export function useSchemaRefResolver(initial: FormSchema) {
    const schemaRef = useRef<FormSchema>(initial)
    const resolver: Resolver<FormValues> = (values, context, options) =>
        zodResolver(schemaRef.current)(values, context, options)
    return { schemaRef, resolver }
}
