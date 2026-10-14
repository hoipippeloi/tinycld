import type { FormDefinition, FormField, FormPage } from '@tinycld/core/lib/forms/definition'
import type { CollabDoc, FieldMode, FormHostUi } from '@tinycld/core/lib/forms/host-ui'
import type { EvalContext, FormState, FormValues } from '@tinycld/core/lib/forms/logic'
import type { FormHost } from '@tinycld/core/lib/packages/derive-form-hosts'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { FormErrorSummary } from '@tinycld/core/ui/form'
import { type MutableRefObject, type ReactNode, useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { Pressable, Text, View } from 'react-native'
import { FieldCell } from './FieldCell'
import { FieldInput } from './FieldInput'
import { FormLayout } from './FormLayout'
import { useContainerWidth } from './use-container-width'
import { useFormState } from './use-form-state'
import type { FormSchema } from './use-schema-ref-resolver'
import { WizardSteps } from './WizardSteps'

export type FormLayoutKind = 'wizard' | 'sections' | 'design'

export interface DesignOptions {
    selectedKey?: string
    onSelect?: (key: string) => void
    renderHandle?: (key: string) => ReactNode
}

export interface FormRendererProps {
    host: FormHost
    ui: FormHostUi | null
    definition: FormDefinition
    layout: FormLayoutKind
    form: UseFormReturn<FormValues>
    context: EvalContext
    recordId?: string
    readOnly?: boolean
    collab?: CollabDoc | null
    /** Wizard: called after the last page validates. */
    onSubmit?: () => void
    submitLabel?: string
    design?: DesignOptions
    /** Kept current with the effective schema; see useSchemaRefResolver. */
    schemaRef?: MutableRefObject<FormSchema>
    testID?: string
}

interface BodyProps extends FormRendererProps {
    state: FormState
    containerWidth: number
    mode: FieldMode
}

interface PageProps extends BodyProps {
    page: FormPage
}

interface CellProps extends BodyProps {
    field: FormField
}

function visibleFieldsOf(
    def: FormDefinition,
    page: FormPage,
    state: FormState,
    mode: FieldMode
): FormField[] {
    return def.fields.filter(
        f => f.page === page.key && (mode === 'design' || state.fields[f.key]?.visible)
    )
}

function Cell(props: CellProps) {
    const { field, state, containerWidth, host, ui, form, mode, recordId, collab, design } = props
    const fieldState = state.fields[field.key]
    const error = form.formState.errors[field.key]?.message
    const cell = (
        <FieldCell
            fieldKey={field.key}
            label={field.label}
            description={field.description}
            required={fieldState?.required ?? false}
            error={typeof error === 'string' ? error : undefined}
            width={field.width}
            containerWidth={containerWidth}
            handle={design?.renderHandle?.(field.key)}
            isSelected={design?.selectedKey === field.key}
        >
            <FieldInput
                host={host}
                ui={ui}
                field={field}
                control={form.control}
                mode={mode}
                recordId={recordId}
                options={fieldState?.options}
                collab={collab}
            />
        </FieldCell>
    )
    if (mode !== 'design') return cell
    return <Pressable onPress={() => design?.onSelect?.(field.key)}>{cell}</Pressable>
}

function PageFields(props: PageProps) {
    const fields = visibleFieldsOf(props.definition, props.page, props.state, props.mode)
    return (
        <FormLayout>
            {fields.map(f => (
                <Cell key={f.key} {...props} field={f} />
            ))}
        </FormLayout>
    )
}

function PageDescription({ text }: { text?: string }) {
    if (!text) return null
    return <Text className="text-xs text-muted-foreground mt-0.5">{text}</Text>
}

function SectionTitle({ page, isVisible }: { page: FormPage; isVisible: boolean }) {
    if (!isVisible) return null
    return (
        <View className="mt-4 mb-2">
            <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {page.title}
            </Text>
            <PageDescription text={page.description} />
        </View>
    )
}

function SubmitErrors({ form }: { form: UseFormReturn<FormValues> }) {
    const { errors, isSubmitted } = form.formState
    return <FormErrorSummary errors={errors} isEnabled={isSubmitted} />
}

function Sections(props: BodyProps) {
    const { definition, state, mode } = props
    const pages = definition.pages.filter(p => mode === 'design' || state.pages[p.key]?.visible)
    return (
        <>
            <SubmitErrors form={props.form} />
            {pages.map(page => (
                <View key={page.key}>
                    <SectionTitle page={page} isVisible={pages.length > 1} />
                    <PageFields {...props} page={page} />
                </View>
            ))}
        </>
    )
}

function useWizard(props: BodyProps) {
    // The current step is local, synchronous UI state: nothing else needs it.
    const [index, setIndex] = useState(0)
    const { definition, state, form, onSubmit } = props
    const pages = definition.pages.filter(p => state.pages[p.key]?.visible)
    const current = Math.min(index, pages.length - 1)
    const page = pages[current]
    const isLast = current >= pages.length - 1
    const pageKeys = definition.fields.filter(f => f.page === page?.key).map(f => f.key)
    const next = async () => {
        const ok = await form.trigger(pageKeys)
        if (!ok) return
        if (isLast) await form.handleSubmit(() => onSubmit?.())()
        else setIndex(current + 1)
    }
    const back = () => setIndex(Math.max(0, current - 1))
    return { pages, page, index: current, isLast, next, back }
}

function BackButton({ isVisible, onPress }: { isVisible: boolean; onPress: () => void }) {
    if (!isVisible) return null
    return (
        <Button variant="outline" onPress={onPress} className="mr-2" testID="form-wizard-back">
            <ButtonText>Back</ButtonText>
        </Button>
    )
}

interface WizardFooterProps {
    isFirst: boolean
    isLast: boolean
    onBack: () => void
    onNext: () => void
    isSubmitting: boolean
    submitLabel: string
}

function WizardFooter(props: WizardFooterProps) {
    const { isFirst, isLast, onBack, onNext, isSubmitting, submitLabel } = props
    return (
        <View className="flex-row justify-end mt-2">
            <BackButton isVisible={!isFirst} onPress={onBack} />
            <Button onPress={onNext} isDisabled={isSubmitting} testID="form-wizard-next">
                <ButtonText>{isLast ? submitLabel : 'Next'}</ButtonText>
            </Button>
        </View>
    )
}

function Wizard(props: BodyProps) {
    const w = useWizard(props)
    const { formState } = props.form
    if (!w.page) return null
    return (
        <View>
            <WizardSteps pages={w.pages} index={w.index} />
            <SubmitErrors form={props.form} />
            <PageFields {...props} page={w.page} />
            <WizardFooter
                isFirst={w.index === 0}
                isLast={w.isLast}
                onBack={w.back}
                onNext={w.next}
                isSubmitting={formState.isSubmitting}
                submitLabel={props.submitLabel ?? 'Create'}
            />
        </View>
    )
}

function modeFor(layout: FormLayoutKind, readOnly?: boolean, recordId?: string): FieldMode {
    if (layout === 'design') return 'design'
    if (readOnly) return 'read'
    return recordId ? 'edit' : 'create'
}

function Body(props: BodyProps) {
    if (props.layout === 'wizard') return <Wizard {...props} />
    return <Sections {...props} />
}

export function FormRenderer(props: FormRendererProps) {
    const { definition, host, form, context, layout, readOnly, recordId, schemaRef } = props
    const { width, onLayout } = useContainerWidth()
    const mode = modeFor(layout, readOnly, recordId)
    const isEditable = mode === 'create' || mode === 'edit'
    const { state, schema } = useFormState(
        definition,
        host,
        form.control,
        context,
        isEditable ? form.setValue : undefined
    )
    // The resolver reads this ref, so required-if rules validate against the live state.
    if (schemaRef) schemaRef.current = schema
    return (
        <View onLayout={onLayout} testID={props.testID ?? 'form-renderer'}>
            <Body {...props} state={state} containerWidth={width} mode={mode} />
        </View>
    )
}
