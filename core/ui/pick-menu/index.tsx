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
    /** `touch` gives the chip a 44pt-tall target for primary form controls. */
    size?: 'compact' | 'touch'
}

/** A chip that opens a short menu of choices; each row's test id is `${testID}-${id}`. */
export function PickMenu({ label, purpose, items, testID, size = 'compact' }: PickMenuProps) {
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
            className={
                size === 'touch'
                    ? 'min-w-40 flex-row items-center justify-between gap-2 border border-border rounded-md px-3'
                    : 'flex-row items-center gap-1 border border-border rounded-md px-2 py-1'
            }
            style={size === 'touch' ? { minHeight: 44 } : undefined}
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
