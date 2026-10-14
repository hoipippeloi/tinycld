import { SettingsScreen } from '@tinycld/core/components/settings/SettingsScreen'
import { useLocalSearchParams } from 'expo-router'
import { Text } from 'react-native'

export default function FormEditorRoute() {
    const { formId } = useLocalSearchParams<{ formId: string }>()
    return (
        <SettingsScreen title="Edit form">
            <Text className="text-muted-foreground">{formId}</Text>
        </SettingsScreen>
    )
}
