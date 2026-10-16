import { eq } from '@tanstack/db'
import { RecoveryCodesPanel } from '@tinycld/core/components/settings/security/RecoveryCodesPanel'
import {
    formatSince,
    proofFromInput,
} from '@tinycld/core/components/settings/security/security-format'
import { TotpSetupPanel } from '@tinycld/core/components/settings/security/TotpSetupPanel'
import { errorToString } from '@tinycld/core/lib/errors'
import {
    beginTotpSetup,
    confirmTotpSetup,
    disableTotp,
    regenerateRecoveryCodes,
} from '@tinycld/core/lib/mfa'
import { useMutation } from '@tinycld/core/lib/mutations'
import { notify } from '@tinycld/core/lib/notify'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { acceptServerRow, evictRows } from '@tinycld/core/lib/server-rows'
import { useMyLiveQuery } from '@tinycld/core/lib/use-my-live-query'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { PromptDialog } from '@tinycld/core/ui/PromptDialog'
import { useState } from 'react'
import { Text, View } from 'react-native'

type Prompt = 'disable' | 'regenerate' | null

function useTotp() {
    const [totpCollection] = useStore('mfa_totp')
    const { data: rows } = useMyLiveQuery((query, { userId }) =>
        query
            .from({ t: totpCollection })
            .where(({ t }) => eq(t.user, userId))
            .select(({ t }) => ({
                id: t.id,
                enabledAt: t.enabled_at,
                remaining: t.recovery_remaining,
            }))
    )
    const row = rows?.[0]
    const isOn = !!row?.enabledAt

    // Codes from the last confirm or regenerate, shown once.
    const [codes, setCodes] = useState<string[] | null>(null)
    const [prompt, setPrompt] = useState<Prompt>(null)

    const begin = useMutation({
        mutationFn: async () => {
            const setup = await beginTotpSetup()
            await acceptServerRow(totpCollection, setup.record, 'mfa.totp.begin')
            return setup
        },
    })

    const confirm = async (code: string) => {
        const result = await confirmTotpSetup(code)
        await acceptServerRow(totpCollection, result.record, 'mfa.totp.confirm')
        setCodes(result.recoveryCodes)
        begin.reset()
        notify.emit({ event: 'account.security_changed', title: 'Two-step verification is on' })
    }

    const act = useMutation({
        mutationFn: async ({ kind, value }: { kind: 'disable' | 'regenerate'; value: string }) => {
            if (kind === 'disable') {
                const { id } = await disableTotp(proofFromInput(value))
                evictRows(totpCollection, [id], 'mfa.totp.disable')
                notify.emit({
                    event: 'account.security_changed',
                    title: 'Authenticator app removed',
                })
                return
            }
            const result = await regenerateRecoveryCodes(value.replace(/\s+/g, ''))
            await acceptServerRow(totpCollection, result.record, 'mfa.totp.regenerate')
            setCodes(result.recoveryCodes)
        },
        onSuccess: () => setPrompt(null),
        // Shown in the dialog; the default toast would repeat it.
        onError: () => {},
    })

    return {
        isOn,
        since: formatSince(row?.enabledAt ?? ''),
        remaining: row?.remaining ?? 0,
        setup: begin.data ?? null,
        startSetup: () => begin.mutate(),
        isStarting: begin.isPending,
        cancelSetup: () => begin.reset(),
        confirm,
        codes,
        clearCodes: () => setCodes(null),
        prompt,
        openPrompt: setPrompt,
        closePrompt: () => {
            act.reset()
            setPrompt(null)
        },
        submitPrompt: (value: string) => {
            if (prompt) act.mutate({ kind: prompt, value })
        },
        isActing: act.isPending,
        actError: act.error ? errorToString(act.error) : null,
    }
}

export function TotpSection() {
    const totp = useTotp()

    return (
        <View
            className="rounded-xl border border-border bg-surface-secondary p-4 gap-3"
            testID="totp-section"
        >
            <Text className="text-base font-semibold text-foreground">Authenticator app</Text>
            <Text className="text-[13px] text-muted-foreground">
                After your password, sign-in asks for a 6-digit code from an app on your phone.
            </Text>

            <CodesView codes={totp.codes} onDone={totp.clearCodes} />
            <OffView
                isVisible={!totp.isOn && !totp.setup && !totp.codes}
                isStarting={totp.isStarting}
                onStart={totp.startSetup}
            />
            <SetupView setup={totp.setup} onConfirm={totp.confirm} onCancel={totp.cancelSetup} />
            <OnView
                isVisible={totp.isOn && !totp.codes}
                since={totp.since}
                remaining={totp.remaining}
                onRegenerate={() => totp.openPrompt('regenerate')}
                onDisable={() => totp.openPrompt('disable')}
            />

            <PromptDialog
                isOpen={totp.prompt === 'disable'}
                onClose={totp.closePrompt}
                onSubmit={totp.submitPrompt}
                title="Remove the authenticator app?"
                description="Type a code from your authenticator app, or a recovery code. Mail, calendar and contacts apps keep working with their app passwords."
                placeholder="123456"
                confirmLabel="Remove"
                maxLength={20}
                required
                isSubmitting={totp.isActing}
                errorMessage={totp.actError}
            />
            <PromptDialog
                isOpen={totp.prompt === 'regenerate'}
                onClose={totp.closePrompt}
                onSubmit={totp.submitPrompt}
                title="Make new recovery codes?"
                description="Type a code from your authenticator app. Your old recovery codes stop working."
                placeholder="123456"
                confirmLabel="Make new codes"
                maxLength={7}
                required
                isSubmitting={totp.isActing}
                errorMessage={totp.actError}
            />
        </View>
    )
}

function OffView({
    isVisible,
    isStarting,
    onStart,
}: {
    isVisible: boolean
    isStarting: boolean
    onStart: () => void
}) {
    if (!isVisible) return null
    return (
        <Button
            testID="totp-start"
            className="self-start"
            onPress={onStart}
            isDisabled={isStarting}
        >
            <ButtonText>Set up an authenticator app</ButtonText>
        </Button>
    )
}

type SetupViewProps = {
    setup: { secret: string; uri: string } | null
    onConfirm: (code: string) => Promise<void>
    onCancel: () => void
}

function SetupView({ setup, onConfirm, onCancel }: SetupViewProps) {
    if (!setup) return null
    return (
        <View className="gap-3">
            <TotpSetupPanel setup={setup} onConfirm={onConfirm} />
            <Button variant="outline" className="self-start" onPress={onCancel}>
                <ButtonText>Cancel</ButtonText>
            </Button>
        </View>
    )
}

type OnViewProps = {
    isVisible: boolean
    since: string
    remaining: number
    onRegenerate: () => void
    onDisable: () => void
}

function OnView({ isVisible, since, remaining, onRegenerate, onDisable }: OnViewProps) {
    if (!isVisible) return null
    return (
        <View className="gap-2">
            <Text className="text-sm text-foreground" testID="totp-on">
                On since {since}. {remaining} recovery codes left.
            </Text>
            <View className="flex-row gap-3 flex-wrap">
                <Button variant="outline" testID="totp-regenerate" onPress={onRegenerate}>
                    <ButtonText>New recovery codes</ButtonText>
                </Button>
                <Button variant="outline" testID="totp-disable" onPress={onDisable}>
                    <ButtonText>Remove</ButtonText>
                </Button>
            </View>
        </View>
    )
}

function CodesView({ codes, onDone }: { codes: string[] | null; onDone: () => void }) {
    if (!codes) return null
    return <RecoveryCodesPanel codes={codes} doneLabel="I saved my codes" onDone={onDone} />
}
