import { confirmPasswordReset } from '@tinycld/core/lib/account-password'
import { errorToString } from '@tinycld/core/lib/errors'
import type { SignInStep } from '@tinycld/core/lib/sign-in-step'
import { useSignInNoticeStore } from '@tinycld/core/lib/stores/sign-in-notice-store'
import { useSignInStepStore } from '@tinycld/core/lib/stores/sign-in-step-store'
import { ButtonText, ServerActionButton } from '@tinycld/core/ui/button'
import { TextInput, useForm, zodResolver } from '@tinycld/core/ui/form'
import { Pressable, Text, View } from 'react-native'
import { newPasswordSchema } from './mfa-schemas'

type PasswordSignInStep = Extract<SignInStep, { kind: 'password' }>

// After an admin-set temporary password. The new password goes through the
// standard confirm-password-reset route with the token the server issued,
// then the member signs in with it; with MFA on, that asks for a code again,
// which is the server's check, not the client's.
function useNewPasswordForm(token: string) {
    const clearStep = useSignInStepStore(s => s.clear)
    const setNotice = useSignInNoticeStore(s => s.setNotice)
    const form = useForm({
        resolver: zodResolver(newPasswordSchema),
        defaultValues: { password: '', passwordConfirm: '' },
    })
    const submit = form.handleSubmit(async ({ password, passwordConfirm }) => {
        try {
            await confirmPasswordReset(token, password, passwordConfirm)
            setNotice('Your new password is set. Sign in with it.')
            clearStep()
        } catch (error) {
            form.setError('root', { type: 'server', message: errorToString(error) })
        }
    })
    return { form, submit }
}

export function PasswordStep({ step }: { step: PasswordSignInStep }) {
    const clearStep = useSignInStepStore(s => s.clear)
    const { form, submit } = useNewPasswordForm(step.token)
    const { isSubmitting, errors } = form.formState

    return (
        <View testID="password-step">
            <Text className="text-[22px] font-bold mb-1 text-foreground">
                Choose a new password
            </Text>
            <Text className="text-sm mb-6 text-muted-foreground">
                An administrator gave you a temporary password. Choose your own to continue.
            </Text>
            <RootError message={errors.root?.message} />
            <TextInput
                control={form.control}
                name="password"
                label="New password"
                hint="At least 8 characters"
                testID="new-password"
                secureTextEntry
                autoComplete="new-password"
                textContentType="newPassword"
                autoFocus
            />
            <TextInput
                control={form.control}
                name="passwordConfirm"
                label="Type it again"
                testID="new-password-confirm"
                secureTextEntry
                autoComplete="new-password"
                textContentType="newPassword"
                onSubmitEditing={submit}
            />
            <ServerActionButton
                testID="new-password-submit"
                className="w-full"
                onPress={submit}
                isDisabled={isSubmitting}
            >
                <ButtonText>Save and sign in</ButtonText>
            </ServerActionButton>
            <Pressable accessibilityRole="link" onPress={clearStep} className="mt-4 items-center">
                <Text className="text-xs text-muted-foreground underline">Back to sign in</Text>
            </Pressable>
        </View>
    )
}

function RootError({ message }: { message?: string }) {
    if (!message) return null
    return (
        <View className="rounded-lg p-3 mb-4 bg-danger-soft" testID="password-step-error">
            <Text className="text-sm text-danger">{message}</Text>
        </View>
    )
}
