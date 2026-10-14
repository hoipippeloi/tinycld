import { Text, View } from 'react-native'

// The native app opens this page in the system browser sheet, never in
// itself, so inside the app there is nothing to do here.
export function NativeAuthScreen() {
    return (
        <View className="flex-1 items-center justify-center p-5 bg-background">
            <Text className="text-sm text-muted-foreground">Open this page in a browser.</Text>
        </View>
    )
}
