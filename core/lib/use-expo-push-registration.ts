import { useAuth } from '@tinycld/core/lib/auth'
import { registerExpoPushToken } from '@tinycld/core/lib/expo-push'
import {
    isExpoPushRegistered,
    markExpoPushRegistered,
} from '@tinycld/core/lib/expo-push-registration-state'
import { useEffect } from 'react'
import { Platform } from 'react-native'

export { resetExpoPushRegistration } from '@tinycld/core/lib/expo-push-registration-state'

export function useExpoPushRegistration() {
    // throwIfAnon: false is required, not optional. useAuth() defaults to
    // throwIfAnon: true, which throws AuthRequiredError during RENDER for a
    // signed-out visitor — the effect's `user?.id` guard never gets a chance to
    // run. Mounted in the org layout (which renders before the auth gate), a
    // bare useAuth() crashed the whole layout into the error boundary, so a
    // signed-out deep link showed "Something went wrong" instead of the login
    // form. Registration is a signed-in side effect; absence of a user is a
    // normal state here, not an error.
    const { user } = useAuth({ throwIfAnon: false })

    useEffect(() => {
        if (Platform.OS === 'web' || isExpoPushRegistered() || !user?.id) return
        markExpoPushRegistered()
        registerExpoPushToken(user.id)
    }, [user?.id])
}
