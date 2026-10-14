import { errorToString } from '@tinycld/core/lib/errors'
import { resetUserMfa } from '@tinycld/core/lib/mfa'
import { useMutation } from '@tinycld/core/lib/mutations'
import { notify } from '@tinycld/core/lib/notify'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { ConfirmDialog } from '@tinycld/core/ui/ConfirmDialog'
import { useState } from 'react'
import { Text, View } from 'react-native'

type Props = {
    isVisible: boolean
    userId: string
    name: string
}

/**
 * For a member who lost their phone and their recovery codes: removes their
 * authenticator app and passkeys so they can sign in with the password and
 * set up a new one. The server refuses an admin who tries this on an owner.
 */
export function MemberMfaReset({ isVisible, userId, name }: Props) {
    const [isConfirming, setIsConfirming] = useState(false)
    const reset = useMutation({
        mutationFn: () => resetUserMfa(userId),
        onSuccess: () => {
            setIsConfirming(false)
            notify.emit({
                event: 'account.security_changed',
                title: `Two-step verification reset for ${name}`,
            })
        },
        onError: () => {},
    })

    if (!isVisible) return null

    return (
        <View className="gap-1.5">
            <Text className="text-sm font-semibold text-foreground">Two-step verification</Text>
            <Text className="text-xs text-muted-foreground">
                If {name} lost their phone and recovery codes, reset it so they can sign in with
                their password and set it up again.
            </Text>
            <Button
                testID="member-mfa-reset"
                variant="outline"
                className="self-start"
                onPress={() => setIsConfirming(true)}
            >
                <ButtonText>Reset two-step verification</ButtonText>
            </Button>
            <ResetError error={reset.error ? errorToString(reset.error) : null} />
            <ConfirmDialog
                isOpen={isConfirming}
                onClose={() => setIsConfirming(false)}
                onConfirm={() => reset.mutate()}
                title="Reset two-step verification?"
                message={`This removes ${name}'s authenticator app and passkeys. Confirm who is asking before you continue.`}
                confirmLabel="Reset"
                isDestructive
                isSubmitting={reset.isPending}
            />
        </View>
    )
}

function ResetError({ error }: { error: string | null }) {
    if (!error) return null
    return <Text className="text-xs text-danger">{error}</Text>
}
