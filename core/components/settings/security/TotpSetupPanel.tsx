import { QrCode } from '@tinycld/core/components/settings/security/QrCode'
import { totpCodeSchema } from '@tinycld/core/components/workspace/sign-in/mfa-schemas'
import { errorToString } from '@tinycld/core/lib/errors'
import type { TotpSetup } from '@tinycld/core/lib/mfa'
import { ButtonText, ServerActionButton } from '@tinycld/core/ui/button'
import { TextInput, useForm, zodResolver } from '@tinycld/core/ui/form'
import { Text, View } from 'react-native'

type Props = {
    setup: Pick<TotpSetup, 'secret' | 'uri'>
    /** Sends the first code to the server; a rejection shows on the form. */
    onConfirm: (code: string) => Promise<void>
}

// The secret in groups of four, which is how authenticator apps ask for it
// when the user types it in instead of scanning.
function groupSecret(secret: string): string {
    return secret.replace(/(.{4})/g, '$1 ').trim()
}

function useConfirmForm(onConfirm: Props['onConfirm']) {
    const form = useForm({ resolver: zodResolver(totpCodeSchema), defaultValues: { code: '' } })
    const submit = form.handleSubmit(async ({ code }) => {
        try {
            await onConfirm(code)
        } catch (error) {
            form.setError('root', { type: 'server', message: errorToString(error) })
        }
    })
    return { form, submit }
}

/** Scan or type the secret, then prove it works with one code. */
export function TotpSetupPanel({ setup, onConfirm }: Props) {
    const { form, submit } = useConfirmForm(onConfirm)
    const { isSubmitting, errors } = form.formState

    return (
        <View className="gap-3" testID="totp-setup">
            <Text className="text-[13px] text-muted-foreground">
                1. Scan this code with an authenticator app, such as Google Authenticator, 1Password
                or Authy.
            </Text>
            <QrCode value={setup.uri} />
            <Text className="text-[13px] text-muted-foreground">
                If you cannot scan it, type this key into the app:
            </Text>
            <Text
                selectable
                testID="totp-secret"
                className="font-mono text-sm text-foreground text-center"
            >
                {groupSecret(setup.secret)}
            </Text>
            <Text className="text-[13px] text-muted-foreground">
                2. Type the 6-digit code the app shows.
            </Text>
            <ConfirmError message={errors.root?.message} />
            <TextInput
                control={form.control}
                name="code"
                label="Code"
                testID="totp-confirm-code"
                keyboardType="number-pad"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                maxLength={7}
                onSubmitEditing={submit}
            />
            <ServerActionButton testID="totp-confirm" onPress={submit} isDisabled={isSubmitting}>
                <ButtonText>Turn on</ButtonText>
            </ServerActionButton>
        </View>
    )
}

function ConfirmError({ message }: { message?: string }) {
    if (!message) return null
    return <Text className="text-sm text-danger">{message}</Text>
}
