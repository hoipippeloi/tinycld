import type { CustomKind } from '@tinycld/core/lib/forms/definition'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { Menu } from '@tinycld/core/ui/menu'

interface KindGroup {
    label: string
    kinds: { kind: CustomKind; label: string }[]
}

const GROUPS: KindGroup[] = [
    {
        label: 'Text',
        kinds: [
            { kind: 'text', label: 'Text' },
            { kind: 'textarea', label: 'Long text' },
            { kind: 'markdown', label: 'Markdown' },
            { kind: 'richtext', label: 'Rich text' },
        ],
    },
    {
        label: 'Choices',
        kinds: [
            { kind: 'select', label: 'Choice list' },
            { kind: 'toggle', label: 'Toggle' },
        ],
    },
    { label: 'People', kinds: [{ kind: 'user', label: 'Person' }] },
    {
        label: 'Other',
        kinds: [
            { kind: 'number', label: 'Number' },
            { kind: 'date', label: 'Date' },
            { kind: 'checklist', label: 'Checklist' },
            { kind: 'file', label: 'File' },
        ],
    },
]

export interface KindPickerProps {
    onPick: (kind: CustomKind) => void
    testID?: string
}

function KindSection({ group, onPick }: { group: KindGroup; onPick: KindPickerProps['onPick'] }) {
    return (
        <Menu.Section label={group.label}>
            {group.kinds.map(k => (
                <Menu.Item
                    key={k.kind}
                    label={k.label}
                    onSelect={() => onPick(k.kind)}
                    testID={`form-kind-${k.kind}`}
                />
            ))}
        </Menu.Section>
    )
}

export function KindPicker({ onPick, testID = 'form-add-field' }: KindPickerProps) {
    const trigger = (
        <Button variant="outline" size="sm" className="self-start mt-2" testID={testID}>
            <ButtonText>Add field</ButtonText>
        </Button>
    )
    return (
        <Menu presentation="auto" title="Add a field" trigger={trigger}>
            {GROUPS.map(g => (
                <KindSection key={g.label} group={g} onPick={onPick} />
            ))}
        </Menu>
    )
}
