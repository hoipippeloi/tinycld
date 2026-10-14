import { useFormHosts } from '@tinycld/core/lib/forms/use-form-hosts'
import { usePackages } from '@tinycld/core/lib/packages/use-packages'
import { Pressable, Text, View } from 'react-native'

export interface FormsHostListProps {
    onPick: (hostKey: string) => void
}

export function FormsHostList({ onPick }: FormsHostListProps) {
    const hosts = useFormHosts()
    const packages = usePackages()
    const nameOf = (slug: string) => packages.find(p => p.slug === slug)?.name ?? slug
    return (
        <View>
            {hosts.map(h => (
                <Pressable
                    key={h.key}
                    onPress={() => onPick(h.key)}
                    className="py-3 border-b border-border"
                    accessibilityRole="button"
                    testID={`forms-host-${h.key}`}
                >
                    <Text className="text-foreground">{h.label}</Text>
                    <Text className="text-xs text-muted-foreground">{nameOf(h.pkgSlug)}</Text>
                </Pressable>
            ))}
        </View>
    )
}
