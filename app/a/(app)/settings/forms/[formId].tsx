import { DocumentTitle } from '@tinycld/core/components/DocumentTitle'
import { FormEditor } from '@tinycld/core/components/forms-builder/FormEditor'
import { useLocalSearchParams } from 'expo-router'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

export default function FormEditorRoute() {
    const { formId } = useLocalSearchParams<{ formId: string }>()
    return (
        <GestureHandlerRootView className="flex-1">
            <DocumentTitle pkg="Settings" title="Edit form" />
            <FormEditor formId={formId} />
        </GestureHandlerRootView>
    )
}
