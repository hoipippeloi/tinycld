import { PB_SERVER_ADDR } from '@tinycld/core/lib/config'
import { captureException } from '@tinycld/core/lib/errors'
import { serverFetch } from '@tinycld/core/lib/server-fetch'
import {
    FormErrorSummary,
    TextAreaInput,
    TextInput,
    useForm,
    z,
    zodResolver,
} from '@tinycld/core/ui/form'
import { forwardRef, useImperativeHandle } from 'react'
import { View } from 'react-native'

export type DemoLeadSource = 'intro_modal' | 'banner_link'

export interface DemoLeadFormProps {
    source: DemoLeadSource
}

export interface DemoLeadFormHandle {
    /**
     * Validates the form and, on success, fires `POST /api/demo/lead` (no
     * await — the call site dismisses immediately). Returns `true` if the
     * submission was kicked off and `false` if validation failed (errors are
     * surfaced inline). Caller uses the return value to decide whether to
     * dismiss the surrounding modal.
     */
    submit: () => boolean
}

export const demoLeadSchema = z.object({
    email: z.string().trim().min(1, 'Email is required').email('Enter a valid email'),
    reason: z.string().trim().max(2000).optional(),
})

type DemoLeadFormValues = z.infer<typeof demoLeadSchema>

// Fire-and-forget. Network failures are logged but not surfaced — the user
// has already left the form mentally. Address PB explicitly via
// PB_SERVER_ADDR (matching SetupPage / PackageManager) — the dev / native /
// self-hosted topologies all run PB on a different origin from the client,
// so a relative path would 404.
function postLead(data: DemoLeadFormValues, source: DemoLeadSource) {
    serverFetch(`${PB_SERVER_ADDR}/api/demo/lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: data.email, reason: data.reason ?? '', source }),
    }).catch(err => {
        captureException('demo-lead-submit', err, { source })
    })
}

export const DemoLeadForm = forwardRef<DemoLeadFormHandle, DemoLeadFormProps>(function DemoLeadForm(
    { source },
    ref
) {
    const {
        control,
        handleSubmit,
        formState: { errors, isSubmitted, isValid },
    } = useForm({
        resolver: zodResolver(demoLeadSchema),
        defaultValues: { email: '', reason: '' },
        mode: 'onChange',
    })

    useImperativeHandle(ref, () => ({
        submit: () => {
            // The surrounding modal decides whether to dismiss from the return
            // value in the same tick, but handleSubmit() resolves a tick
            // later. Under mode 'onChange' isValid is already current, so it
            // answers the dismiss question; handleSubmit then runs the
            // resolver and posts the parsed values, or surfaces the errors
            // inline when the form is invalid.
            void handleSubmit(data => postLead(data, source))()
            return isValid
        },
    }))

    return (
        <View>
            <FormErrorSummary errors={errors} isEnabled={isSubmitted} />
            <TextInput
                control={control}
                name="email"
                label="Email"
                placeholder="you@example.com"
                autoCapitalize="none"
                keyboardType="email-address"
            />
            <TextAreaInput
                control={control}
                name="reason"
                label="What brings you here?"
                placeholder="Optional — share what you're hoping to do with TinyCld."
                numberOfLines={3}
            />
        </View>
    )
})
