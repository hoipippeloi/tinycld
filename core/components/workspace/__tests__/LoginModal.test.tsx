// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { type ReactNode, StrictMode } from 'react'
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
const confirmPasswordReset = vi.fn(async (_token: string, _pw: string, _confirm: string) => {})
vi.mock('@tinycld/core/lib/account-password', () => ({
    requestPasswordReset: (email: string) => requestPasswordReset(email),
    confirmPasswordReset: (token: string, pw: string, confirm: string) =>
        confirmPasswordReset(token, pw, confirm),
}))

// The passkey ceremony is the platform's (browser or sheet); tests choose its
// outcome.
const passkeySignIn = vi.fn()
vi.mock('@tinycld/core/lib/passkey', () => ({
    passkeys: {
        isAvailable: () => true,
        signIn: () => passkeySignIn(),
        secondStep: vi.fn(),
        add: vi.fn(),
        enroll: vi.fn(),
    },
}))

// Pre-auth branding lookup — irrelevant to the notice behavior under test.
vi.mock('@tinycld/core/lib/use-org-info', () => ({ useOrgInfo: () => ({ org: null }) }))

import { LoginModal } from '@tinycld/core/components/workspace/LoginModal'
import { NativeAuthPasswordChanged } from '@tinycld/core/lib/native-auth-errors'
import { useSignInNoticeStore } from '@tinycld/core/lib/stores/sign-in-notice-store'
import { useSignInStepStore } from '@tinycld/core/lib/stores/sign-in-step-store'

// The passkey button's useMutation needs a QueryClient, as it has under
// Providers in the app.
function QueryWrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

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
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        expect(byTestId(container, 'sign-in-notice')?.textContent).toBe(
            'Your widgets invite link has expired.'
        )
    })

    it('renders nothing when no notice is set', () => {
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        expect(byTestId(container, 'sign-in-notice')).toBeNull()
    })

    it('clears the notice after a successful sign-in', async () => {
        useSignInNoticeStore.getState().setNotice('Your widgets invite link has expired.')
        login.mockResolvedValue({ user: { id: 'u1', email: 'a@example.com' }, error: null })

        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
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
            </StrictMode>,
            { wrapper: QueryWrapper }
        )
        expect(byTestId(container, 'sign-in-notice')).toBeTruthy()
        expect(useSignInNoticeStore.getState().notice).toBe('Your widgets invite link has expired.')
    })

    it('does not show the notice again after the user left sign-in without signing in', () => {
        useSignInNoticeStore.getState().setNotice('Your widgets invite link has expired.')
        const first = render(<LoginModal />, { wrapper: QueryWrapper })
        expect(byTestId(first.container, 'sign-in-notice')).toBeTruthy()
        first.unmount()

        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        expect(byTestId(container, 'sign-in-notice')).toBeNull()
        expect(useSignInNoticeStore.getState().notice).toBeNull()
    })
})

describe('LoginModal — sign-in error', () => {
    it('shows no error before a sign-in attempt', () => {
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        expect(byTestId(container, 'sign-in-error')).toBeNull()
    })

    it('shows the error a failed sign-in returns', async () => {
        login.mockResolvedValue({ user: null, error: 'Wrong password.' })
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        await typeInto(byTestId(container, 'identifier'), 'alice@example.com')
        await typeInto(byTestId(container, 'login-password'), 'wrong')
        await click(byTestId(container, 'login-submit'))

        await vi.waitFor(() => {
            expect(byTestId(container, 'sign-in-error')?.textContent).toBe('Wrong password.')
        })
    })
})

describe('LoginModal — second sign-in step', () => {
    afterEach(() => useSignInStepStore.getState().clear())

    // login() puts the step in the store when the server asks for one; the
    // overlay then swaps the password form for the code form.
    it('shows the code step after a correct password with MFA on', async () => {
        login.mockImplementation(async () => {
            const step = {
                kind: 'mfa' as const,
                token: 'tok',
                methods: ['totp' as const, 'recovery' as const],
            }
            useSignInStepStore.getState().setStep(step)
            return { user: null, error: null, step }
        })
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        await typeInto(byTestId(container, 'identifier'), 'alice')
        await typeInto(byTestId(container, 'login-password'), 'pw')
        await click(byTestId(container, 'login-submit'))

        await vi.waitFor(() => expect(byTestId(container, 'mfa-step')).toBeTruthy())
        expect(byTestId(container, 'login-submit')).toBeNull()
        expect(byTestId(container, 'sign-in-error')).toBeNull()
        expect(byTestId(container, 'mfa-code')).toBeTruthy()
        // Only the methods the server offered are shown.
        expect(byTestId(container, 'mfa-passkey')).toBeNull()

        await click(byTestId(container, 'mfa-switch'))
        expect(byTestId(container, 'mfa-recovery-code')).toBeTruthy()
    })

    // handleSubmit marks the form "succeeded" after a step answer; the form
    // must still be editable when the user comes back to it.
    it('leaves the form editable after going back from a step', async () => {
        login.mockImplementation(async () => {
            const step = { kind: 'mfa' as const, token: 'tok', methods: ['totp' as const] }
            useSignInStepStore.getState().setStep(step)
            return { user: null, error: null, step }
        })
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        await typeInto(byTestId(container, 'identifier'), 'alice')
        await typeInto(byTestId(container, 'login-password'), 'pw')
        await click(byTestId(container, 'login-submit'))
        await vi.waitFor(() => expect(byTestId(container, 'mfa-step')).toBeTruthy())

        await click(byTestId(container, 'mfa-back'))
        const identifier = byTestId(container, 'identifier') as HTMLInputElement
        // The stub renders `editable` as an attribute only while it is true.
        expect(identifier.hasAttribute('editable')).toBe(true)
        expect(identifier.value).toBe('alice')
        expect((byTestId(container, 'login-password') as HTMLInputElement).value).toBe('')
    })

    it('goes back to the password form', async () => {
        useSignInStepStore.getState().setStep({ kind: 'mfa', token: 'tok', methods: ['totp'] })
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        await click(byTestId(container, 'mfa-back'))
        expect(byTestId(container, 'login-submit')).toBeTruthy()
        expect(useSignInStepStore.getState().step).toBeNull()
    })

    it('asks for a new password after a temporary one, then returns to sign-in', async () => {
        confirmPasswordReset.mockResolvedValue(undefined)
        useSignInStepStore.getState().setStep({ kind: 'password', token: 'reset-tok' })
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        expect(byTestId(container, 'password-step')).toBeTruthy()

        await typeInto(byTestId(container, 'new-password'), 'MyOwnPass123!')
        await typeInto(byTestId(container, 'new-password-confirm'), 'MyOwnPass123!')
        await click(byTestId(container, 'new-password-submit'))

        await vi.waitFor(() => expect(byTestId(container, 'login-submit')).toBeTruthy())
        expect(confirmPasswordReset).toHaveBeenCalledWith(
            'reset-tok',
            'MyOwnPass123!',
            'MyOwnPass123!'
        )
        expect(byTestId(container, 'sign-in-notice')?.textContent).toContain('new password is set')
    })

    // On mobile the browser sheet replaces a temporary password itself; the
    // app then guides the user to sign in again instead of showing an error.
    it('asks for a fresh sign-in after the passkey sheet changed the password', async () => {
        passkeySignIn.mockRejectedValue(new NativeAuthPasswordChanged())
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        await click(byTestId(container, 'login-passkey'))

        await vi.waitFor(() =>
            expect(byTestId(container, 'sign-in-notice')?.textContent).toContain(
                'new password is set'
            )
        )
        expect(container.textContent).not.toContain('Sign-in was cancelled')
    })

    it('shows the enrollment step when the organization requires MFA', () => {
        useSignInStepStore.getState().setStep({ kind: 'enroll', token: 'enroll' })
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        expect(byTestId(container, 'enroll-step')).toBeTruthy()
        expect(byTestId(container, 'enroll-totp')).toBeTruthy()
    })
})

describe('LoginModal — sign-in validation', () => {
    it('trims the identifier before signing in', async () => {
        login.mockResolvedValue({ user: null, error: 'Wrong password.' })
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        await typeInto(byTestId(container, 'identifier'), '  alice  ')
        await typeInto(byTestId(container, 'login-password'), ' pw ')
        await click(byTestId(container, 'login-submit'))

        expect(login).toHaveBeenCalledWith('alice', ' pw ')
    })

    it('does not sign in with a whitespace-only identifier', async () => {
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        await typeInto(byTestId(container, 'identifier'), '   ')
        await typeInto(byTestId(container, 'login-password'), 'secret')
        await click(byTestId(container, 'login-submit'))

        expect(login).not.toHaveBeenCalled()
    })

    it('clears the server error on the next attempt', async () => {
        login.mockResolvedValueOnce({ user: null, error: 'Wrong password.' })
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
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
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        await openReset(container)
        await typeInto(byTestId(container, 'reset-email'), 'not-an-email')
        await click(byTestId(container, 'reset-submit'))

        expect(requestPasswordReset).not.toHaveBeenCalled()
        expect(byTestId(container, 'reset-sent')).toBeNull()
    })

    it('sends the trimmed email and shows the confirmation', async () => {
        const { container } = render(<LoginModal />, { wrapper: QueryWrapper })
        await openReset(container)
        await typeInto(byTestId(container, 'reset-email'), '  alice@example.com ')
        await click(byTestId(container, 'reset-submit'))

        expect(requestPasswordReset).toHaveBeenCalledWith('alice@example.com')
        expect(byTestId(container, 'reset-sent')).toBeTruthy()
        expect(byTestId(container, 'reset-email')).toBeNull()
    })
})
