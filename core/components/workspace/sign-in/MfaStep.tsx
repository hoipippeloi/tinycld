import {
    recoveryCodeSchema,
    totpCodeSchema,
} from '@tinycld/core/components/workspace/sign-in/mfa-schemas'
import { PasskeySignInButton } from '@tinycld/core/components/workspace/sign-in/PasskeySignInButton'
import { useFinishSignIn } from '@tinycld/core/components/workspace/sign-in/use-finish-sign-in'
import { errorToString } from '@tinycld/core/lib/errors'
import { verifyMfa } from '@tinycld/core/lib/mfa'
import { passkeys } from '@tinycld/core/lib/passkey'
import type { SignInStep } from '@tinycld/core/lib/sign-in-step'
import { advanceSignInStep, useSignInStepStore } from '@tinycld/core/lib/stores/sign-in-step-store'
import { ButtonText, ServerActionButton } from '@tinycld/core/ui/button'
import { TextInput, useForm, zodResolver } from '@tinycld/core/ui/form'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

type MfaSignInStep = Extract<SignInStep, { kind: 'mfa' }>

function useTotpForm(mfaToken: string) {
    const finishSignIn = useFinishSignIn()
    const form = useForm({ resolver: zodResolver(totpCodeSchema), defaultValues: { code: '' } })
    const submit = () =>
        void form.handleSubmit(async ({ code }) => {
            try {
                await finishSignIn(await verifyMfa(mfaToken, { code }))
            } catch (error) {
                if (advanceSignInStep(error)) return
                form.setError('root', { type: 'server', message: errorToString(error) })
            }
        })()
    return { form, submit }
}

function useRecoveryForm(mfaToken: string) {
    const finishSignIn = useFinishSignIn()
    const form = useForm({
        resolver: zodResolver(recoveryCodeSchema),
        defaultValues: { recoveryCode: '' },
    })
    const submit = () =>
        void form.handleSubmit(async ({ recoveryCode }) => {
            try {
                await finishSignIn(await verifyMfa(mfaToken, { recoveryCode }))
            } catch (error) {
                if (advanceSignInStep(error)) return
                form.setError('root', { type: 'server', message: errorToString(error) })
            }
        })()
    return { form, submit }
}

export function MfaStep({ step }: { step: MfaSignInStep }) {
    const clearStep = useSignInStepStore(s => s.clear)
    const [isRecovery, setIsRecovery] = useState(false)
    const hasTotp = step.methods.includes('totp')
    const hasRecovery = step.methods.includes('recovery')
    const hasPasskey = step.methods.includes('passkey')

    return (
        <View testID="mfa-step">
            <Text className="text-[22px] font-bold mb-1 text-foreground">
                Two-step verification
            </Text>
            <Text className="text-sm mb-6 text-muted-foreground">
                Your password is correct. Confirm it is you to finish signing in.
            </Text>

            <TotpForm isVisible={hasTotp && !isRecovery} mfaToken={step.token} />
            <RecoveryForm isVisible={isRecovery} mfaToken={step.token} />

            <SwitchLink
                isVisible={hasRecovery}
                label={isRecovery ? 'Use the authenticator app' : 'Use a recovery code'}
                onPress={() => setIsRecovery(!isRecovery)}
            />

            <View className="mt-4">
                <PasskeySignInButton
                    isVisible={hasPasskey}
                    testID="mfa-passkey"
                    label="Use a passkey"
                    run={() => passkeys.secondStep(step.token)}
                />
            </View>

            <Pressable
                testID="mfa-back"
                accessibilityRole="link"
                onPress={clearStep}
                className="mt-4 items-center"
            >
                <Text className="text-xs text-muted-foreground underline">Back to sign in</Text>
            </Pressable>
        </View>
    )
}

function TotpForm({ isVisible, mfaToken }: { isVisible: boolean; mfaToken: string }) {
    const { form, submit } = useTotpForm(mfaToken)
    if (!isVisible) return null
    const { isSubmitting, errors } = form.formState
    return (
        <View>
            <RootError message={errors.root?.message} />
            <TextInput
                control={form.control}
                name="code"
                label="Code from your authenticator app"
                testID="mfa-code"
                keyboardType="number-pad"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                autoFocus
                maxLength={7}
                onSubmitEditing={submit}
            />
            <ServerActionButton
                testID="mfa-submit"
                className="w-full"
                onPress={submit}
                isDisabled={isSubmitting}
            >
                <ButtonText>Verify</ButtonText>
            </ServerActionButton>
        </View>
    )
}

function RecoveryForm({ isVisible, mfaToken }: { isVisible: boolean; mfaToken: string }) {
    const { form, submit } = useRecoveryForm(mfaToken)
    if (!isVisible) return null
    const { isSubmitting, errors } = form.formState
    return (
        <View>
            <RootError message={errors.root?.message} />
            <TextInput
                control={form.control}
                name="recoveryCode"
                label="Recovery code"
                hint="Each recovery code works one time."
                testID="mfa-recovery-code"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                onSubmitEditing={submit}
            />
            <ServerActionButton
                testID="mfa-recovery-submit"
                className="w-full"
                onPress={submit}
                isDisabled={isSubmitting}
            >
                <ButtonText>Verify</ButtonText>
            </ServerActionButton>
        </View>
    )
}

function SwitchLink({
    isVisible,
    label,
    onPress,
}: {
    isVisible: boolean
    label: string
    onPress: () => void
}) {
    if (!isVisible) return null
    return (
        <Pressable
            testID="mfa-switch"
            accessibilityRole="link"
            onPress={onPress}
            className="mt-3 items-center"
        >
            <Text className="text-xs text-muted-foreground underline">{label}</Text>
        </Pressable>
    )
}

function RootError({ message }: { message?: string }) {
    if (!message) return null
    return (
        <View className="rounded-lg p-3 mb-4 bg-danger-soft" testID="mfa-error">
            <Text className="text-sm text-danger">{message}</Text>
        </View>
    )
}
