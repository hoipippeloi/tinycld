// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// LoginModal only needs login() + the current user from useAuth — mock it
// directly so the test never needs a real pbtsdb/PocketBase stack.
const login = vi.fn()
vi.mock('@tinycld/core/lib/auth', () => ({
    useAuth: () => ({
        login,
        logout: vi.fn(),
        user: null,
        isLoggedIn: false,
        isInitializing: false,
    }),
}))

// The reset request is a network call; the form only needs to know it ran.
const requestPasswordReset = vi.fn(async (_email: string) => {})
vi.mock('@tinycld/core/lib/account-password', () => ({
    requestPasswordReset: (email: string) => requestPasswordReset(email),
}))

// Pre-auth branding lookup — irrelevant to the notice behavior under test.
vi.mock('@tinycld/core/lib/use-org-info', () => ({ useOrgInfo: () => ({ org: null }) }))

import { LoginModal } from '@tinycld/core/components/workspace/LoginModal'
import { useSignInNoticeStore } from '@tinycld/core/lib/stores/sign-in-notice-store'

// The RN test stub passes testID straight through as a literal lowercase
// `testid` attribute (not RTL's default `data-testid`), so queries here go
// through the DOM directly rather than getByTestId — same convention as
// toast-placement.test.tsx.
function byTestId(container: HTMLElement, id: string): HTMLElement | null {
    return container.querySelector(`[testid="${id}"]`)
}

// mode: 'onChange' validates asynchronously; act lets it settle so the submit
// button reflects the typed values.
async function typeInto(input: HTMLElement | null, value: string) {
    if (!input) throw new Error('input not rendered')
    await act(async () => {
        fireEvent.input(input, { target: { value } })
    })
}

async function click(el: HTMLElement | null) {
    if (!el) throw new Error('element not rendered')
    await act(async () => {
        fireEvent.click(el)
    })
}

afterEach(() => {
    cleanup()
    login.mockReset()
    requestPasswordReset.mockClear()
    useSignInNoticeStore.setState({ notice: null, shownBy: null })
})

describe('LoginModal — sign-in notice', () => {
    it('renders a notice a package set before routing here', () => {
        useSignInNoticeStore.getState().setNotice('Your widgets invite link has expired.')
        const { container } = render(<LoginModal />)
        expect(byTestId(container, 'sign-in-notice')?.textContent).toBe(
            'Your widgets invite link has expired.'
        )
    })

    it('renders nothing when no notice is set', () => {
        const { container } = render(<LoginModal />)
        expect(byTestId(container, 'sign-in-notice')).toBeNull()
    })

    it('clears the notice after a successful sign-in', async () => {
        useSignInNoticeStore.getState().setNotice('Your widgets invite link has expired.')
        login.mockResolvedValue({ user: { id: 'u1', email: 'a@example.com' }, error: null })

        const { container } = render(<LoginModal />)
        expect(byTestId(container, 'sign-in-notice')).toBeTruthy()

        await typeInto(byTestId(container, 'identifier'), 'alice@example.com')
        await typeInto(byTestId(container, 'login-password'), 'secret')
        await click(byTestId(container, 'login-submit'))

        expect(login).toHaveBeenCalledWith('alice@example.com', 'secret')
        await vi.waitFor(() => {
            expect(useSignInNoticeStore.getState().notice).toBeNull()
        })
    })

    it('keeps the notice through StrictMode double effects', () => {
        useSignInNoticeStore.getState().setNotice('Your widgets invite link has expired.')
        const { container } = render(
            <StrictMode>
                <LoginModal />
            </StrictMode>
        )
        expect(byTestId(container, 'sign-in-notice')).toBeTruthy()
        expect(useSignInNoticeStore.getState().notice).toBe('Your widgets invite link has expired.')
    })

    it('does not show the notice again after the user left sign-in without signing in', () => {
        useSignInNoticeStore.getState().setNotice('Your widgets invite link has expired.')
        const first = render(<LoginModal />)
        expect(byTestId(first.container, 'sign-in-notice')).toBeTruthy()
        first.unmount()

        const { container } = render(<LoginModal />)
        expect(byTestId(container, 'sign-in-notice')).toBeNull()
        expect(useSignInNoticeStore.getState().notice).toBeNull()
    })
})

describe('LoginModal — sign-in error', () => {
    it('shows no error before a sign-in attempt', () => {
        const { container } = render(<LoginModal />)
        expect(byTestId(container, 'sign-in-error')).toBeNull()
    })

    it('shows the error a failed sign-in returns', async () => {
        login.mockResolvedValue({ user: null, error: 'Wrong password.' })
        const { container } = render(<LoginModal />)
        await typeInto(byTestId(container, 'identifier'), 'alice@example.com')
        await typeInto(byTestId(container, 'login-password'), 'wrong')
        await click(byTestId(container, 'login-submit'))

        await vi.waitFor(() => {
            expect(byTestId(container, 'sign-in-error')?.textContent).toBe('Wrong password.')
        })
    })
})

describe('LoginModal — sign-in validation', () => {
    it('trims the identifier before signing in', async () => {
        login.mockResolvedValue({ user: null, error: 'Wrong password.' })
        const { container } = render(<LoginModal />)
        await typeInto(byTestId(container, 'identifier'), '  alice  ')
        await typeInto(byTestId(container, 'login-password'), ' pw ')
        await click(byTestId(container, 'login-submit'))

        expect(login).toHaveBeenCalledWith('alice', ' pw ')
    })

    it('does not sign in with a whitespace-only identifier', async () => {
        const { container } = render(<LoginModal />)
        await typeInto(byTestId(container, 'identifier'), '   ')
        await typeInto(byTestId(container, 'login-password'), 'secret')
        await click(byTestId(container, 'login-submit'))

        expect(login).not.toHaveBeenCalled()
    })

    it('clears the server error on the next attempt', async () => {
        login.mockResolvedValueOnce({ user: null, error: 'Wrong password.' })
        const { container } = render(<LoginModal />)
        await typeInto(byTestId(container, 'identifier'), 'alice')
        await typeInto(byTestId(container, 'login-password'), 'wrong')
        await click(byTestId(container, 'login-submit'))
        expect(byTestId(container, 'sign-in-error')?.textContent).toBe('Wrong password.')

        let resolve: (value: { user: null; error: null }) => void = () => {}
        login.mockReturnValueOnce(
            new Promise(r => {
                resolve = r
            })
        )
        await click(byTestId(container, 'login-submit'))
        expect(login).toHaveBeenCalledTimes(2)
        expect(byTestId(container, 'sign-in-error')).toBeNull()
        await act(async () => resolve({ user: null, error: null }))
    })
})

describe('LoginModal — reset request', () => {
    async function openReset(container: HTMLElement) {
        await click(byTestId(container, 'forgot-password-link'))
    }

    it('does not send a reset link for a malformed email', async () => {
        const { container } = render(<LoginModal />)
        await openReset(container)
        await typeInto(byTestId(container, 'reset-email'), 'not-an-email')
        await click(byTestId(container, 'reset-submit'))

        expect(requestPasswordReset).not.toHaveBeenCalled()
        expect(byTestId(container, 'reset-sent')).toBeNull()
    })

    it('sends the trimmed email and shows the confirmation', async () => {
        const { container } = render(<LoginModal />)
        await openReset(container)
        await typeInto(byTestId(container, 'reset-email'), '  alice@example.com ')
        await click(byTestId(container, 'reset-submit'))

        expect(requestPasswordReset).toHaveBeenCalledWith('alice@example.com')
        expect(byTestId(container, 'reset-sent')).toBeTruthy()
        expect(byTestId(container, 'reset-email')).toBeNull()
    })
})
