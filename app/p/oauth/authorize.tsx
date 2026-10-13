import { useQuery } from '@tanstack/react-query'
import { DocumentTitle } from '@tinycld/core/components/DocumentTitle'
import {
    deviceAuthorizeSchema,
    lookupUserCode,
    MAX_DEVICE_LABEL_LENGTH,
} from '@tinycld/core/components/oauth/device-authorize-schema'
import { ScopeList } from '@tinycld/core/components/oauth/ScopeList'
import { AuthGate } from '@tinycld/core/components/workspace/AuthGate'
import { useAuth } from '@tinycld/core/lib/auth'
import { useMutation } from '@tinycld/core/lib/mutations'
import { pb } from '@tinycld/core/lib/pocketbase'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { ButtonText, ServerActionButton } from '@tinycld/core/ui/button'
import { type Control, Controller, useForm, useWatch, zodResolver } from '@tinycld/core/ui/form'
import { useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, Text, TextInput, View } from 'react-native'

interface AuthorizeInfo {
    client_name: string
    scopes: string[]
    scope_labels: Record<string, string>
    expires_at: string
}

type Decision = 'approved' | 'denied' | null

type DeviceForm = { code: string; deviceLabel: string }

function useAuthorizeInfo(code: string | null, enabled: boolean) {
    return useQuery<AuthorizeInfo>({
        queryKey: ['oauth-authorize-info', code],
        enabled: enabled && code !== null,
        queryFn: () =>
            pb.send<AuthorizeInfo>('/oauth/authorize/info', {
                method: 'GET',
                query: { user_code: code ?? '' },
            }),
        retry: false,
    })
}

function useDeviceDecision() {
    const [decision, setDecision] = useState<Decision>(null)

    const approve = useMutation({
        mutationFn: async ({ code, deviceLabel }: DeviceForm) => {
            const body = new FormData()
            body.append('user_code', code)
            body.append('device_label', deviceLabel)
            await pb.send('/oauth/authorize/approve', { method: 'POST', body })
        },
        onSuccess: () => setDecision('approved'),
    })

    const deny = useMutation({
        mutationFn: async ({ code }: DeviceForm) => {
            const body = new FormData()
            body.append('user_code', code)
            await pb.send('/oauth/authorize/deny', { method: 'POST', body })
        },
        onSuccess: () => setDecision('denied'),
    })

    return { decision, approve, deny }
}

function useDeviceAuthorize(initialCode: string, isLoggedIn: boolean) {
    const form = useForm({
        resolver: zodResolver(deviceAuthorizeSchema),
        defaultValues: { code: initialCode.toUpperCase(), deviceLabel: '' },
        mode: 'onChange',
    })
    // The lookup follows the code field rather than a submit: it fires as soon
    // as what was typed (or pre-filled from the URL) is a full code.
    const code = lookupUserCode(useWatch({ control: form.control, name: 'code' }))
    const info = useAuthorizeInfo(code, isLoggedIn)
    const { decision, approve, deny } = useDeviceDecision()

    return {
        control: form.control,
        info,
        decision,
        onApprove: form.handleSubmit(data => approve.mutate(data)),
        onDeny: form.handleSubmit(data => deny.mutate(data)),
        isApproving: approve.isPending,
        isDenying: deny.isPending,
    }
}

export default function OAuthAuthorizeScreen() {
    const params = useLocalSearchParams<{ user_code?: string }>()
    const auth = useAuth({ throwIfAnon: false })
    const { decision, ...consent } = useDeviceAuthorize(params.user_code ?? '', auth.isLoggedIn)

    return (
        <View className="flex-1 bg-background">
            <DocumentTitle title="Connect a device" includeOrg={false} />
            <SignInPrompt isVisible={!auth.isLoggedIn && !auth.isInitializing} />
            <DecisionResult decision={decision} />
            <ConsentForm isVisible={auth.isLoggedIn && decision === null} {...consent} />
        </View>
    )
}

function SignInPrompt({ isVisible }: { isVisible: boolean }) {
    if (!isVisible) return null
    // AuthGate renders the same sign-in modal used everywhere else in the app;
    // once auth succeeds this screen re-renders with isLoggedIn true and the
    // consent form takes over — no separate /login route to bounce through.
    return <AuthGate />
}

function DecisionResult({ decision }: { decision: Decision }) {
    if (decision === null) return null

    const title = decision === 'approved' ? 'Device connected' : 'Request denied'
    const description =
        decision === 'approved'
            ? 'You can return to your terminal.'
            : 'Nothing was granted access. You can close this page.'

    return (
        <View className="flex-1 items-center justify-center gap-2 p-6">
            <Text className="text-foreground text-xl font-semibold">{title}</Text>
            <Text className="text-muted-foreground text-center">{description}</Text>
        </View>
    )
}

interface ConsentFormProps {
    isVisible: boolean
    control: Control<DeviceForm>
    info: ReturnType<typeof useAuthorizeInfo>
    onApprove: () => void
    onDeny: () => void
    isApproving: boolean
    isDenying: boolean
}

function ConsentForm({
    isVisible,
    control,
    info,
    onApprove,
    onDeny,
    isApproving,
    isDenying,
}: ConsentFormProps) {
    if (!isVisible) return null

    return (
        <View
            className="flex-1 gap-6 p-6"
            style={{ maxWidth: 480, width: '100%', alignSelf: 'center' }}
        >
            <Text className="text-foreground text-2xl font-semibold">Connect a device</Text>
            <CodeInput control={control} />
            <InfoStatus info={info} />
            <GrantDetails
                info={info.data}
                control={control}
                onApprove={onApprove}
                onDeny={onDeny}
                isApproving={isApproving}
                isDenying={isDenying}
            />
        </View>
    )
}

function CodeInput({ control }: { control: Control<DeviceForm> }) {
    const placeholderColor = useThemeColor('field-placeholder')

    return (
        <View className="gap-2">
            <Text className="text-muted-foreground">Enter the code shown in your terminal</Text>
            <Controller
                control={control}
                name="code"
                render={({ field }) => (
                    <TextInput
                        value={field.value}
                        // Shown upper-case as typed, matching the terminal.
                        onChangeText={text => field.onChange(text.toUpperCase())}
                        onBlur={field.onBlur}
                        placeholder="WDJB-MJHT"
                        placeholderTextColor={placeholderColor}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        className="border border-border rounded-lg px-3 py-2.5 text-base text-foreground bg-background"
                    />
                )}
            />
        </View>
    )
}

// The server's message when it sent one, else a generic fallback covering the
// three states a lookup failure can mean.
const FALLBACK_CODE_ERROR = 'That code is not valid, has expired, or has already been used.'

function authorizeErrorMessage(error: unknown): string {
    const message = (error as { response?: { message?: string } })?.response?.message
    return message && message.trim() !== '' ? message : FALLBACK_CODE_ERROR
}

function InfoStatus({ info }: { info: ReturnType<typeof useAuthorizeInfo> }) {
    if (info.isLoading) {
        return (
            <View className="items-center py-4">
                <ActivityIndicator />
            </View>
        )
    }

    if (info.isError) {
        // Show what the server actually said. It distinguishes "already been
        // used", "has expired" and "Sign in to approve this request"; a fixed
        // catch-all made an auth or server failure read as a bad code.
        return <Text className="text-destructive">{authorizeErrorMessage(info.error)}</Text>
    }

    return null
}

function GrantDetails({
    info,
    control,
    onApprove,
    onDeny,
    isApproving,
    isDenying,
}: {
    info: AuthorizeInfo | undefined
    control: Control<DeviceForm>
    onApprove: () => void
    onDeny: () => void
    isApproving: boolean
    isDenying: boolean
}) {
    const placeholderColor = useThemeColor('field-placeholder')

    if (!info) return null

    return (
        <View className="gap-4">
            <Text className="text-foreground text-lg">{info.client_name} wants access to:</Text>
            <ScopeList scopes={info.scopes} labels={info.scope_labels} />

            <View className="gap-2">
                <Text className="text-muted-foreground">Name this device</Text>
                <Controller
                    control={control}
                    name="deviceLabel"
                    render={({ field }) => (
                        <TextInput
                            value={field.value}
                            onChangeText={field.onChange}
                            onBlur={field.onBlur}
                            placeholder="My laptop"
                            placeholderTextColor={placeholderColor}
                            maxLength={MAX_DEVICE_LABEL_LENGTH}
                            className="border border-border rounded-lg px-3 py-2.5 text-base text-foreground bg-background"
                        />
                    )}
                />
            </View>

            <View className="flex-row gap-3">
                <ServerActionButton
                    onPress={onApprove}
                    isDisabled={isApproving || isDenying}
                    className="flex-1"
                >
                    {isApproving ? <ActivityIndicator /> : <ButtonText>Connect</ButtonText>}
                </ServerActionButton>
                <ServerActionButton
                    variant="outline"
                    onPress={onDeny}
                    isDisabled={isApproving || isDenying}
                    className="flex-1"
                >
                    {isDenying ? <ActivityIndicator /> : <ButtonText>Deny</ButtonText>}
                </ServerActionButton>
            </View>
        </View>
    )
}
