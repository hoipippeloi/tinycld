import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Menu } from '@tinycld/core/ui/menu'
import { ChevronDown } from 'lucide-react-native'
import { Pressable, Text } from 'react-native'

export interface PickItem {
    id: string
    label: string
    isSelected?: boolean
    onSelect: () => void
}

interface PickMenuProps {
    label: string
    /** Says what the menu picks, for a screen reader: "Condition field". */
    purpose: string
    items: PickItem[]
    testID: string
}

/** A chip that opens a short menu of choices; each row's test id is `${testID}-${id}`. */
export function PickMenu({ label, purpose, items, testID }: PickMenuProps) {
    const muted = useThemeColor('muted-foreground')
    const rows = items.map(item => (
        <Menu.Item
            key={item.id}
            label={item.label}
            isSelected={item.isSelected}
            onSelect={item.onSelect}
            testID={`${testID}-${item.id}`}
        />
    ))
    const trigger = (
        <Pressable
            className="flex-row items-center gap-1 border border-border rounded-md px-2 py-1"
            accessibilityLabel={`${purpose}: ${label}`}
            testID={testID}
        >
            <Text className="text-foreground text-sm">{label}</Text>
            <ChevronDown size={12} color={muted} />
        </Pressable>
    )
    return (
        <Menu presentation="popover" trigger={trigger}>
            {rows}
        </Menu>
    )
}
