import { and, eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import type { PickedFile } from '@tinycld/core/file-viewer/picked-file'
import { uploadRecordWithFile } from '@tinycld/core/file-viewer/upload-file'
import { usePickFiles } from '@tinycld/core/file-viewer/use-pick-files'
import { useAuth } from '@tinycld/core/lib/auth'
import { useMutation } from '@tinycld/core/lib/mutations'
import type { FormHost } from '@tinycld/core/lib/packages/derive-form-hosts'
import { collectionByName } from '@tinycld/core/lib/pocketbase'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { X } from 'lucide-react-native'
import { newRecordId } from 'pbtsdb/core'
import { Pressable, Text, View } from 'react-native'

export interface FileFieldProps {
    host: FormHost
    fieldKey: string
    recordId: string
    value: string[] | null
    onChange: (ids: string[]) => void
    multiple: boolean
    accept: string[]
    disabled?: boolean
    testID?: string
}

type FileRow = { id: string; name?: string; [column: string]: unknown }

// The file collection is named by the host at runtime, so its columns cannot be keys of any one row type.
function column(ref: object, name: string): string {
    return (ref as Record<string, string>)[name]
}

function useFieldFiles(host: FormHost, fieldKey: string, recordId: string) {
    const files = host.files
    const collection = files ? collectionByName(files.collection) : undefined
    const { data } = useLiveQuery(
        query => {
            if (!collection || !files) return null
            return query
                .from({ f: collection })
                .where(({ f }) =>
                    and(
                        eq(column(f, files.recordColumn), recordId),
                        eq(column(f, files.fieldColumn), fieldKey)
                    )
                )
        },
        [collection, recordId, fieldKey]
    )
    return { rows: (data ?? []) as FileRow[], collection, files }
}

function FileRowView({
    row,
    onRemove,
    disabled,
}: {
    row: FileRow
    onRemove: () => void
    disabled?: boolean
}) {
    const fg = useThemeColor('foreground')
    const label = String(row.name ?? row.id)
    return (
        <View className="flex-row items-center py-1">
            <Text className="flex-1 text-foreground">{label}</Text>
            <Pressable
                onPress={onRemove}
                disabled={disabled}
                accessibilityLabel={`Remove ${label}`}
            >
                <X size={16} color={fg} />
            </Pressable>
        </View>
    )
}

function FileRows({
    rows,
    onRemove,
    disabled,
}: {
    rows: FileRow[]
    onRemove: (id: string) => void
    disabled?: boolean
}) {
    return (
        <>
            {rows.map(row => (
                <FileRowView
                    key={row.id}
                    row={row}
                    onRemove={() => onRemove(row.id)}
                    disabled={disabled}
                />
            ))}
        </>
    )
}

function pickLabel(isPending: boolean, multiple: boolean): string {
    if (isPending) return 'Uploading…'
    return multiple ? 'Add files' : 'Choose file'
}

export function FileField({
    host,
    fieldKey,
    recordId,
    value,
    onChange,
    multiple,
    accept,
    disabled,
    testID,
}: FileFieldProps) {
    const { user } = useAuth()
    const { pickFiles } = usePickFiles()
    const { rows, collection, files } = useFieldFiles(host, fieldKey, recordId)
    const upload = useMutation({
        mutationFn: async (picked: PickedFile[]) => {
            if (!files) return
            const ids: string[] = []
            for (const file of picked) {
                const id = newRecordId()
                await uploadRecordWithFile({
                    collection: files.collection,
                    fields: {
                        id,
                        [files.recordColumn]: recordId,
                        [files.fieldColumn]: fieldKey,
                        [files.sizeColumn]: String(file.size),
                        [files.uploaderColumn]: user.id,
                        name: file.name,
                    },
                    file,
                })
                ids.push(id)
            }
            onChange(multiple ? [...(value ?? []), ...ids] : ids.slice(-1))
            await collection?.reload()
        },
    })
    const remove = useMutation({
        mutationFn: function* (id: string) {
            if (!collection) return
            yield collection.delete(id)
            onChange((value ?? []).filter(x => x !== id))
        },
    })
    const pick = async () => {
        const picked = await pickFiles({ sources: ['documents'], multiple, mimeTypes: accept })
        if (picked.length > 0) upload.mutate(picked)
    }
    if (!files)
        return <Text className="text-muted-foreground">{host.label} has no file storage.</Text>
    return (
        <View testID={testID}>
            <FileRows rows={rows} onRemove={id => remove.mutate(id)} disabled={disabled} />
            <Button
                onPress={pick}
                isDisabled={disabled || upload.isPending}
                size="sm"
                variant="outline"
            >
                <ButtonText>{pickLabel(upload.isPending, multiple)}</ButtonText>
            </Button>
        </View>
    )
}
