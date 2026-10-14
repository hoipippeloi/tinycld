import { DocumentTitle } from '@tinycld/core/components/DocumentTitle'
import { FormEditor } from '@tinycld/core/components/forms-builder/FormEditor'
import { useCurrentRole } from '@tinycld/core/lib/use-current-role'
import { useLocalSearchParams } from 'expo-router'
import { Text, View } from 'react-native'

function Body({
    formId,
    isAdmin,
    isReady,
}: {
    formId: string
    isAdmin: boolean
    isReady: boolean
}) {
    if (!isReady) return null
    if (!isAdmin)
        return (
            <View className="flex-1 bg-background p-5">
                <Text className="text-muted-foreground">
                    Only an owner or admin can manage forms.
                </Text>
            </View>
        )
    return <FormEditor formId={formId} />
}

export default function FormEditorRoute() {
    const { formId } = useLocalSearchParams<{ formId: string }>()
    const { isAdmin, isReady } = useCurrentRole()
    return (
        <View className="flex-1">
            <DocumentTitle pkg="Settings" title="Edit form" />
            <Body formId={formId} isAdmin={isAdmin} isReady={isReady} />
        </View>
    )
}
