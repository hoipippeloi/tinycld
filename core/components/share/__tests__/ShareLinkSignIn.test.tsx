// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { ShareLinkSignIn } from '@tinycld/core/components/share/ShareLinkSignIn'
import {
    shareCodeSchema,
    shareEmailSchema,
} from '@tinycld/core/components/share/share-sign-in-schemas'
import { useAuthStore } from '@tinycld/core/lib/stores/auth-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const requestShareOtp = vi.fn()
const verifyShareOtp = vi.fn()
const initialState = useAuthStore.getState()

beforeEach(() => {
    // Replace the two network actions on the real store, so the component
    // reads them exactly as it does in the app.
    useAuthStore.setState({ requestShareOtp, verifyShareOtp })
})

afterEach(() => {
    cleanup()
    requestShareOtp.mockReset()
    verifyShareOtp.mockReset()
    useAuthStore.setState(initialState, true)
})

function input(container: HTMLElement) {
    const el = container.querySelector<HTMLInputElement>('rn-textinput')
    if (!el) throw new Error('no input rendered')
    return el
}

// mode: 'onChange' validates asynchronously; act lets it settle.
async function type(container: HTMLElement, value: string) {
    await act(async () => {
        fireEvent.input(input(container), { target: { value } })
    })
}

async function press(getByText: (text: string) => HTMLElement, label: string) {
    await act(async () => {
        fireEvent.click(getByText(label))
    })
}

function renderSignIn(onSuccess = vi.fn()) {
    const props = { slug: 'drive', token: 'tok', role: 'editor' as const, onSuccess }
    return render(<ShareLinkSignIn {...props} />)
}

describe('shareEmailSchema', () => {
    it('trims a valid address', () => {
        expect(shareEmailSchema.parse({ email: '  a@example.com ' })).toEqual({
            email: 'a@example.com',
        })
    })

    it('rejects a blank or malformed address', () => {
        expect(shareEmailSchema.safeParse({ email: '   ' }).success).toBe(false)
        expect(shareEmailSchema.safeParse({ email: 'alice' }).success).toBe(false)
    })
})

describe('shareCodeSchema', () => {
    it('accepts six digits, trimmed', () => {
        expect(shareCodeSchema.parse({ code: ' 123456 ' })).toEqual({ code: '123456' })
    })

    it('rejects anything but six digits', () => {
        for (const code of ['', '12345', '1234567', '12345a', '123 456']) {
            expect(shareCodeSchema.safeParse({ code }).success).toBe(false)
        }
    })
})

describe('ShareLinkSignIn', () => {
    it('does not request a code for a malformed email', async () => {
        const { container, getByText } = renderSignIn()
        await type(container, 'not-an-email')
        await press(getByText, 'Send code')
        expect(requestShareOtp).not.toHaveBeenCalled()
    })

    it('shows the server refusal and lets the visitor retry', async () => {
        requestShareOtp.mockResolvedValueOnce({ otpId: null, error: 'Too many requests' })
        const { container, getByText } = renderSignIn()
        await type(container, ' a@example.com ')
        await press(getByText, 'Send code')
        expect(requestShareOtp).toHaveBeenCalledWith('drive', 'tok', 'a@example.com')
        expect(getByText('Too many requests')).toBeTruthy()

        requestShareOtp.mockResolvedValueOnce({ otpId: 'otp1', error: null })
        await press(getByText, 'Send code')
        expect(requestShareOtp).toHaveBeenCalledTimes(2)
        expect(getByText('Enter your code')).toBeTruthy()
    })

    it('verifies the trimmed code against the requested email', async () => {
        requestShareOtp.mockResolvedValue({ otpId: 'otp1', error: null })
        verifyShareOtp.mockResolvedValue({ user: { id: 'u1' }, error: null })
        const onSuccess = vi.fn()
        const { container, getByText } = renderSignIn(onSuccess)
        await type(container, 'a@example.com')
        await press(getByText, 'Send code')

        await type(container, '12345')
        await press(getByText, 'Verify')
        expect(verifyShareOtp).not.toHaveBeenCalled()

        await type(container, ' 123456 ')
        await press(getByText, 'Verify')
        expect(verifyShareOtp).toHaveBeenCalledWith(
            'drive',
            'tok',
            'a@example.com',
            '123456',
            'otp1'
        )
        expect(onSuccess).toHaveBeenCalled()
    })

    it('keeps the email when the visitor goes back', async () => {
        requestShareOtp.mockResolvedValue({ otpId: 'otp1', error: null })
        const { container, getByText } = renderSignIn()
        await type(container, 'a@example.com')
        await press(getByText, 'Send code')
        await press(getByText, 'Use a different email')
        expect(input(container).value).toBe('a@example.com')
    })
})
