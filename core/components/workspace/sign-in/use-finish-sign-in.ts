import { takePendingRoute } from '@tinycld/core/lib/pending-route'
import type { AuthResponse } from '@tinycld/core/lib/sign-in-step'
import { useAuthStore } from '@tinycld/core/lib/stores/auth-store'
import { useSignInNoticeStore } from '@tinycld/core/lib/stores/sign-in-notice-store'
import { router } from 'expo-router'

/**
 * The end of every sign-in from the login overlay: adopt the session, drop
 * the notice that explained why sign-in was needed, and return to the route
 * the gate interrupted (replace, so the overlay is not a back destination).
 */
export function useFinishSignIn() {
    const adoptAuthResponse = useAuthStore(s => s.adoptAuthResponse)
    const clearNotice = useSignInNoticeStore(s => s.clear)

    return async (response: AuthResponse) => {
        const result = await adoptAuthResponse(response)
        if (!result.user) return
        clearNotice()
        router.replace(takePendingRoute() ?? '/')
    }
}
