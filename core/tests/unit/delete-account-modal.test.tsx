// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The regression this suite guards: the content-plan picker used to highlight
// "Delete everything" while an unclicked submit sent NO plan — which the
// server (correctly) treats as "leave my content". The UI showed the
// destructive option selected while the safe one executed. The contract now:
// nothing is pre-selected, and submit is blocked until a plan is chosen
// whenever there is a peer to reassign to.

const h = vi.hoisted(() => ({
    // Which users fixture the mocked useStore serves. Collections are created
    // once at mock time, so scenarios are prebuilt rather than mutated.
    scenario: 'withPeer' as 'withPeer' | 'solo',
    send: vi.fn(async () => ({})),
    logout: vi.fn(),
}))

vi.mock('@tinycld/core/lib/auth', () => ({
    useAuth: () => ({ user: { id: 'u1', email: 'me@example.com' }, logout: h.logout }),
}))

vi.mock('@tinycld/core/lib/pocketbase', async () => {
    const { createCollection, localOnlyCollectionOptions } = await import('@tanstack/db')
    const mk = (id: string, initialData: { id: string }[]) =>
        createCollection(
            localOnlyCollectionOptions({ id, getKey: (r: { id: string }) => r.id, initialData })
        )
    const me = { id: 'u1', name: 'Me', email: 'me@example.com', role: 'owner', disabled: false }
    const peer = {
        id: 'u2',
        name: 'Peer',
        email: 'peer@example.com',
        role: 'member',
        disabled: false,
    }
    const registry: Record<string, Record<string, unknown>> = {
        withPeer: { users: mk('users-with-peer', [me, peer]) },
        solo: { users: mk('users-solo', [me]) },
    }
    return {
        useStore: (...names: string[]) => names.map(n => registry[h.scenario][n]),
        pb: { send: h.send },
    }
})

import { useDeleteAccountForm } from '../../components/settings/DeleteAccountModal'

function wrapper() {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    return ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
}

afterEach(() => {
    cleanup()
    h.send.mockClear()
    h.logout.mockClear()
    h.scenario = 'withPeer'
})

const noop = () => {}

type Form = ReturnType<typeof useDeleteAccountForm>['form']

// mode: 'onChange' validates asynchronously; act(async) lets isValid settle.
async function type(form: Form, value: string) {
    await act(async () => {
        form.setValue('confirm', value, { shouldValidate: true })
    })
}

describe('useDeleteAccountForm — content plan gating', () => {
    it('blocks submit until a content plan is chosen when peers exist', async () => {
        const { result } = renderHook(() => useDeleteAccountForm(noop), { wrapper: wrapper() })
        await waitFor(() => expect(result.current.peers).toHaveLength(1))

        await type(result.current.form, 'me@example.com')
        expect(result.current.form.getValues('plan')).toBeUndefined()
        expect(result.current.canSubmit).toBe(false)

        await act(async () => {
            await result.current.handleSubmit()
        })
        expect(h.send).not.toHaveBeenCalled()
        expect(result.current.form.getFieldState('plan').error?.message).toBe(
            'Choose what happens to your files, documents and comments'
        )
    })

    it('blocks submit while the typed email does not match', async () => {
        h.scenario = 'solo'
        const { result } = renderHook(() => useDeleteAccountForm(noop), { wrapper: wrapper() })

        await type(result.current.form, 'someone@example.com')
        expect(result.current.canSubmit).toBe(false)

        await act(async () => {
            await result.current.handleSubmit()
        })
        expect(h.send).not.toHaveBeenCalled()
    })

    it('submits exactly the chosen plan once one is picked', async () => {
        const { result } = renderHook(() => useDeleteAccountForm(noop), { wrapper: wrapper() })
        await waitFor(() => expect(result.current.peers).toHaveLength(1))

        await act(async () => {
            result.current.form.setValue('plan', { mode: 'delete_my_data' })
        })
        await type(result.current.form, ' ME@example.com ')
        expect(result.current.canSubmit).toBe(true)

        await act(async () => {
            await result.current.handleSubmit()
        })
        await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1))

        const [path, opts] = h.send.mock.calls[0] as unknown as [string, { body: string }]
        expect(path).toBe('/api/account/delete')
        expect(JSON.parse(opts.body)).toEqual({
            email: ' ME@example.com ',
            plan: { mode: 'delete_my_data' },
        })
    })

    it('with no peers the choice is moot: submit works and sends no plan', async () => {
        h.scenario = 'solo'
        const { result } = renderHook(() => useDeleteAccountForm(noop), { wrapper: wrapper() })

        await type(result.current.form, 'me@example.com')
        expect(result.current.peers).toHaveLength(0)
        expect(result.current.canSubmit).toBe(true)

        await act(async () => {
            await result.current.handleSubmit()
        })
        await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1))

        const [, opts] = h.send.mock.calls[0] as unknown as [string, { body: string }]
        expect(JSON.parse(opts.body)).toEqual({ email: 'me@example.com' })
    })

    it('shows a server failure as the form root error', async () => {
        h.scenario = 'solo'
        h.send.mockRejectedValueOnce(new Error('email confirmation does not match'))
        const { result } = renderHook(() => useDeleteAccountForm(noop), { wrapper: wrapper() })

        await type(result.current.form, 'me@example.com')
        await act(async () => {
            await result.current.handleSubmit()
        })
        await waitFor(() =>
            expect(result.current.form.formState.errors.root?.message).toBe(
                'email confirmation does not match'
            )
        )
        expect(h.logout).not.toHaveBeenCalled()
    })
})
