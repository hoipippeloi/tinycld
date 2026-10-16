import type { SignInStep } from '@tinycld/core/lib/sign-in-step'
import { useSignInNoticeStore } from '@tinycld/core/lib/stores/sign-in-notice-store'
import { useSignInStepStore } from '@tinycld/core/lib/stores/sign-in-step-store'
import { Pressable, Text, View } from 'react-native'
import { NewPasswordForm } from './NewPasswordForm'

type PasswordSignInStep = Extract<SignInStep, { kind: 'password' }>

// After an admin-set temporary password: choose a new one, then sign in with
// it. With MFA on, that sign-in asks for a code again, which is the server's
// check, not the client's.
export function PasswordStep({ step }: { step: PasswordSignInStep }) {
    const clearStep = useSignInStepStore(s => s.clear)
    const setNotice = useSignInNoticeStore(s => s.setNotice)
    const done = () => {
        setNotice(PASSWORD_SET_NOTICE)
        clearStep()
    }

    return (
        <View testID="password-step">
            <Text className="text-[22px] font-bold mb-1 text-foreground">
                Choose a new password
            </Text>
            <Text className="text-sm mb-6 text-muted-foreground">
                An administrator gave you a temporary password. Choose your own to continue.
            </Text>
            <NewPasswordForm token={step.token} onDone={done} />
            <Pressable accessibilityRole="link" onPress={clearStep} className="mt-4 items-center">
                <Text className="text-xs text-muted-foreground underline">Back to sign in</Text>
            </Pressable>
        </View>
    )
}

export const PASSWORD_SET_NOTICE = 'Your new password is set. Sign in with it.'
