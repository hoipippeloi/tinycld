import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { setTemporaryPassword } from '@tinycld/core/lib/account-password'
import { sendPasswordResetFor } from '@tinycld/core/lib/mfa'
import { mutation, useMutation } from '@tinycld/core/lib/mutations'
import { notify } from '@tinycld/core/lib/notify'
import { useStore } from '@tinycld/core/lib/pocketbase'

// An owner or admin helping a member who lost their password or second
// factor. The collection rules let them read and delete another member's
// factor rows (never their own, and an admin never an owner's).
function useMemberFactorRows(userId: string) {
    const [totp, passkeys, appPasswords] = useStore('mfa_totp', 'passkeys', 'app_passwords')
    const { data: totpRows = [] } = useLiveQuery({
        query: query =>
            query
                .from({ t: totp })
                .where(({ t }) => eq(t.user, userId))
                .select(({ t }) => ({ id: t.id, enabledAt: t.enabled_at })),
    })
    const { data: passkeyRows = [] } = useLiveQuery({
        query: query =>
            query
                .from({ p: passkeys })
                .where(({ p }) => eq(p.user, userId))
                .select(({ p }) => ({ id: p.id })),
    })
    const { data: appPasswordRows = [] } = useLiveQuery({
        query: query =>
            query
                .from({ a: appPasswords })
                .where(({ a }) => eq(a.user, userId))
                .select(({ a }) => ({ id: a.id })),
    })
    return { totp, passkeys, appPasswords, totpRows, passkeyRows, appPasswordRows }
}

export function useMemberSignIn(userId: string, name: string) {
    const rows = useMemberFactorRows(userId)
    const hasAuthenticator = rows.totpRows.some(r => !!r.enabledAt)
    const passkeyCount = rows.passkeyRows.length

    // Removes the authenticator app, passkeys and app passwords: whoever holds
    // the account now must set up fresh ones.
    const resetMfa = useMutation({
        mutationFn: mutation(function* () {
            yield [
                ...rows.totpRows.map(r => rows.totp.delete(r.id)),
                ...rows.passkeyRows.map(r => rows.passkeys.delete(r.id)),
                ...rows.appPasswordRows.map(r => rows.appPasswords.delete(r.id)),
            ]
        }),
        onSuccess: () =>
            notify.emit({
                event: 'account.security_changed',
                title: `Two-step verification reset for ${name}`,
            }),
    })

    const setPassword = useMutation({
        mutationFn: (password: string) => setTemporaryPassword(userId, password),
        onSuccess: () =>
            notify.emit({
                event: 'account.security_changed',
                title: `Temporary password set. ${name} chooses a new one at the next sign-in.`,
            }),
        onError: () => {},
    })

    const sendReset = useMutation({
        mutationFn: (email: string) => sendPasswordResetFor(userId, email),
        onSuccess: ({ sentTo }) =>
            notify.emit({
                event: 'account.security_changed',
                title: `Reset link sent to ${sentTo}`,
            }),
        onError: () => {},
    })

    return {
        hasAuthenticator,
        passkeyCount,
        hasFactor: hasAuthenticator || passkeyCount > 0 || rows.totpRows.length > 0,
        resetMfa,
        setPassword,
        sendReset,
    }
}
