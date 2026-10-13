import {
    shareCodeSchema,
    shareEmailSchema,
} from '@tinycld/core/components/share/share-sign-in-schemas'
import { useAuthStore } from '@tinycld/core/lib/stores/auth-store'
import {
    Controller,
    type FieldErrors,
    isFormSubmittable,
    useForm,
    zodResolver,
} from '@tinycld/core/ui/form'
import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'

export interface ShareLinkSignInProps {
    /** The package whose share-link API to call — forms `/api/<slug>/share-link/…`. */
    slug: string
    /** The opaque share token from the package's public route (e.g. /p/<slug>/share/<token>). */
    token: string
    /** The share role — affects copy ("comment" vs "edit"). */
    role: 'commentor' | 'editor'
    /**
     * What the visitor is joining, for the copy: "document", "board".
     * Defaults to "document" so drive's existing call sites read unchanged.
     */
    subject?: string
    /** Called after a successful verify (the auth store is already updated). */
    onSuccess: () => void
}

type Flow = { step: 'email'; email: string } | { step: 'code'; email: string; otpId: string }

// Two-step email-OTP flow for guest provisioning on a share link.
// Step 1: collect email, POST /otp-request, advance on success.
// Step 2: collect the 6-digit code, POST /otp-verify; pb.authStore is
// updated by the verify call, then onSuccess fires.
//
// All server error messages are surfaced verbatim — including the
// uniform "invalid or expired code" used by the verify endpoint (which
// deliberately doesn't distinguish wrong-code from expired/unknown so
// brute-forcing can't enumerate).
export function ShareLinkSignIn({
    slug,
    token,
    role,
    subject = 'document',
    onSuccess,
}: ShareLinkSignInProps) {
    const [flow, setFlow] = useState<Flow>({ step: 'email', email: '' })
    const verb = role === 'editor' ? 'edit' : 'comment on'

    if (flow.step === 'email') {
        return (
            <EmailStep
                slug={slug}
                token={token}
                title={`Sign in to ${verb} this ${subject}`}
                defaultEmail={flow.email}
                onSent={(email, otpId) => setFlow({ step: 'code', email, otpId })}
            />
        )
    }

    return (
        <CodeStep
            slug={slug}
            token={token}
            email={flow.email}
            otpId={flow.otpId}
            onSuccess={onSuccess}
            onBack={() => setFlow({ step: 'email', email: flow.email })}
        />
    )
}

function useEmailStep(
    slug: string,
    token: string,
    defaultEmail: string,
    onSent: (email: string, otpId: string) => void
) {
    const requestShareOtp = useAuthStore(s => s.requestShareOtp)
    const form = useForm({
        resolver: zodResolver(shareEmailSchema),
        defaultValues: { email: defaultEmail },
        mode: 'onChange',
    })

    const onSubmit = form.handleSubmit(async ({ email }) => {
        const { otpId, error } = await requestShareOtp(slug, token, email)
        if (error || !otpId) {
            form.setError('root', { type: 'server', message: error ?? 'failed to send code' })
            return
        }
        onSent(email, otpId)
    })

    return { control: form.control, onSubmit, ...submitState(form.formState) }
}

function EmailStep({
    slug,
    token,
    title,
    defaultEmail,
    onSent,
}: {
    slug: string
    token: string
    title: string
    defaultEmail: string
    onSent: (email: string, otpId: string) => void
}) {
    const { control, onSubmit, isSubmitting, canSubmit, error } = useEmailStep(
        slug,
        token,
        defaultEmail,
        onSent
    )

    return (
        <View className="gap-3 p-6 max-w-md w-full self-center">
            <Text className="text-foreground" style={{ fontSize: 18, fontWeight: '600' }}>
                {title}
            </Text>
            <Text className="text-muted-foreground" style={{ fontSize: 13 }}>
                {`We'll email you a one-time code. No password required.`}
            </Text>
            <Controller
                control={control}
                name="email"
                render={({ field, fieldState }) => (
                    <>
                        <TextInput
                            value={field.value}
                            onChangeText={field.onChange}
                            onBlur={field.onBlur}
                            placeholder="your@email"
                            autoCapitalize="none"
                            keyboardType="email-address"
                            autoComplete="email"
                            editable={!isSubmitting}
                            className="border border-border rounded-md px-3 py-2 text-foreground"
                        />
                        <ErrorText message={touchedError(fieldState)} />
                    </>
                )}
            />
            <ErrorText message={error} />
            <SubmitButton
                label="Send code"
                onPress={onSubmit}
                isSubmitting={isSubmitting}
                isDisabled={!canSubmit}
            />
        </View>
    )
}

function useCodeStep(
    slug: string,
    token: string,
    email: string,
    otpId: string,
    onSuccess: () => void
) {
    const verifyShareOtp = useAuthStore(s => s.verifyShareOtp)
    const form = useForm({
        resolver: zodResolver(shareCodeSchema),
        defaultValues: { code: '' },
        mode: 'onChange',
    })

    const onSubmit = form.handleSubmit(async ({ code }) => {
        const { user, error } = await verifyShareOtp(slug, token, email, code, otpId)
        if (error || !user) {
            form.setError('root', { type: 'server', message: error ?? 'failed to verify code' })
            return
        }
        onSuccess()
    })

    return { control: form.control, onSubmit, ...submitState(form.formState) }
}

function CodeStep({
    slug,
    token,
    email,
    otpId,
    onSuccess,
    onBack,
}: {
    slug: string
    token: string
    email: string
    otpId: string
    onSuccess: () => void
    onBack: () => void
}) {
    const { control, onSubmit, isSubmitting, canSubmit, error } = useCodeStep(
        slug,
        token,
        email,
        otpId,
        onSuccess
    )

    return (
        <View className="gap-3 p-6 max-w-md w-full self-center">
            <Text className="text-foreground" style={{ fontSize: 18, fontWeight: '600' }}>
                Enter your code
            </Text>
            <Text className="text-muted-foreground" style={{ fontSize: 13 }}>
                {`We sent a code to ${email}.`}
            </Text>
            <Controller
                control={control}
                name="code"
                render={({ field, fieldState }) => (
                    <>
                        <TextInput
                            value={field.value}
                            onChangeText={field.onChange}
                            onBlur={field.onBlur}
                            placeholder="123456"
                            keyboardType="number-pad"
                            editable={!isSubmitting}
                            className="border border-border rounded-md px-3 py-2 text-foreground text-center"
                            style={{ fontSize: 18, letterSpacing: 4 }}
                        />
                        <ErrorText message={touchedError(fieldState)} />
                    </>
                )}
            />
            <ErrorText message={error} />
            <SubmitButton
                label="Verify"
                onPress={onSubmit}
                isSubmitting={isSubmitting}
                isDisabled={!canSubmit}
            />
            <Pressable onPress={onBack} disabled={isSubmitting}>
                <Text
                    className="text-muted-foreground"
                    style={{ fontSize: 13, textAlign: 'center' }}
                >
                    Use a different email
                </Text>
            </Pressable>
        </View>
    )
}

function submitState(formState: { isSubmitting: boolean; isValid: boolean; errors: FieldErrors }) {
    const { isSubmitting, isValid, errors } = formState
    return {
        isSubmitting,
        canSubmit: isFormSubmittable({ isValid, errors }) && !isSubmitting,
        error: errors.root?.message,
    }
}

// A field error waits until the visitor leaves the field, so a half-typed
// value is not flagged on every keystroke; until then the disabled button is
// the cue.
function touchedError(fieldState: { isTouched: boolean; error?: { message?: string } }) {
    return fieldState.isTouched ? fieldState.error?.message : undefined
}

function ErrorText({ message }: { message: string | undefined }) {
    if (!message) return null
    return (
        <Text className="text-danger" style={{ fontSize: 13 }}>
            {message}
        </Text>
    )
}

function SubmitButton({
    label,
    onPress,
    isSubmitting,
    isDisabled,
}: {
    label: string
    onPress: () => void
    isSubmitting: boolean
    isDisabled: boolean
}) {
    return (
        <Pressable
            onPress={onPress}
            disabled={isDisabled}
            className="bg-primary px-4 py-2 rounded-md items-center"
        >
            <SubmitLabel label={label} isSubmitting={isSubmitting} />
        </Pressable>
    )
}

function SubmitLabel({ label, isSubmitting }: { label: string; isSubmitting: boolean }) {
    if (isSubmitting) return <ActivityIndicator />
    return <Text className="text-primary-foreground">{label}</Text>
}
