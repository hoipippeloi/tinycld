// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Toggle } from '../Toggle'

afterEach(cleanup)

let latest: () => boolean = () => false

function Harness({ onValueChange }: { onValueChange?: (value: boolean) => void }) {
    const { control, getValues } = useForm({ defaultValues: { on: false } })
    latest = () => getValues('on')
    return <Toggle control={control} name="on" label="Flag" onValueChange={onValueChange} />
}

function press() {
    const el = document.querySelector('[accessibilitylabel="Flag"]')
    if (!el) throw new Error('no toggle')
    fireEvent.click(el)
}

describe('Toggle', () => {
    it('calls onValueChange once with the new boolean and updates the form value', () => {
        const onValueChange = vi.fn()
        render(<Harness onValueChange={onValueChange} />)
        press()
        expect(onValueChange).toHaveBeenCalledTimes(1)
        expect(onValueChange).toHaveBeenCalledWith(true)
        expect(latest()).toBe(true)
        press()
        expect(onValueChange).toHaveBeenLastCalledWith(false)
        expect(latest()).toBe(false)
    })
    it('changes the form value the same way when no onValueChange is given', () => {
        render(<Harness />)
        press()
        expect(latest()).toBe(true)
    })
})
