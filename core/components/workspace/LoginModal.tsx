import { ChangeServerLink } from '@tinycld/core/components/ChangeServerLink'
import { ReviewModeHints } from '@tinycld/core/components/connect/ReviewModeHints'
import { OrgLogo } from '@tinycld/core/components/OrgLogo'
import { loginSchema, resetRequestSchema } from '@tinycld/core/components/workspace/login-schemas'
import { EnrollStep } from '@tinycld/core/components/workspace/sign-in/EnrollStep'
import { MfaStep } from '@tinycld/core/components/workspace/sign-in/MfaStep'
import { PasskeySignInButton } from '@tinycld/core/components/workspace/sign-in/PasskeySignInButton'
import { requestPasswordReset } from '@tinycld/core/lib/account-password'
import { useAuth } from '@tinycld/core/lib/auth'
import { passkeys } from '@tinycld/core/lib/passkey'
import { takePendingRoute } from '@tinycld/core/lib/pending-route'
import type { SignInStep } from '@tinycld/core/lib/sign-in-step'
import {
    useSignInNotice,
    useSignInNoticeStore,
} from '@tinycld/core/lib/stores/sign-in-notice-store'
import { useSignInStepStore } from '@tinycld/core/lib/stores/sign-in-step-store'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import type { OrgBranding as OrgBrandingInfo } from '@tinycld/core/lib/use-org-info'
import { useOrgInfo } from '@tinycld/core/lib/use-org-info'
import { useDeviceInsets } from '@tinycld/core/lib/use-safe-area'
import { ButtonText, ServerActionButton } from '@tinycld/core/ui/button'
import {
    type Control,
    Controller,
    isFormSubmittable,
    useForm,
    zodResolver,
} from '@tinycld/core/ui/form'
import { router } from 'expo-router'
import { useState } from 'react'
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    Text,
    TextInput,
    View,
} from 'react-native'

type Mode = 'login' | 'reset'

export function LoginModal() {
    const backdropColor = useThemeColor('overlay-backdrop')
    const [mode, setMode] = useState<Mode>('login')
    const insets = useDeviceInsets()
    // The server asked for a second step; it replaces the password form until
    // the step finishes or the user goes back.
    const step = useSignInStepStore(s => s.step)

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            className="absolute top-0 left-0 right-0 bottom-0 justify-center items-center"
            style={{
                zIndex: 200,
                backgroundColor: backdropColor,
                // The backdrop deliberately still covers the full screen — only
                // the card is inset. In landscape the sensor housing sits on one
                // side (~59pt), so a centred card can otherwise have its edge
                // clipped by the notch on a narrow window.
                paddingLeft: insets.left,
                paddingRight: insets.right,
                paddingTop: insets.top,
                paddingBottom: insets.bottom,
            }}
        >
            <View
                className="rounded-2xl border border-border p-8 bg-background"
                style={{
                    width: 400,
                    maxWidth: '90%',
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 8 },
                    shadowOpacity: 0.15,
                    shadowRadius: 24,
                    elevation: 8,
                }}
            >
                <SignInStepView step={step} />
                <LoginForm
                    isVisible={!step && mode === 'login'}
                    onForgotPassword={() => setMode('reset')}
                />
                <ResetForm isVisible={!step && mode === 'reset'} onBack={() => setMode('login')} />
            </View>
        </KeyboardAvoidingView>
    )
}

function useLoginForm() {
    const { login } = useAuth({ throwIfAnon: false })
    const clearNotice = useSignInNoticeStore(s => s.clear)
    const form = useForm({
        resolver: zodResolver(loginSchema),
        defaultValues: { identifier: '', password: '' },
        mode: 'onChange',
    })

    const onSubmit = form.handleSubmit(async ({ identifier, password }) => {
        const result = await login(identifier, password)
        if (result.error) {
            form.setError('root', { type: 'server', message: result.error })
            return
        }
        // A second step (code, passkey or enrollment) now shows in place of
        // this form. The password is cleared so it does not sit in the form.
        if (result.step) {
            form.reset({ identifier, password: '' })
            return
        }
        if (!result.user) return
        // The notice (if any) explained why this sign-in was needed; a
        // fresh session no longer needs the explanation, and it must not
        // reappear if this user is later routed back to sign-in for an
        // unrelated reason.
        clearNotice()
        // Return to whatever route the gate interrupted — a deep link, or
        // the screen an expired session flipped out from under the user.
        // Recorded by AuthGate; replace (not push) so the sign-in overlay
        // isn't a back-button destination. Nothing to return to: send every
        // signed-in user to the app root.
        router.replace(takePendingRoute() ?? '/')
    })

    const prefill = (identifier: string, password: string) => {
        form.setValue('identifier', identifier, { shouldValidate: true })
        form.setValue('password', password, { shouldValidate: true })
    }

    const { isSubmitting, isSubmitSuccessful, isValid, errors } = form.formState
    // A successful sign-in stays busy until the route change unmounts the form.
    const isBusy = isSubmitting || isSubmitSuccessful
    const canSubmit = isFormSubmittable({ isValid, errors }) && !isBusy

    return {
        control: form.control,
        // The button disables itself; this also stops the Enter key.
        onSubmit: () => {
            if (canSubmit) onSubmit()
        },
        prefill,
        isBusy,
        canSubmit,
        error: errors.root?.message ?? null,
    }
}

function LoginForm({
    isVisible,
    onForgotPassword,
}: {
    isVisible: boolean
    onForgotPassword: () => void
}) {
    const mutedColor = useThemeColor('muted-foreground')
    const primaryFg = useThemeColor('primary-foreground')
    const notice = useSignInNotice()
    // Pre-auth: reads the unauthenticated /api/org-info endpoint, so it
    // resolves fine before the user signs in. `org` is null while loading or
    // on an unbranded deployment — OrgBranding degrades to nothing rather
    // than an empty circle in that case.
    const { org } = useOrgInfo()
    const { control, onSubmit, prefill, isBusy, canSubmit, error } = useLoginForm()

    if (!isVisible) return null

    return (
        <>
            <OrgBranding org={org} />

            <Text className="text-[22px] font-bold mb-1 text-foreground">Sign in</Text>
            <Text className="text-sm mb-6 text-muted-foreground">
                Sign in to your account to continue
            </Text>

            <SignInNotice isVisible={!!notice} notice={notice} />

            <SignInError isVisible={!!error} error={error} />

            <View className="mb-4">
                <Text className="mb-1.5 text-sm font-semibold text-foreground">
                    Username or email
                </Text>
                <Controller
                    control={control}
                    name="identifier"
                    render={({ field }) => (
                        <TextInput
                            className="border border-border rounded-lg p-3 text-base text-foreground bg-surface-secondary"
                            testID="identifier"
                            value={field.value}
                            onChangeText={field.onChange}
                            onBlur={field.onBlur}
                            placeholder="alice or alice@company.com"
                            placeholderTextColor={mutedColor}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="username"
                            editable={!isBusy}
                        />
                    )}
                />
            </View>

            <View className="mb-2">
                <Text className="mb-1.5 text-sm font-semibold text-foreground">Password</Text>
                <Controller
                    control={control}
                    name="password"
                    render={({ field }) => (
                        <TextInput
                            className="border border-border rounded-lg p-3 text-base text-foreground bg-surface-secondary"
                            testID="login-password"
                            value={field.value}
                            onChangeText={field.onChange}
                            onBlur={field.onBlur}
                            placeholder="Password"
                            placeholderTextColor={mutedColor}
                            secureTextEntry
                            autoComplete="current-password"
                            editable={!isBusy}
                            onSubmitEditing={onSubmit}
                        />
                    )}
                />
            </View>

            <ServerActionButton
                testID="login-submit"
                className="mt-4 w-full"
                onPress={onSubmit}
                isDisabled={!canSubmit}
            >
                <SubmitLabel isBusy={isBusy} color={primaryFg} label="Sign in" />
            </ServerActionButton>

            <View className="mt-3">
                <PasskeySignInButton
                    isVisible
                    testID="login-passkey"
                    label="Sign in with a passkey"
                    run={passkeys.signIn}
                />
            </View>

            <ReviewModeHints onPrefill={prefill} />

            <View className="mt-4 flex-row justify-around">
                <Pressable
                    testID="forgot-password-link"
                    accessibilityRole="link"
                    onPress={onForgotPassword}
                >
                    <Text className="text-xs text-muted-foreground underline">
                        Forgot password?
                    </Text>
                </Pressable>
                <ChangeServerLink />
            </View>
        </>
    )
}

function SignInStepView({ step }: { step: SignInStep | null }) {
    if (step?.kind === 'mfa') return <MfaStep step={step} />
    if (step?.kind === 'enroll') return <EnrollStep step={step} />
    return null
}

function SubmitLabel({ isBusy, color, label }: { isBusy: boolean; color: string; label: string }) {
    if (isBusy) return <ActivityIndicator color={color} size="small" />
    return <ButtonText>{label}</ButtonText>
}

function SignInNotice({ isVisible, notice }: { isVisible: boolean; notice: string | null }) {
    if (!isVisible) return null

    return (
        <View className="rounded-lg p-3 mb-4 bg-info-soft" testID="sign-in-notice">
            <Text className="text-sm text-info">{notice}</Text>
        </View>
    )
}

function SignInError({ isVisible, error }: { isVisible: boolean; error: string | null }) {
    if (!isVisible) return null

    return (
        <View className="rounded-lg p-3 mb-4 bg-danger-soft" testID="sign-in-error">
            <Text className="text-sm text-danger">{error}</Text>
        </View>
    )
}

// Exercises the same pre-login rendering path org_branding's public read
// rule exists for. Renders nothing when org is null (loading, or a
// deployment with no server-reported name) rather than an empty circle.
function OrgBranding({ org }: { org: OrgBrandingInfo | null }) {
    if (!org) return null

    return (
        <View className="items-center mb-4">
            <OrgLogo org={org} size={52} />
            <Text className="text-sm font-semibold mt-2 text-foreground">{org.name}</Text>
        </View>
    )
}

function useResetRequestForm() {
    const form = useForm({
        resolver: zodResolver(resetRequestSchema),
        defaultValues: { email: '' },
        mode: 'onChange',
    })

    // requestPasswordReset never throws and never reveals whether the email
    // exists — we always land on the same confirmation.
    const onSubmit = form.handleSubmit(({ email }) => requestPasswordReset(email))

    const { isSubmitting, isSubmitSuccessful, isValid } = form.formState
    const canSubmit = isValid && !isSubmitting
    return {
        control: form.control,
        // The button disables itself; this also stops the Enter key.
        onSubmit: () => {
            if (canSubmit) onSubmit()
        },
        isSubmitting,
        isSent: isSubmitSuccessful,
        canSubmit,
    }
}

function ResetForm({ isVisible, onBack }: { isVisible: boolean; onBack: () => void }) {
    const primaryFg = useThemeColor('primary-foreground')
    const { control, onSubmit, isSubmitting, isSent, canSubmit } = useResetRequestForm()

    if (!isVisible) return null

    return (
        <>
            <Text className="text-[22px] font-bold mb-1 text-foreground">Reset password</Text>
            <Text className="text-sm mb-6 text-muted-foreground">
                Enter your email and we'll send you a reset link
            </Text>

            <ResetSentNotice isVisible={isSent} />
            <ResetEmailField
                isVisible={!isSent}
                control={control}
                isSubmitting={isSubmitting}
                onSubmit={onSubmit}
            />
            <ResetSubmitButton
                isVisible={!isSent}
                isSubmitting={isSubmitting}
                isDisabled={!canSubmit}
                color={primaryFg}
                onSubmit={onSubmit}
            />

            <Pressable
                testID="reset-back"
                accessibilityRole="link"
                onPress={onBack}
                className="mt-4 items-center"
            >
                <Text className="text-xs text-muted-foreground underline">Back to sign in</Text>
            </Pressable>
        </>
    )
}

function ResetSentNotice({ isVisible }: { isVisible: boolean }) {
    if (!isVisible) return null
    return (
        <View className="rounded-lg p-3 mb-4 bg-surface-secondary" testID="reset-sent">
            <Text className="text-sm text-foreground">
                If an account exists for that email, we've sent a reset link. Check your inbox.
            </Text>
        </View>
    )
}

type ResetEmailFieldProps = {
    isVisible: boolean
    control: Control<{ email: string }>
    isSubmitting: boolean
    onSubmit: () => void
}

function ResetEmailField({ isVisible, control, isSubmitting, onSubmit }: ResetEmailFieldProps) {
    const mutedColor = useThemeColor('muted-foreground')
    if (!isVisible) return null
    return (
        <View className="mb-2">
            <Text className="mb-1.5 text-sm font-semibold text-foreground">Email</Text>
            <Controller
                control={control}
                name="email"
                render={({ field, fieldState }) => (
                    <>
                        <TextInput
                            className="border border-border rounded-lg p-3 text-base text-foreground bg-surface-secondary"
                            testID="reset-email"
                            value={field.value}
                            onChangeText={field.onChange}
                            onBlur={field.onBlur}
                            placeholder="alice@company.com"
                            placeholderTextColor={mutedColor}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="email-address"
                            autoComplete="email"
                            editable={!isSubmitting}
                            onSubmitEditing={onSubmit}
                        />
                        <TouchedFieldError
                            isTouched={fieldState.isTouched}
                            message={fieldState.error?.message}
                        />
                    </>
                )}
            />
        </View>
    )
}

// Shown once the person leaves the field, so a half-typed address does not
// flag an error on every keystroke; until then the disabled button is the cue.
function TouchedFieldError({ isTouched, message }: { isTouched: boolean; message?: string }) {
    if (!isTouched || !message) return null
    return <Text className="mt-1 text-xs text-danger">{message}</Text>
}

type ResetSubmitButtonProps = {
    isVisible: boolean
    isSubmitting: boolean
    isDisabled: boolean
    color: string
    onSubmit: () => void
}

function ResetSubmitButton({
    isVisible,
    isSubmitting,
    isDisabled,
    color,
    onSubmit,
}: ResetSubmitButtonProps) {
    if (!isVisible) return null
    return (
        <ServerActionButton
            testID="reset-submit"
            className="mt-2 w-full"
            onPress={onSubmit}
            isDisabled={isDisabled}
        >
            <SubmitLabel isBusy={isSubmitting} color={color} label="Send reset link" />
        </ServerActionButton>
    )
}
