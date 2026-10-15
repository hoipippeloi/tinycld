import { notify } from '@tinycld/core/lib/notify'
import { Button, ButtonText, ServerActionButton } from '@tinycld/core/ui/button'
import * as Clipboard from 'expo-clipboard'
import { Text, View } from 'react-native'

type Props = {
    codes: string[]
    doneLabel: string
    onDone: () => void
}

/**
 * Shows new recovery codes once. The server keeps only their hashes, so this
 * is the user's one chance to save them.
 */
export function RecoveryCodesPanel({ codes, doneLabel, onDone }: Props) {
    const copy = async () => {
        await Clipboard.setStringAsync(codes.join('\n'))
        notify.emit({ event: 'account.security_copied', title: 'Recovery codes copied' })
    }

    return (
        <View className="gap-3" testID="recovery-codes">
            <Text className="text-base font-semibold text-foreground">
                Save your recovery codes
            </Text>
            <Text className="text-[13px] text-muted-foreground">
                If you lose your phone, each code signs you in one time. Keep them somewhere safe,
                such as a password manager. You will not see them again.
            </Text>
            <CodeGrid codes={codes} />
            <View className="flex-row gap-3 flex-wrap">
                <Button variant="outline" onPress={copy}>
                    <ButtonText>Copy codes</ButtonText>
                </Button>
                <ServerActionButton testID="recovery-codes-done" onPress={onDone}>
                    <ButtonText>{doneLabel}</ButtonText>
                </ServerActionButton>
            </View>
        </View>
    )
}

function CodeGrid({ codes }: { codes: string[] }) {
    const rows = codes.map(code => (
        <Text key={code} selectable className="w-1/2 py-1 font-mono text-sm text-foreground">
            {code}
        </Text>
    ))
    return (
        <View className="flex-row flex-wrap rounded-lg border border-border bg-surface p-3">
            {rows}
        </View>
    )
}
