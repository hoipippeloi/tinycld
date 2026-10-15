import { SettingsScreen } from '@tinycld/core/components/settings/SettingsScreen'
import { RequireMfaSection } from '@tinycld/core/components/settings/security/RequireMfaSection'

export default function SignInSecuritySettings() {
    return (
        <SettingsScreen title="Sign-in security">
            <RequireMfaSection />
        </SettingsScreen>
    )
}
