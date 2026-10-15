import { eq } from '@tanstack/db'
import { formatLastUsed } from '@tinycld/core/components/settings/ConnectedAppsSection'
import { formatSince } from '@tinycld/core/components/settings/security/security-format'
import { errorToString } from '@tinycld/core/lib/errors'
import { mutation, useMutation } from '@tinycld/core/lib/mutations'
import { NativeAuthCancelled } from '@tinycld/core/lib/native-auth-errors'
import { notify } from '@tinycld/core/lib/notify'
import { passkeys } from '@tinycld/core/lib/passkey'
import { defaultPasskeyName } from '@tinycld/core/lib/passkey-types'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { useMyLiveQuery } from '@tinycld/core/lib/use-my-live-query'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { ConfirmDialog } from '@tinycld/core/ui/ConfirmDialog'
import { PromptDialog } from '@tinycld/core/ui/PromptDialog'
import { Pencil, Trash2 } from 'lucide-react-native'
import { useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'

function isCancel(error: unknown) {
    return (
        error instanceof NativeAuthCancelled ||
        (error instanceof Error && error.name === 'NotAllowedError')
    )
}

function usePasskeyRows() {
    const [passkeysCollection] = useStore('passkeys')
    const { data } = useMyLiveQuery((query, { userId }) =>
        query
            .from({ p: passkeysCollection })
            .where(({ p }) => eq(p.user, userId))
            .orderBy(({ p }) => p.created)
            .select(({ p }) => ({
                id: p.id,
                name: p.name,
                created: p.created,
                lastUsed: p.last_used,
            }))
    )
    return data ?? []
}

type PasskeyRow = ReturnType<typeof usePasskeyRows>[number]

function usePasskeys() {
    const [passkeysCollection] = useStore('passkeys')
    const rows = usePasskeyRows()
    const [renaming, setRenaming] = useState<PasskeyRow | null>(null)
    const [removing, setRemoving] = useState<PasskeyRow | null>(null)

    const add = useMutation({
        mutationFn: async () => {
            await passkeys.add(defaultPasskeyName(Platform.OS))
            // The new row was written by the server; fetch it rather than
            // wait for the realtime echo.
            await passkeysCollection.reload()
            notify.emit({ event: 'account.security_changed', title: 'Passkey added' })
        },
        onError: () => {},
    })

    const rename = useMutation({
        mutationFn: mutation(function* ({ id, name }: { id: string; name: string }) {
            yield passkeysCollection.update(id, draft => {
                draft.name = name
            })
        }),
        onSuccess: () => setRenaming(null),
    })

    const remove = useMutation({
        mutationFn: mutation(function* (id: string) {
            yield passkeysCollection.delete(id)
        }),
        onSuccess: () => {
            setRemoving(null)
            notify.emit({ event: 'account.security_changed', title: 'Passkey removed' })
        },
    })

    return {
        rows,
        canAdd: passkeys.isAvailable(),
        add: () => add.mutate(),
        isAdding: add.isPending,
        addError: add.error && !isCancel(add.error) ? errorToString(add.error) : null,
        renaming,
        startRename: setRenaming,
        cancelRename: () => setRenaming(null),
        submitRename: (name: string) => {
            if (renaming) rename.mutate({ id: renaming.id, name })
        },
        isRenaming: rename.isPending,
        removing,
        startRemove: setRemoving,
        cancelRemove: () => setRemoving(null),
        confirmRemove: () => {
            if (removing) remove.mutate(removing.id)
        },
        isRemoving: remove.isPending,
    }
}

export function PasskeysSection() {
    const pk = usePasskeys()

    return (
        <View
            className="rounded-xl border border-border bg-surface-secondary p-4 gap-3"
            testID="passkeys-section"
        >
            <Text className="text-base font-semibold text-foreground">Passkeys</Text>
            <Text className="text-[13px] text-muted-foreground">
                Sign in with your fingerprint, face or device screen lock instead of a password. A
                passkey also counts as your second step.
            </Text>

            <PasskeyList rows={pk.rows} onRename={pk.startRename} onRemove={pk.startRemove} />

            <AddButton isVisible={pk.canAdd} isAdding={pk.isAdding} onAdd={pk.add} />
            <AddError error={pk.addError} />

            <PromptDialog
                isOpen={!!pk.renaming}
                onClose={pk.cancelRename}
                onSubmit={pk.submitRename}
                title="Rename passkey"
                defaultValue={pk.renaming?.name}
                confirmLabel="Save"
                maxLength={100}
                required
                isSubmitting={pk.isRenaming}
            />
            <ConfirmDialog
                isOpen={!!pk.removing}
                onClose={pk.cancelRemove}
                onConfirm={pk.confirmRemove}
                title="Remove passkey?"
                message={`"${pk.removing?.name ?? ''}" will no longer sign you in. Remove it from the device's password manager too.`}
                confirmLabel="Remove"
                isDestructive
                isSubmitting={pk.isRemoving}
            />
        </View>
    )
}

type ListProps = {
    rows: PasskeyRow[]
    onRename: (row: PasskeyRow) => void
    onRemove: (row: PasskeyRow) => void
}

function PasskeyList({ rows, onRename, onRemove }: ListProps) {
    if (rows.length === 0) {
        return <Text className="text-sm text-muted-foreground">You have no passkeys.</Text>
    }
    const items = rows.map(row => (
        <PasskeyItem
            key={row.id}
            row={row}
            onRename={() => onRename(row)}
            onRemove={() => onRemove(row)}
        />
    ))
    return <View className="gap-1.5">{items}</View>
}

function PasskeyItem({
    row,
    onRename,
    onRemove,
}: {
    row: PasskeyRow
    onRename: () => void
    onRemove: () => void
}) {
    const mutedColor = useThemeColor('muted-foreground')
    return (
        <View className="flex-row items-center gap-3 py-1.5" testID="passkey-row">
            <View className="flex-1">
                <Text className="text-sm font-semibold text-foreground">{row.name}</Text>
                <Text className="text-xs text-muted-foreground">
                    Added {formatSince(row.created)} · {formatLastUsed(row.lastUsed ?? '')}
                </Text>
            </View>
            <Pressable accessibilityLabel={`Rename ${row.name}`} onPress={onRename} hitSlop={8}>
                <Pencil size={16} color={mutedColor} />
            </Pressable>
            <Pressable accessibilityLabel={`Remove ${row.name}`} onPress={onRemove} hitSlop={8}>
                <Trash2 size={16} color={mutedColor} />
            </Pressable>
        </View>
    )
}

function AddButton({
    isVisible,
    isAdding,
    onAdd,
}: {
    isVisible: boolean
    isAdding: boolean
    onAdd: () => void
}) {
    if (!isVisible) return null
    return (
        <Button
            testID="passkey-add"
            variant="outline"
            className="self-start"
            onPress={onAdd}
            isDisabled={isAdding}
        >
            <ButtonText>Add a passkey</ButtonText>
        </Button>
    )
}

function AddError({ error }: { error: string | null }) {
    if (!error) return null
    return <Text className="text-xs text-danger">{error}</Text>
}
