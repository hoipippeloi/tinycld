import { HelpIcon } from '@tinycld/core/components/help/HelpIcon'
import { SettingsScreen } from '@tinycld/core/components/settings/SettingsScreen'
import { AppPasswordsSection } from '@tinycld/core/components/settings/security/AppPasswordsSection'
import { ChangePasswordSection } from '@tinycld/core/components/settings/security/ChangePasswordSection'
import { PasskeysSection } from '@tinycld/core/components/settings/security/PasskeysSection'
import { TotpSection } from '@tinycld/core/components/settings/security/TotpSection'
import { Text, View } from 'react-native'

export default function SecuritySettings() {
    return (
        <SettingsScreen title="Security">
            <View className="flex-row items-center gap-2">
                <Text className="text-[13px] text-muted-foreground">
                    How two-step verification, passkeys and app passwords work
                </Text>
                <HelpIcon topic="core:security-mfa" />
            </View>
            <ChangePasswordSection />
            <TotpSection />
            <PasskeysSection />
            <AppPasswordsSection />
        </SettingsScreen>
    )
}
