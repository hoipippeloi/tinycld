import { DocumentTitle } from '@tinycld/core/components/DocumentTitle'
import {
    callbackUrl,
    fragmentParams,
    type NativeAuthRequest,
    parseNativeAuthRequest,
} from '@tinycld/core/components/native-auth/native-auth-params'
import { errorToString } from '@tinycld/core/lib/errors'
import { useMutation } from '@tinycld/core/lib/mutations'
import { passkeys, registerPasskey } from '@tinycld/core/lib/passkey.web'
import { pb } from '@tinycld/core/lib/pocketbase'
import type { AuthResponse } from '@tinycld/core/lib/sign-in-step'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { ButtonText, ServerActionButton } from '@tinycld/core/ui/button'
import { KeyRound } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'

// The page the native app opens in the system browser sheet to run a passkey
// ceremony on this server's own origin. It never keeps a session in this
// browser: a sign-in's session is traded at once for a one-time code, bound to
// the app's PKCE challenge, and the code goes back to the app in the redirect.

async function mintCode(session: AuthResponse, codeChallenge: string): Promise<string> {
    const { code } = await pb.send<{ code: string }>('/api/auth/native/code', {
        method: 'POST',
        headers: { Authorization: session.token },
        body: { codeChallenge },
    })
    return code
}

async function runRequest(request: NativeAuthRequest): Promise<string> {
    switch (request.mode) {
        case 'login': {
            const session = await passkeys.signIn()
            return callbackUrl({ code: await mintCode(session, request.codeChallenge) })
        }
        case 'enroll': {
            const session = await passkeys.enroll(request.enrollToken, request.name)
            return callbackUrl({ code: await mintCode(session, request.codeChallenge) })
        }
        case 'register':
            await registerPasskey(request.name, { ticket: request.ticket })
            return callbackUrl({ registered: '1' })
    }
}

const TITLES: Record<NativeAuthRequest['mode'], string> = {
    login: 'Sign in with a passkey',
    enroll: 'Set up a passkey',
    register: 'Add a passkey',
}

function useNativeAuth() {
    const request = parseNativeAuthRequest(fragmentParams(window.location.hash))
    const run = useMutation({
        mutationFn: async () => {
            if (!request) throw new Error('This link is not valid.')
            window.location.href = await runRequest(request)
        },
        // The error shows on the page; the default toast would repeat it.
        onError: () => {},
    })
    return {
        request,
        start: () => run.mutate(),
        isWorking: run.isPending || run.isSuccess,
        error: run.error ? errorToString(run.error, 'The passkey did not work. Try again.') : null,
        cancelHref: callbackUrl({ error: 'cancelled' }),
    }
}

export function NativeAuthScreen() {
    const fgColor = useThemeColor('foreground')
    const { request, start, isWorking, error, cancelHref } = useNativeAuth()

    if (!request) {
        return (
            <Page title="Link not valid">
                <Text className="text-center text-sm text-muted-foreground">
                    Start again from the TinyCld app.
                </Text>
            </Page>
        )
    }

    return (
        <Page title={TITLES[request.mode]}>
            <View className="size-10 rounded-lg items-center justify-center bg-surface">
                <KeyRound size={18} color={fgColor} />
            </View>
            <Text className="text-center text-sm text-muted-foreground">
                Your device asks you to confirm with your fingerprint, face or screen lock.
            </Text>
            <ErrorText error={error} />
            <ServerActionButton
                testID="native-auth-continue"
                onPress={start}
                isDisabled={isWorking}
            >
                <ButtonText>Continue</ButtonText>
            </ServerActionButton>
            <Pressable
                accessibilityRole="link"
                onPress={() => {
                    window.location.href = cancelHref
                }}
            >
                <Text className="text-xs text-muted-foreground underline">Back to the app</Text>
            </Pressable>
        </Page>
    )
}

function Page({ title, children }: { title: string; children: ReactNode }) {
    return (
        <View className="flex-1 items-center justify-center p-5 bg-background">
            <DocumentTitle title={title} includeOrg={false} />
            <View
                className="gap-4 p-6 rounded-xl border border-border items-center bg-surface-secondary"
                style={{ maxWidth: 400, width: '100%' }}
            >
                <Text className="text-lg font-semibold text-foreground">{title}</Text>
                {children}
            </View>
        </View>
    )
}

function ErrorText({ error }: { error: string | null }) {
    if (!error) return null
    return <Text className="text-center text-sm text-danger">{error}</Text>
}
