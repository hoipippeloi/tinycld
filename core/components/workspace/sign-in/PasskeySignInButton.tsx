import { useFinishSignIn } from '@tinycld/core/components/workspace/sign-in/use-finish-sign-in'
import { errorToString } from '@tinycld/core/lib/errors'
import { useMutation } from '@tinycld/core/lib/mutations'
import { NativeAuthCancelled } from '@tinycld/core/lib/native-auth-errors'
import { passkeys } from '@tinycld/core/lib/passkey'
import type { AuthResponse } from '@tinycld/core/lib/sign-in-step'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { Text, View } from 'react-native'

type Props = {
    isVisible: boolean
    label: string
    testID: string
    /** Runs the passkey ceremony; resolves to the session. */
    run: () => Promise<AuthResponse>
}

function isCancel(error: unknown): boolean {
    // The user closed the browser sheet, or dismissed the browser's passkey
    // prompt: not an error worth showing.
    if (error instanceof NativeAuthCancelled) return true
    return error instanceof Error && error.name === 'NotAllowedError'
}

export function PasskeySignInButton({ isVisible, label, testID, run }: Props) {
    const finishSignIn = useFinishSignIn()
    const signIn = useMutation({
        mutationFn: async () => finishSignIn(await run()),
        // Shown below the button; the default toast would repeat it.
        onError: () => {},
    })

    if (!isVisible || !passkeys.isAvailable()) return null

    const error = signIn.error && !isCancel(signIn.error) ? errorToString(signIn.error) : null

    return (
        <View className="gap-2">
            <Button
                testID={testID}
                variant="outline"
                className="w-full"
                onPress={() => signIn.mutate()}
                isDisabled={signIn.isPending}
            >
                <ButtonText>{label}</ButtonText>
            </Button>
            <PasskeyError error={error} />
        </View>
    )
}

function PasskeyError({ error }: { error: string | null }) {
    if (!error) return null
    return <Text className="text-xs text-danger">{error}</Text>
}
