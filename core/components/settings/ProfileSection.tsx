import { AvatarSection } from '@tinycld/core/components/settings/AvatarSection'
import { useAuth } from '@tinycld/core/lib/auth'
import { handleMutationErrorsWithForm } from '@tinycld/core/lib/errors'
import { mutation, useMutation } from '@tinycld/core/lib/mutations'
import { useStore } from '@tinycld/core/lib/pocketbase'
import { FormErrorSummary, TextInput, useForm, z, zodResolver } from '@tinycld/core/ui/form'
import { View } from 'react-native'

const profileSchema = z.object({
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Valid email is required'),
})

export function ProfileSection() {
    const { user } = useAuth()
    const [usersCollection] = useStore('users')

    const {
        control,
        setError,
        getValues,
        handleSubmit,
        formState: { errors, isSubmitted, isDirty },
    } = useForm({
        mode: 'onChange',
        resolver: zodResolver(profileSchema),
        values: { name: user.name, email: user.email },
    })

    const updateProfile = useMutation({
        mutationFn: mutation(function* (data: z.infer<typeof profileSchema>) {
            yield usersCollection.update(user.id, draft => {
                draft.name = data.name.trim()
                draft.email = data.email.trim()
            })
        }),
        onError: handleMutationErrorsWithForm({ setError, getValues }),
    })

    const saveIfValid = handleSubmit(data => {
        if (!isDirty) return
        updateProfile.mutate(data)
    })

    return (
        <View className="gap-3">
            <AvatarSection />

            <FormErrorSummary errors={errors} isEnabled={isSubmitted} />

            <View className="gap-4">
                <TextInput control={control} name="name" label="Name" onBlur={saveIfValid} />
                <TextInput
                    control={control}
                    name="email"
                    label="Recovery Email"
                    hint="Where invitations and password reset links go. You do not sign in with it: sign in with your username or an email address this server hosts for you."
                    onBlur={saveIfValid}
                />
            </View>
        </View>
    )
}
