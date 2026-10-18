import { useNavigation } from 'expo-router'
import { type NavigationAction, usePreventRemove } from 'expo-router/react-navigation'
import { useEffect, useState } from 'react'
import { Platform } from 'react-native'

/**
 * Asks before a dirty editor is left. Every in-app way out (the header's Back,
 * hardware back, a swipe) removes the screen, which `usePreventRemove` holds
 * back until the user picks Discard. A browser reload or tab close is not an
 * in-app navigation, so web also asks through `beforeunload`.
 */
export function useLeaveGuard(isDirty: boolean) {
    const navigation = useNavigation()
    // The navigation held back while the Discard confirm is open: local UI state.
    const [held, setHeld] = useState<NavigationAction | null>(null)
    usePreventRemove(isDirty, ({ data }) => setHeld(data.action))
    useBeforeUnload(isDirty)
    const discard = () => {
        if (!held) return
        setHeld(null)
        navigation.dispatch(held)
    }
    return { isConfirming: held !== null, cancel: () => setHeld(null), discard }
}

/** The one effect here subscribes to a browser event, which only exists outside React. */
function useBeforeUnload(isDirty: boolean) {
    useEffect(() => {
        if (Platform.OS !== 'web' || !isDirty) return
        const ask = (event: BeforeUnloadEvent) => {
            event.preventDefault()
        }
        window.addEventListener('beforeunload', ask)
        return () => window.removeEventListener('beforeunload', ask)
    }, [isDirty])
}
