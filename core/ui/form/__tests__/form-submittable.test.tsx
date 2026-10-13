// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useForm, z, zodResolver } from '..'
import { isFormSubmittable } from '../form-submittable'

const schema = z.object({ name: z.string().trim().min(1) })

// formState is a subscription proxy: read the fields during render, as a
// component does, or RHF never reports changes to them.
function useNameForm(name: string) {
    const form = useForm({
        resolver: zodResolver(schema),
        defaultValues: { name },
        mode: 'onChange',
    })
    const { isValid, errors } = form.formState
    return { form, isValid, isSubmittable: isFormSubmittable({ isValid, errors }) }
}

describe('isFormSubmittable', () => {
    it('stays submittable after a server error on root', async () => {
        const { result } = renderHook(() => useNameForm('Roadmap'))
        await act(async () => {
            await result.current.form.trigger()
        })
        expect(result.current.isSubmittable).toBe(true)
        act(() => result.current.form.setError('root', { type: 'server', message: 'Try again' }))
        expect(result.current.isValid).toBe(false)
        expect(result.current.isSubmittable).toBe(true)
    })

    it('is not submittable while a field is invalid', async () => {
        const { result } = renderHook(() => useNameForm('  '))
        await act(async () => {
            await result.current.form.trigger()
        })
        expect(result.current.isSubmittable).toBe(false)
    })
})
