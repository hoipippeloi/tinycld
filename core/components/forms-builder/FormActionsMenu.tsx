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
    /** Why the form cannot be deleted, shown on the item; null when it can be. */
    deleteBlockedBy: string | null
    onRename: () => void
    onDuplicate: () => void
    onSetDefault: () => void
    onArchive: () => void
    onDelete: () => void
}

/** A disabled item says why in its own label, which a screen reader reads too. */
function withReason(label: string, reason: string | null) {
    return reason ? `${label} (${reason})` : label
}

function defaultBlockedBy(form: FormRow) {
    if (form.is_default) return 'already the default'
    if (form.archived) return 'archived'
    return null
}

export function menuLabels(form: FormRow, deleteBlockedBy: string | null) {
    const archive = form.archived ? 'Unarchive' : 'Archive'
    return {
        makeDefault: withReason('Make default', defaultBlockedBy(form)),
        archive: withReason(archive, form.is_default ? 'default form' : null),
        remove: withReason('Delete…', deleteBlockedBy),
    }
}

export function FormActionsMenu({
    form,
    deleteBlockedBy,
    onRename,
    onDuplicate,
    onSetDefault,
    onArchive,
    onDelete,
}: FormActionsMenuProps) {
    const fg = useThemeColor('foreground')
    const labels = menuLabels(form, deleteBlockedBy)
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
                label={labels.makeDefault}
                icon={Star}
                isDisabled={form.is_default || form.archived}
                onSelect={onSetDefault}
                testID={`forms-default-${form.id}`}
            />
            <Menu.Item
                label={labels.archive}
                icon={form.archived ? ArchiveRestore : Archive}
                isDisabled={form.is_default}
                onSelect={onArchive}
                testID={`forms-archive-${form.id}`}
            />
            <Menu.Item
                label={labels.remove}
                icon={Trash2}
                isDestructive
                isDisabled={deleteBlockedBy !== null}
                onSelect={onDelete}
                testID={`forms-delete-${form.id}`}
            />
        </Menu>
    )
}
