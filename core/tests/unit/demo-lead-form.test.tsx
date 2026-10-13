// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import {
    DemoLeadForm,
    type DemoLeadFormHandle,
    demoLeadSchema,
} from '@tinycld/core/components/DemoLeadForm'
import { setResolvedAddress } from '@tinycld/core/lib/server-address'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchSpy = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 })
)

beforeEach(() => {
    setResolvedAddress('https://pb.example.com')
    vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
    cleanup()
    fetchSpy.mockClear()
    vi.unstubAllGlobals()
    setResolvedAddress(null)
})

function emailInput(container: HTMLElement) {
    const el = container.querySelector<HTMLInputElement>('rn-textinput')
    if (!el) throw new Error('no input rendered')
    return el
}

describe('demoLeadSchema', () => {
    it('trims the email and accepts a blank reason', () => {
        expect(demoLeadSchema.parse({ email: ' a@example.com ', reason: '' })).toEqual({
            email: 'a@example.com',
            reason: '',
        })
    })

    it('rejects a blank or malformed email', () => {
        expect(demoLeadSchema.safeParse({ email: '  ' }).success).toBe(false)
        expect(demoLeadSchema.safeParse({ email: 'alice' }).success).toBe(false)
    })

    it('caps the reason at 2000 characters', () => {
        const reason = 'x'.repeat(2001)
        expect(demoLeadSchema.safeParse({ email: 'a@example.com', reason }).success).toBe(false)
    })
})

describe('DemoLeadForm', () => {
    it('keeps the modal open and shows the error when the email is missing', async () => {
        const ref = createRef<DemoLeadFormHandle>()
        const { getAllByText } = render(<DemoLeadForm ref={ref} source="intro_modal" />)

        let dismissed = true
        await act(async () => {
            dismissed = ref.current?.submit() ?? true
        })

        expect(dismissed).toBe(false)
        expect(getAllByText(/Email is required/).length).toBeGreaterThan(0)
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('dismisses in the same tick and posts the trimmed email', async () => {
        const ref = createRef<DemoLeadFormHandle>()
        const { container } = render(<DemoLeadForm ref={ref} source="banner_link" />)
        // mode: 'onChange' validates asynchronously; let isValid settle.
        await act(async () => {
            fireEvent.input(emailInput(container), { target: { value: ' a@example.com ' } })
        })

        let dismissed = false
        await act(async () => {
            dismissed = ref.current?.submit() ?? false
        })

        expect(dismissed).toBe(true)
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
        const [url, init] = fetchSpy.mock.calls[0]
        expect(url).toBe('https://pb.example.com/api/demo/lead')
        expect(JSON.parse(String(init?.body))).toEqual({
            email: 'a@example.com',
            reason: '',
            source: 'banner_link',
        })
    })
})
