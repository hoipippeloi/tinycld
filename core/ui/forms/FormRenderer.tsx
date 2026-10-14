import type { FormDefinition, FormField, FormPage } from '@tinycld/core/lib/forms/definition'
import type { CollabDoc, FieldMode, FormHostUi } from '@tinycld/core/lib/forms/host-ui'
import type { EvalContext, FormState, FormValues } from '@tinycld/core/lib/forms/logic'
import type { FormHost } from '@tinycld/core/lib/packages/derive-form-hosts'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { FormErrorSummary } from '@tinycld/core/ui/form'
import { type MutableRefObject, type ReactNode, useRef, useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { Pressable, Text, View } from 'react-native'
import { FieldCell } from './FieldCell'
import { FieldInput, rendersOwnLabel } from './FieldInput'
import { FormLayout } from './FormLayout'
import { useContainerWidth } from './use-container-width'
import { useFormState } from './use-form-state'
import { type LayoutRect, type MeasureRect, useMeasuredRect } from './use-measure-rect'
import type { FormSchema } from './use-schema-ref-resolver'
import { WizardSteps } from './WizardSteps'

export type FormLayoutKind = 'wizard' | 'sections' | 'design'

export interface DesignOptions {
    selectedKey?: string
    onSelect?: (key: string) => void
    renderHandle?: (key: string) => ReactNode
    /** Replaces the section title. */
    renderPageHeader?: (page: FormPage) => ReactNode
    /** After a page's fields, e.g. an "Add field" button. */
    renderPageFooter?: (page: FormPage) => ReactNode
    onCellLayout?: (key: string, rect: LayoutRect) => void
    onPageLayout?: (pageKey: string, rect: LayoutRect) => void
    /**
     * Once per mounted cell: a thunk that re-measures it now. Returns the
     * unregister function, called on unmount. `onCellLayout` misses a cell
     * that moved without resizing, so the canvas re-measures at drag start.
     */
    onCellMeasure?: (key: string, measure: MeasureRect) => () => void
    onPageMeasure?: (pageKey: string, measure: MeasureRect) => () => void
    dropTarget?: DropTarget | null
    badges?: Record<string, ReactNode>
    /** Cell error text keyed by field key, from the editor form. */
    errors?: Record<string, string>
}

export type DropTarget = { key: string; side: 'before' | 'after' } | { page: string; end: true }

function dropSideFor(target: DropTarget | null | undefined, key: string) {
    return target && 'key' in target && target.key === key ? target.side : undefined
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
    /** Enter in a single-line input; set by the wizard. */
    onSubmitEditing?: () => void
}

interface PageProps extends BodyProps {
    page: FormPage
}

interface PageChromeProps {
    page: FormPage
    design?: DesignOptions
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
    const hideLabel = rendersOwnLabel(host, field, ui)
    const onCellMeasure = design?.onCellMeasure
    const fieldState = state.fields[field.key]
    const formError = form.formState.errors[field.key]?.message
    const error =
        design?.errors?.[field.key] ?? (typeof formError === 'string' ? formError : undefined)
    const cell = (
        <FieldCell
            fieldKey={field.key}
            label={field.label}
            description={field.description}
            required={fieldState?.required ?? false}
            error={error}
            width={field.width}
            containerWidth={containerWidth}
            handle={design?.renderHandle?.(field.key)}
            isSelected={design?.selectedKey === field.key}
            hideLabel={hideLabel}
            badge={design?.badges?.[field.key]}
            dropIndicator={dropSideFor(design?.dropTarget, field.key)}
            onLayoutRect={design?.onCellLayout && (rect => design.onCellLayout?.(field.key, rect))}
            registerMeasure={onCellMeasure && (measure => onCellMeasure(field.key, measure))}
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
                onSubmitEditing={props.onSubmitEditing}
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

function PageHeader({
    page,
    isTitleVisible,
    design,
}: PageChromeProps & { isTitleVisible: boolean }) {
    const custom = design?.renderPageHeader?.(page)
    if (custom) return custom
    return <SectionTitle page={page} isVisible={isTitleVisible} />
}

function PageFooter({ page, design }: PageChromeProps) {
    return design?.renderPageFooter?.(page) ?? null
}

function PageDropBar({ page, target }: { page: FormPage; target?: DropTarget | null }) {
    if (!target || !('page' in target) || target.page !== page.key) return null
    return <View className="h-0.5 bg-primary" testID={`form-page-${page.key}-drop-end`} />
}

function DesignPage({ page, isTitleVisible, ...props }: PageProps & { isTitleVisible: boolean }) {
    const { design } = props
    const onPageMeasure = design?.onPageMeasure
    const { ref, onLayout } = useMeasuredRect(
        design?.onPageLayout && (rect => design.onPageLayout?.(page.key, rect)),
        onPageMeasure && (measure => onPageMeasure(page.key, measure))
    )
    return (
        <View ref={ref} onLayout={onLayout} testID={`form-page-${page.key}`}>
            <PageHeader page={page} isTitleVisible={isTitleVisible} design={design} />
            <PageFields {...props} page={page} />
            <PageFooter page={page} design={design} />
            <PageDropBar page={page} target={design?.dropTarget} />
        </View>
    )
}

function SubmitErrors({
    form,
    attempted = false,
}: {
    form: UseFormReturn<FormValues>
    /** A wizard Next that failed counts as an attempt, before any submit. */
    attempted?: boolean
}) {
    const { errors, isSubmitted } = form.formState
    return <FormErrorSummary errors={errors} isEnabled={isSubmitted || attempted} />
}

function Sections(props: BodyProps) {
    const { definition, state, mode } = props
    const pages = definition.pages.filter(p => mode === 'design' || state.pages[p.key]?.visible)
    return (
        <>
            <SubmitErrors form={props.form} />
            {pages.map(page => (
                <DesignPage
                    key={page.key}
                    {...props}
                    page={page}
                    isTitleVisible={pages.length > 1}
                />
            ))}
        </>
    )
}

function useWizard(props: BodyProps) {
    // The current step and whether Next failed on it: local, synchronous UI
    // state that nothing else needs.
    const [step, setStep] = useState({ index: 0, attemptedNext: false })
    const { definition, state, form, onSubmit } = props
    const pages = definition.pages.filter(p => state.pages[p.key]?.visible)
    const current = Math.min(step.index, pages.length - 1)
    const page = pages[current]
    const isLast = current >= pages.length - 1
    const pageKeys = definition.fields.filter(f => f.page === page?.key).map(f => f.key)
    // Enter on the last page reaches `next` without the footer button's
    // isDisabled, so a fast double press would otherwise submit twice.
    const inFlight = useRef(false)
    const next = async () => {
        if (inFlight.current || form.formState.isSubmitting) return
        inFlight.current = true
        try {
            const ok = await form.trigger(pageKeys)
            if (!ok) {
                setStep({ index: current, attemptedNext: true })
                return
            }
            if (isLast) await form.handleSubmit(() => onSubmit?.())()
            else setStep({ index: current + 1, attemptedNext: false })
        } finally {
            inFlight.current = false
        }
    }
    const back = () => setStep({ index: Math.max(0, current - 1), attemptedNext: false })
    return { pages, page, index: current, isLast, next, back, attemptedNext: step.attemptedNext }
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
            <SubmitErrors form={props.form} attempted={w.attemptedNext} />
            <PageFields {...props} page={w.page} onSubmitEditing={w.next} />
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
