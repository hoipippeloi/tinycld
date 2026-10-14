import { RecoveryCodesPanel } from '@tinycld/core/components/settings/security/RecoveryCodesPanel'
import { TotpSetupPanel } from '@tinycld/core/components/settings/security/TotpSetupPanel'
import { PasskeySignInButton } from '@tinycld/core/components/workspace/sign-in/PasskeySignInButton'
import { useFinishSignIn } from '@tinycld/core/components/workspace/sign-in/use-finish-sign-in'
import { errorToString } from '@tinycld/core/lib/errors'
import { beginTotpSetup, confirmTotpEnrollment } from '@tinycld/core/lib/mfa'
import { useMutation } from '@tinycld/core/lib/mutations'
import { passkeys } from '@tinycld/core/lib/passkey'
import { defaultPasskeyName } from '@tinycld/core/lib/passkey-types'
import type { AuthResponse, SignInStep } from '@tinycld/core/lib/sign-in-step'
import { useSignInStepStore } from '@tinycld/core/lib/stores/sign-in-step-store'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'

type EnrollSignInStep = Extract<SignInStep, { kind: 'enroll' }>

// Required enrollment: the organization requires MFA and this account has no
// factor yet. Finishing the enrollment is what finishes the sign-in, so the
// session arrives with the confirmation. With an authenticator app, the
// recovery codes come with it and are shown before the session is adopted,
// because adopting it leaves this screen.
function useTotpEnrollment(enrollToken: string) {
    const finishSignIn = useFinishSignIn()
    const [session, setSession] = useState<AuthResponse | null>(null)
    const begin = useMutation({
        mutationFn: () => beginTotpSetup(enrollToken),
        onError: () => {},
    })
    const confirm = async (code: string) => {
        setSession(await confirmTotpEnrollment(enrollToken, code))
    }
    const finish = () => {
        if (session) finishSignIn(session)
    }
    return {
        start: () => begin.mutate(),
        isStarting: begin.isPending,
        startError: begin.error ? errorToString(begin.error) : null,
        setup: begin.data ?? null,
        confirm,
        recoveryCodes: session?.meta?.recoveryCodes ?? null,
        finish,
    }
}

export function EnrollStep({ step }: { step: EnrollSignInStep }) {
    const clearStep = useSignInStepStore(s => s.clear)
    const totp = useTotpEnrollment(step.token)

    return (
        <View testID="enroll-step">
            <Text className="text-[22px] font-bold mb-1 text-foreground">
                Set up two-step verification
            </Text>
            <Text className="text-sm mb-6 text-muted-foreground">
                Your organization requires a second step when you sign in. Set one up now to
                continue.
            </Text>

            <Choices
                isVisible={!totp.setup}
                isStarting={totp.isStarting}
                error={totp.startError}
                onTotp={totp.start}
                enrollToken={step.token}
            />
            <SetupPanel
                isVisible={!!totp.setup && !totp.recoveryCodes}
                setup={totp.setup}
                onConfirm={totp.confirm}
            />
            <CodesPanel codes={totp.recoveryCodes} onDone={totp.finish} />

            <Pressable
                testID="enroll-back"
                accessibilityRole="link"
                onPress={clearStep}
                className="mt-4 items-center"
            >
                <Text className="text-xs text-muted-foreground underline">Back to sign in</Text>
            </Pressable>
        </View>
    )
}

type ChoicesProps = {
    isVisible: boolean
    isStarting: boolean
    error: string | null
    onTotp: () => void
    enrollToken: string
}

function Choices({ isVisible, isStarting, error, onTotp, enrollToken }: ChoicesProps) {
    if (!isVisible) return null
    return (
        <View className="gap-3">
            <Button
                testID="enroll-totp"
                className="w-full"
                onPress={onTotp}
                isDisabled={isStarting}
            >
                <ButtonText>Use an authenticator app</ButtonText>
            </Button>
            <StartError error={error} />
            <PasskeySignInButton
                isVisible
                testID="enroll-passkey"
                label="Use a passkey"
                run={() => passkeys.enroll(enrollToken, defaultPasskeyName(Platform.OS))}
            />
        </View>
    )
}

function SetupPanel({
    isVisible,
    setup,
    onConfirm,
}: {
    isVisible: boolean
    setup: { secret: string; uri: string } | null
    onConfirm: (code: string) => Promise<void>
}) {
    if (!isVisible || !setup) return null
    return <TotpSetupPanel setup={setup} onConfirm={onConfirm} />
}

function CodesPanel({ codes, onDone }: { codes: string[] | null; onDone: () => void }) {
    if (!codes) return null
    return <RecoveryCodesPanel codes={codes} doneLabel="Continue" onDone={onDone} />
}

function StartError({ error }: { error: string | null }) {
    if (!error) return null
    return <Text className="text-xs text-danger">{error}</Text>
}
