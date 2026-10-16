import { useSystemSettings } from '@tinycld/core/components/setup/system-settings-store'
import { Switch } from '@tinycld/core/ui/switch'
import { Text, View } from 'react-native'

// Must match RequireMFAKey in core/server/mfa/gate.go.
const REQUIRE_MFA_KEY = 'auth.require_mfa'

function useRequireMfa() {
    const { byKey, upsert, isReady } = useSystemSettings('auth')
    return {
        isReady,
        isOn: byKey.get(REQUIRE_MFA_KEY)?.value === 'true',
        setOn: (on: boolean) =>
            upsert.mutate({ key: REQUIRE_MFA_KEY, value: on ? 'true' : 'false', isSecret: false }),
        isSaving: upsert.isPending,
    }
}

export function RequireMfaSection() {
    const setting = useRequireMfa()

    return (
        <View
            className="rounded-xl border border-border bg-surface-secondary p-4 gap-2"
            testID="require-mfa"
        >
            <View className="flex-row items-center justify-between gap-4">
                <Text className="flex-1 text-base font-semibold text-foreground">
                    Require two-step verification
                </Text>
                <Switch
                    testID="require-mfa-switch"
                    value={setting.isOn}
                    onValueChange={setting.setOn}
                    isDisabled={!setting.isReady || setting.isSaving}
                />
            </View>
            <Text className="text-[13px] text-muted-foreground">
                Everyone must set up an authenticator app or a passkey. A member without one sets it
                up at their next sign-in. People who are signed in now stay signed in.
            </Text>
        </View>
    )
}
