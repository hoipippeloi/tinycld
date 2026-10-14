import type { FormRow } from '@tinycld/core/lib/forms/use-forms-of-host'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Menu } from '@tinycld/core/ui/menu'
import {
    Archive,
    ArchiveRestore,
    Copy,
    EllipsisVertical,
    Pencil,
    Star,
    Trash2,
} from 'lucide-react-native'
import { Pressable } from 'react-native'

export interface FormActionsMenuProps {
    form: FormRow
    canDelete: boolean
    onRename: () => void
    onDuplicate: () => void
    onSetDefault: () => void
    onArchive: () => void
    onDelete: () => void
}

export function FormActionsMenu({
    form,
    canDelete,
    onRename,
    onDuplicate,
    onSetDefault,
    onArchive,
    onDelete,
}: FormActionsMenuProps) {
    const fg = useThemeColor('foreground')
    return (
        <Menu
            presentation="popover"
            title={form.name}
            trigger={
                <Pressable
                    accessibilityLabel={`Actions for ${form.name}`}
                    testID={`forms-menu-${form.id}`}
                    className="p-1"
                >
                    <EllipsisVertical size={18} color={fg} />
                </Pressable>
            }
        >
            <Menu.Item
                label="Rename…"
                icon={Pencil}
                onSelect={onRename}
                testID={`forms-rename-${form.id}`}
            />
            <Menu.Item
                label="Duplicate"
                icon={Copy}
                onSelect={onDuplicate}
                testID={`forms-duplicate-${form.id}`}
            />
            <Menu.Item
                label="Make default"
                icon={Star}
                isDisabled={form.is_default || form.archived}
                onSelect={onSetDefault}
                testID={`forms-default-${form.id}`}
            />
            <Menu.Item
                label={form.archived ? 'Unarchive' : 'Archive'}
                icon={form.archived ? ArchiveRestore : Archive}
                isDisabled={form.is_default}
                onSelect={onArchive}
                testID={`forms-archive-${form.id}`}
            />
            <Menu.Item
                label="Delete…"
                icon={Trash2}
                isDestructive
                isDisabled={!canDelete}
                onSelect={onDelete}
                testID={`forms-delete-${form.id}`}
            />
        </Menu>
    )
}
