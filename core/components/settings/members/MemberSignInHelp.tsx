import { HelpIcon } from '@tinycld/core/components/help/HelpIcon'
import { errorToString } from '@tinycld/core/lib/errors'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { ConfirmDialog } from '@tinycld/core/ui/ConfirmDialog'
import { Dialog } from '@tinycld/core/ui/dialog'
import { TextInput, useForm, zodResolver } from '@tinycld/core/ui/form'
import { useState } from 'react'
import { Text, View } from 'react-native'
import { resetEmailSchema, temporaryPasswordSchema } from './member-sign-in-schemas'
import { useMemberSignIn } from './use-member-sign-in'

type Props = {
    isVisible: boolean
    userId: string
    name: string
    email: string
}

type Open = 'password' | 'email' | 'mfa' | null

/**
 * For a member who cannot sign in: give them a temporary password (they
 * choose a new one at the next sign-in), email them a reset link at any
 * address, or remove their two-step verification. The server refuses an
 * admin who tries any of this on an owner.
 */
export function MemberSignInHelp({ isVisible, userId, name, email }: Props) {
    const help = useMemberSignIn(userId, name)
    const [open, setOpen] = useState<Open>(null)
    const close = () => setOpen(null)

    if (!isVisible) return null

    return (
        <View className="gap-2" testID="member-sign-in-help">
            <View className="flex-row items-center gap-2">
                <Text className="text-sm font-semibold text-foreground">Sign-in help</Text>
                <HelpIcon topic="core:member-sign-in-help" />
            </View>
            <Text className="text-xs text-muted-foreground" testID="member-mfa-status">
                {statusText(help.hasAuthenticator, help.passkeyCount)}
            </Text>
            <View className="flex-row flex-wrap gap-2">
                <Button
                    testID="member-set-password"
                    variant="outline"
                    size="sm"
                    onPress={() => setOpen('password')}
                >
                    <ButtonText>Set a temporary password</ButtonText>
                </Button>
                <Button
                    testID="member-send-reset"
                    variant="outline"
                    size="sm"
                    onPress={() => setOpen('email')}
                >
                    <ButtonText>Email a reset link</ButtonText>
                </Button>
                <ResetMfaButton isVisible={help.hasFactor} onPress={() => setOpen('mfa')} />
            </View>

            <Dialog
                isOpen={open === 'password'}
                onClose={close}
                title={`Temporary password for ${name}`}
            >
                <TemporaryPasswordForm
                    isVisible={open === 'password'}
                    onClose={close}
                    onSubmit={password => help.setPassword.mutateAsync(password).then(close)}
                />
            </Dialog>
            <Dialog isOpen={open === 'email'} onClose={close} title="Email a password reset link">
                <ResetEmailForm
                    isVisible={open === 'email'}
                    defaultEmail={email}
                    onClose={close}
                    onSubmit={to => help.sendReset.mutateAsync(to).then(close)}
                />
            </Dialog>
            <ConfirmDialog
                isOpen={open === 'mfa'}
                onClose={close}
                onConfirm={() => help.resetMfa.mutate(undefined, { onSuccess: close })}
                title="Reset two-step verification?"
                message={`This removes ${name}'s authenticator app, passkeys and app passwords. Confirm who is asking before you continue.`}
                confirmLabel="Reset"
                isDestructive
                isSubmitting={help.resetMfa.isPending}
            />
        </View>
    )
}

function statusText(hasAuthenticator: boolean, passkeyCount: number): string {
    const parts: string[] = []
    if (hasAuthenticator) parts.push('authenticator app')
    if (passkeyCount > 0) parts.push(passkeyCount === 1 ? '1 passkey' : `${passkeyCount} passkeys`)
    if (parts.length === 0) return 'Two-step verification is off.'
    return `Two-step verification is on: ${parts.join(' and ')}.`
}

function ResetMfaButton({ isVisible, onPress }: { isVisible: boolean; onPress: () => void }) {
    if (!isVisible) return null
    return (
        <Button testID="member-mfa-reset" variant="outline" size="sm" onPress={onPress}>
            <ButtonText>Reset two-step verification</ButtonText>
        </Button>
    )
}

type FormProps<T> = {
    isVisible: boolean
    onClose: () => void
    onSubmit: (value: T) => Promise<unknown>
}

// Mounted only while its dialog is open, so each open starts empty.
function TemporaryPasswordForm({ isVisible, ...props }: FormProps<string>) {
    if (!isVisible) return null
    return <TemporaryPasswordFields {...props} />
}

function TemporaryPasswordFields({ onClose, onSubmit }: Omit<FormProps<string>, 'isVisible'>) {
    const form = useForm({
        resolver: zodResolver(temporaryPasswordSchema),
        defaultValues: { password: '', passwordConfirm: '' },
    })
    const submit = form.handleSubmit(async ({ password }) => {
        try {
            await onSubmit(password)
        } catch (error) {
            form.setError('root', { type: 'server', message: errorToString(error) })
        }
    })
    const { isSubmitting, errors } = form.formState
    return (
        <>
            <Dialog.Body>
                <Text className="text-[13px] text-muted-foreground mb-3">
                    Give this password to them in person or by phone. At their next sign-in they
                    must choose a new one. Their other sessions end, and their app passwords stop
                    working.
                </Text>
                <TextInput
                    control={form.control}
                    name="password"
                    label="Temporary password"
                    testID="member-temp-password"
                    secureTextEntry
                    autoComplete="new-password"
                />
                <TextInput
                    control={form.control}
                    name="passwordConfirm"
                    label="Type it again"
                    testID="member-temp-password-confirm"
                    secureTextEntry
                    autoComplete="new-password"
                    onSubmitEditing={submit}
                />
                <FormError message={errors.root?.message} />
            </Dialog.Body>
            <Dialog.Footer>
                <Dialog.CancelButton onPress={onClose} isDisabled={isSubmitting} />
                <Dialog.ActionButton
                    label="Set password"
                    onPress={submit}
                    isDisabled={isSubmitting}
                    testID="member-temp-password-save"
                />
            </Dialog.Footer>
        </>
    )
}

function ResetEmailForm({
    isVisible,
    defaultEmail,
    ...props
}: FormProps<string> & { defaultEmail: string }) {
    if (!isVisible) return null
    return <ResetEmailFields defaultEmail={defaultEmail} {...props} />
}

function ResetEmailFields({
    defaultEmail,
    onClose,
    onSubmit,
}: Omit<FormProps<string>, 'isVisible'> & { defaultEmail: string }) {
    const form = useForm({
        resolver: zodResolver(resetEmailSchema),
        defaultValues: { email: defaultEmail },
    })
    const submit = form.handleSubmit(async ({ email }) => {
        try {
            await onSubmit(email)
        } catch (error) {
            form.setError('root', { type: 'server', message: errorToString(error) })
        }
    })
    const { isSubmitting, errors } = form.formState
    return (
        <>
            <Dialog.Body>
                <Text className="text-[13px] text-muted-foreground mb-3">
                    The link lets whoever opens it choose a new password, so send it only to an
                    address you confirmed with them. It expires in 30 minutes.
                </Text>
                <TextInput
                    control={form.control}
                    name="email"
                    label="Send to"
                    hint="Their recovery email, or another address they gave you"
                    testID="member-reset-email"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    onSubmitEditing={submit}
                />
                <FormError message={errors.root?.message} />
            </Dialog.Body>
            <Dialog.Footer>
                <Dialog.CancelButton onPress={onClose} isDisabled={isSubmitting} />
                <Dialog.ActionButton
                    label="Send link"
                    onPress={submit}
                    isDisabled={isSubmitting}
                    testID="member-reset-email-send"
                />
            </Dialog.Footer>
        </>
    )
}

function FormError({ message }: { message?: string }) {
    if (!message) return null
    return (
        <Text className="text-xs text-danger mt-1" accessibilityRole="alert">
            {message}
        </Text>
    )
}
