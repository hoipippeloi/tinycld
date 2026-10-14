import { FormsHostList } from '@tinycld/core/components/forms-builder/FormsHostList'
import { FormsList } from '@tinycld/core/components/forms-builder/FormsList'
import { HelpIcon } from '@tinycld/core/components/help/HelpIcon'
import { SettingsScreen } from '@tinycld/core/components/settings/SettingsScreen'
import { useFormHosts } from '@tinycld/core/lib/forms/use-form-hosts'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { useCurrentRole } from '@tinycld/core/lib/use-current-role'
import { router, useLocalSearchParams } from 'expo-router'
import { Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

function AdminOnly({ isVisible }: { isVisible: boolean }) {
    if (!isVisible) return null
    return <Text className="text-muted-foreground">Only an owner or admin can manage forms.</Text>
}

interface BodyProps {
    isVisible: boolean
    hostKey?: string
    onPick: (hostKey: string) => void
    onOpen: (formId: string) => void
}

function Body({ isVisible, hostKey, onPick, onOpen }: BodyProps) {
    if (!isVisible) return null
    if (!hostKey) return <FormsHostList onPick={onPick} />
    return <FormsList hostKey={hostKey} onOpen={onOpen} />
}

export default function FormsSettingsRoute() {
    const { isAdmin, isReady } = useCurrentRole()
    const hosts = useFormHosts()
    const orgHref = useOrgHref()
    const params = useLocalSearchParams<{ host?: string }>()
    const hostKey = params.host ?? (hosts.length === 1 ? hosts[0].key : undefined)
    const open = (formId: string) => router.push(orgHref('settings/forms/[formId]', { formId }))
    const pick = (host: string) => router.push(orgHref('settings/forms', { host }))
    return (
        // FormsList's SortableList needs a GestureHandlerRootView ancestor.
        <GestureHandlerRootView className="flex-1">
            <SettingsScreen title="Forms">
                <View className="flex-row items-center gap-2">
                    <Text className="flex-1 text-muted-foreground">
                        Record types that packages let you customize.
                    </Text>
                    <HelpIcon topic="core:forms" />
                </View>
                <AdminOnly isVisible={isReady && !isAdmin} />
                <Body
                    isVisible={isReady && isAdmin}
                    hostKey={hostKey}
                    onPick={pick}
                    onOpen={open}
                />
            </SettingsScreen>
        </GestureHandlerRootView>
    )
}
