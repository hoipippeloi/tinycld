import { router } from 'expo-router'
import { useEffect } from 'react'

// On Android the browser sheet's redirect to tinycld://auth/callback also
// reaches the router as a deep link (+native-intent maps it here), while the
// sheet's own promise already holds the result. Step back to where the user
// was; there is nothing to show.
export default function NativeAuthCallback() {
    useEffect(() => {
        if (router.canGoBack()) router.back()
        else router.replace('/')
    }, [])
    return null
}
