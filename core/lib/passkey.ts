import { openNativeAuthSheet, signInThroughSheet } from '@tinycld/core/lib/native-auth'
import type { PasskeyApi } from '@tinycld/core/lib/passkey-types'
import { pb } from '@tinycld/core/lib/pocketbase'

// Native: every ceremony runs in the system browser sheet on the server's web
// origin (see PasskeyApi for why). A passkey alone is a full sign-in, so the
// second step after a password is the same sheet sign-in as signIn.
export const passkeys: PasskeyApi = {
    isAvailable: () => true,
    signIn: () => signInThroughSheet({ mode: 'login' }),
    secondStep: () => signInThroughSheet({ mode: 'login' }),
    add: async name => {
        const { ticket } = await pb.send<{ ticket: string }>('/api/auth/native/ticket', {
            method: 'POST',
        })
        await openNativeAuthSheet({ mode: 'register', ticket, name })
    },
    enroll: (enrollToken, name) =>
        signInThroughSheet({ mode: 'enroll', enroll_token: enrollToken, name }),
}
