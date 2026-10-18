import { SortableDragHandle, SortableList } from '@tinycld/core/components/SortableList'
import { useFormAdmin } from '@tinycld/core/lib/forms/use-form-admin'
import { useFormHost, useFormHosts } from '@tinycld/core/lib/forms/use-form-hosts'
import type { FormRow } from '@tinycld/core/lib/forms/use-forms-of-host'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { ConfirmDialog } from '@tinycld/core/ui/ConfirmDialog'
import { PromptDialog } from '@tinycld/core/ui/PromptDialog'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { FormActionsMenu } from './FormActionsMenu'
import { NewFormDialog } from './NewFormDialog'

export interface FormsListProps {
    hostKey: string
    onOpen: (formId: string) => void
}

type ActionKind = 'rename' | 'duplicate' | 'default' | 'archive' | 'delete'
type Pending =
    | { kind: 'new' }
    | { kind: 'rename'; form: FormRow }
    | { kind: 'delete'; form: FormRow }
    | null

function Badge({ label, isVisible }: { label: string; isVisible: boolean }) {
    if (!isVisible) return null
    return <Text className="text-xs text-muted-foreground ml-2">{label}</Text>
}

interface RowProps {
    form: FormRow
    deleteBlockedBy: string | null
    onOpen: () => void
    onAction: (kind: ActionKind) => void
}

function Row({ form, deleteBlockedBy, onOpen, onAction }: RowProps) {
    return (
        <View
            className="flex-row items-center py-2 border-b border-border"
            testID={`forms-row-${form.id}`}
        >
            <SortableDragHandle testID={`forms-drag-${form.id}`} />
            <Pressable
                onPress={onOpen}
                className="flex-1 flex-row items-center px-2"
                accessibilityRole="button"
                testID={`forms-open-${form.id}`}
            >
                <Text className="text-foreground">{form.name}</Text>
                <Badge label="Default" isVisible={form.is_default} />
                <Badge label="Archived" isVisible={form.archived} />
            </Pressable>
            <FormActionsMenu
                form={form}
                deleteBlockedBy={deleteBlockedBy}
                onRename={() => onAction('rename')}
                onDuplicate={() => onAction('duplicate')}
                onSetDefault={() => onAction('default')}
                onArchive={() => onAction('archive')}
                onDelete={() => onAction('delete')}
            />
        </View>
    )
}

function useFormsListActions(hostKey: string, onOpen: (id: string) => void) {
    const admin = useFormAdmin(hostKey)
    // Which dialog is open: local UI state only.
    const [pending, setPending] = useState<Pending>(null)
    const run = async (fn: () => Promise<unknown>) => {
        try {
            await fn()
            setPending(null)
        } catch {
            // useMutation's default onError already toasts and reports; the
            // dialog stays open so the user can retry.
        }
    }
    const act = (form: FormRow, kind: ActionKind) => {
        if (kind === 'rename') setPending({ kind: 'rename', form })
        else if (kind === 'delete') setPending({ kind: 'delete', form })
        else if (kind === 'duplicate')
            run(async () => onOpen(await admin.duplicate.mutateAsync(form.id)))
        else if (kind === 'default') run(() => admin.setDefault.mutateAsync(form.id))
        else run(() => admin.archive.mutateAsync({ id: form.id, archived: !form.archived }))
    }
    return { admin, pending, setPending, run, act }
}

/** The host's name over its forms, where the admin picked it from several. */
function HostHeading({ hostKey }: { hostKey: string }) {
    const hosts = useFormHosts()
    const host = useFormHost(hostKey)
    if (hosts.length <= 1 || !host) return null
    return (
        <Text className="text-foreground text-lg font-semibold mb-2" testID="forms-host-heading">
            {host.label}
        </Text>
    )
}

const DELETE_MESSAGE =
    'Records using this form must change type first; the server refuses to delete a form in use.'

export function FormsList({ hostKey, onOpen }: FormsListProps) {
    const { admin, pending, setPending, run, act } = useFormsListActions(hostKey, onOpen)
    const close = () => setPending(null)
    const deleteBlockedBy = (form: FormRow) => {
        if (form.is_default) return 'default form'
        if (admin.forms.length <= 1) return 'only form'
        return null
    }
    const renaming = pending?.kind === 'rename' ? pending.form : null
    const deleting = pending?.kind === 'delete' ? pending.form : null
    return (
        <View>
            <HostHeading hostKey={hostKey} />
            <SortableList
                data={admin.forms}
                keyExtractor={f => f.id}
                onReorder={rows => run(() => admin.reorder.mutateAsync(rows.map(r => r.id)))}
                renderItem={({ item }) => (
                    <Row
                        form={item}
                        deleteBlockedBy={deleteBlockedBy(item)}
                        onOpen={() => onOpen(item.id)}
                        onAction={kind => act(item, kind)}
                    />
                )}
            />
            <Button
                variant="outline"
                onPress={() => setPending({ kind: 'new' })}
                testID="forms-new"
                className="mt-3 self-start"
            >
                <ButtonText>New form</ButtonText>
            </Button>
            <NewFormDialog
                isOpen={pending?.kind === 'new'}
                onClose={close}
                isSubmitting={admin.create.isPending}
                onCreate={name => run(async () => onOpen(await admin.create.mutateAsync(name)))}
            />
            <PromptDialog
                isOpen={renaming !== null}
                onClose={close}
                title="Rename form"
                defaultValue={renaming?.name ?? ''}
                required
                maxLength={120}
                isSubmitting={admin.rename.isPending}
                onSubmit={name =>
                    renaming && run(() => admin.rename.mutateAsync({ id: renaming.id, name }))
                }
            />
            <ConfirmDialog
                isOpen={deleting !== null}
                onClose={close}
                title="Delete form"
                message={DELETE_MESSAGE}
                confirmLabel="Delete"
                isDestructive
                isSubmitting={admin.remove.isPending}
                onConfirm={() => deleting && run(() => admin.remove.mutateAsync(deleting.id))}
            />
        </View>
    )
}
