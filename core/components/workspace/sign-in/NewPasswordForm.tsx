import { confirmPasswordReset } from '@tinycld/core/lib/account-password'
import { errorToString } from '@tinycld/core/lib/errors'
import { ButtonText, ServerActionButton } from '@tinycld/core/ui/button'
import { TextInput, useForm, zodResolver } from '@tinycld/core/ui/form'
import { Text, View } from 'react-native'
import { newPasswordSchema } from './mfa-schemas'

type Props = {
    /** The password-reset token the server sent instead of a session. */
    token: string
    /** Runs once the new password is saved. */
    onDone: () => void
}

/**
 * Replaces an admin-set temporary password. Used by the sign-in overlay and
 * by the browser-sheet page the mobile app opens for passkeys. The password
 * goes through PocketBase's standard confirm-password-reset route, which also
 * ends the temporary flag on the server.
 */
export function NewPasswordForm({ token, onDone }: Props) {
    const form = useForm({
        resolver: zodResolver(newPasswordSchema),
        defaultValues: { password: '', passwordConfirm: '' },
    })
    const submit = form.handleSubmit(async ({ password, passwordConfirm }) => {
        try {
            await confirmPasswordReset(token, password, passwordConfirm)
            onDone()
        } catch (error) {
            form.setError('root', { type: 'server', message: errorToString(error) })
        }
    })
    const { isSubmitting, errors } = form.formState

    return (
        <View className="w-full">
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
                <ButtonText>Save new password</ButtonText>
            </ServerActionButton>
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
