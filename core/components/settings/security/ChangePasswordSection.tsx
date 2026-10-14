import { SectionCard } from '@tinycld/core/components/settings/SectionCard'
import { changeMyPassword } from '@tinycld/core/lib/account-password'
import { useAuth } from '@tinycld/core/lib/auth'
import { handleMutationErrorsWithForm } from '@tinycld/core/lib/errors'
import { useMutation } from '@tinycld/core/lib/mutations'
import { notify } from '@tinycld/core/lib/notify'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Button, ButtonText, ServerActionButton } from '@tinycld/core/ui/button'
import { FormErrorSummary, TextInput, useForm, z, zodResolver } from '@tinycld/core/ui/form'
import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'

const passwordSchema = z
    .object({
        oldPassword: z.string().min(1, 'Current password is required'),
        password: z.string().min(8, 'New password must be at least 8 characters'),
        passwordConfirm: z.string().min(1, 'Please confirm your new password'),
    })
    .refine(data => data.password === data.passwordConfirm, {
        path: ['passwordConfirm'],
        message: 'Passwords do not match',
    })

export function ChangePasswordSection() {
    const [isOpen, setIsOpen] = useState(false)

    if (!isOpen) {
        return (
            <Pressable
                onPress={() => setIsOpen(true)}
                className="self-start rounded-lg px-3 py-2 border border-border"
            >
                <Text className="text-foreground font-semibold">Change password</Text>
            </Pressable>
        )
    }

    return <ChangePasswordForm onDone={() => setIsOpen(false)} />
}

function ChangePasswordForm({ onDone }: { onDone: () => void }) {
    const { user } = useAuth()
    const primaryFg = useThemeColor('primary-foreground')

    const {
        control,
        setError,
        getValues,
        handleSubmit,
        reset,
        formState: { errors, isSubmitted },
    } = useForm({
        resolver: zodResolver(passwordSchema),
        defaultValues: { oldPassword: '', password: '', passwordConfirm: '' },
    })

    const change = useMutation({
        mutationFn: (data: z.infer<typeof passwordSchema>) =>
            changeMyPassword({
                email: user.email,
                oldPassword: data.oldPassword,
                newPassword: data.password,
                passwordConfirm: data.passwordConfirm,
            }),
        onSuccess: () => {
            notify.emit({ event: 'account.password_changed', title: 'Password changed' })
            reset()
            onDone()
        },
        onError: handleMutationErrorsWithForm({
            setError,
            getValues,
            operation: 'change-password',
        }),
    })

    const handleCancel = () => {
        if (change.isPending) return
        reset()
        onDone()
    }

    const submit = handleSubmit(data => change.mutate(data))

    return (
        <SectionCard>
            <View className="gap-1">
                <FormErrorSummary errors={errors} isEnabled={isSubmitted} />

                <TextInput
                    control={control}
                    name="oldPassword"
                    label="Current password"
                    secureTextEntry
                    autoComplete="current-password"
                    textContentType="password"
                />
                <TextInput
                    control={control}
                    name="password"
                    label="New password"
                    hint="At least 8 characters"
                    secureTextEntry
                    autoComplete="new-password"
                    textContentType="newPassword"
                />
                <TextInput
                    control={control}
                    name="passwordConfirm"
                    label="Confirm new password"
                    secureTextEntry
                    autoComplete="new-password"
                    textContentType="newPassword"
                />

                <View className="flex-row gap-3 mt-1">
                    <ServerActionButton onPress={submit} isDisabled={change.isPending}>
                        {change.isPending ? (
                            <ActivityIndicator size="small" color={primaryFg} />
                        ) : (
                            <ButtonText>Save</ButtonText>
                        )}
                    </ServerActionButton>
                    <Button variant="outline" onPress={handleCancel} isDisabled={change.isPending}>
                        <ButtonText>Cancel</ButtonText>
                    </Button>
                </View>
            </View>
        </SectionCard>
    )
}
