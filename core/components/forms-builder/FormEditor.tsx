import { HelpIcon } from '@tinycld/core/components/help/HelpIcon'
import { SetupTabs } from '@tinycld/core/components/setup/wizard/SetupTabs'
import { useAuth } from '@tinycld/core/lib/auth'
import { toDateString } from '@tinycld/core/lib/dates'
import type { EvalContext } from '@tinycld/core/lib/forms/logic'
import { log } from '@tinycld/core/lib/logger'
import { useOrgHref } from '@tinycld/core/lib/org-routes'
import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { useNavigateBack } from '@tinycld/core/lib/use-navigate-back'
import { Button, ButtonText, ServerActionButton } from '@tinycld/core/ui/button'
import { ConfirmDialog } from '@tinycld/core/ui/ConfirmDialog'
import { FormErrorSummary } from '@tinycld/core/ui/form'
import { ArrowLeft } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { Canvas, useEditorCanvasDrag } from './Canvas'
import { EditorPanel } from './EditorPanel'
import { FieldProperties } from './FieldProperties'
import { PreviewDialog } from './PreviewDialog'
import { RulesTab } from './RulesTab'
import type { CanvasDrag } from './use-canvas-drag'
import { useEditorForm } from './use-editor-form'

type Editor = ReturnType<typeof useEditorForm>
type Tab = 'fields' | 'rules'

const TABS = [
    { value: 'fields', label: 'Fields' },
    { value: 'rules', label: 'Rules' },
] as const

function useFormEditor(formId: string) {
    const editor = useEditorForm(formId)
    const drag = useEditorCanvasDrag(editor)
    const { user } = useAuth()
    const orgHref = useOrgHref()
    const navigateBack = useNavigateBack(() => orgHref('settings/forms'))
    // Active tab and which dialog is open are local UI state.
    const [tab, setTab] = useState<Tab>('fields')
    const [isPreviewing, setIsPreviewing] = useState(false)
    const [isConfirmingLeave, setIsConfirmingLeave] = useState(false)
    const context: EvalContext = { today: toDateString(new Date()), userId: user.id }
    const back = () => {
        if (editor.isDirty) setIsConfirmingLeave(true)
        else navigateBack()
    }
    const discard = () => {
        setIsConfirmingLeave(false)
        navigateBack()
    }
    const save = () => {
        editor.save().catch(error => {
            log.error('forms.editor', error, { formId })
            editor.form.setError('root', {
                type: 'server',
                message: 'The form could not be saved. Try again.',
            })
        })
    }
    return {
        editor,
        drag,
        context,
        tab,
        setTab,
        isPreviewing,
        openPreview: () => setIsPreviewing(true),
        closePreview: () => setIsPreviewing(false),
        isConfirmingLeave,
        cancelLeave: () => setIsConfirmingLeave(false),
        back,
        discard,
        save,
    }
}

function Notice({ text, onDismiss }: { text: string | null; onDismiss: () => void }) {
    if (!text) return null
    return (
        <Pressable
            onPress={onDismiss}
            accessibilityLabel="Dismiss"
            className="bg-muted rounded-md px-3 py-2 mb-2"
            testID="form-notice"
        >
            <Text className="text-foreground text-sm">{text}</Text>
        </Pressable>
    )
}

interface HeaderProps {
    title: string
    isDirty: boolean
    isSaving: boolean
    onBack: () => void
    onPreview: () => void
    onSave: () => void
}

function EditorHeader({ title, isDirty, isSaving, onBack, onPreview, onSave }: HeaderProps) {
    const fg = useThemeColor('foreground')
    return (
        <View className="flex-row items-center gap-3 p-5 pb-2">
            <Pressable onPress={onBack} accessibilityLabel="Back" testID="form-back">
                <ArrowLeft size={24} color={fg} />
            </Pressable>
            <Text className="text-foreground text-[22px] font-bold flex-1" numberOfLines={1}>
                {title}
            </Text>
            <HelpIcon topic="core:forms" />
            <Button variant="outline" size="sm" onPress={onPreview} testID="form-preview">
                <ButtonText>Preview</ButtonText>
            </Button>
            <ServerActionButton
                size="sm"
                onPress={onSave}
                isDisabled={!isDirty || isSaving}
                testID="form-save"
            >
                <ButtonText>{isSaving ? 'Saving…' : 'Save'}</ButtonText>
            </ServerActionButton>
        </View>
    )
}

interface TabBodyProps {
    editor: Editor
    context: EvalContext
    drag: CanvasDrag
    isVisible: boolean
}

function FieldsTab({ editor, context, drag, isVisible }: TabBodyProps) {
    if (!isVisible) return null
    return <Canvas editor={editor} context={context} drag={drag} />
}

function SelectedProperties({ editor }: { editor: Editor }) {
    if (!editor.selectedKey) return null
    return <FieldProperties editor={editor} fieldKey={editor.selectedKey} />
}

export function FormEditor({ formId }: { formId: string }) {
    const s = useFormEditor(formId)
    const { editor, drag } = s
    if (!editor.isReady || !editor.row) return null
    const isPanelOpen = s.tab === 'fields' && editor.selectedKey !== null
    return (
        <View className="flex-1 bg-background" testID="form-editor">
            <EditorHeader
                title={editor.row.name}
                isDirty={editor.isDirty}
                isSaving={editor.isSaving}
                onBack={s.back}
                onPreview={s.openPreview}
                onSave={s.save}
            />
            <View className="px-5">
                <SetupTabs tabs={TABS} value={s.tab} onChange={s.setTab} testID="form-tab" />
                <FormErrorSummary
                    errors={editor.form.formState.errors}
                    isEnabled
                    title="The form cannot be saved yet"
                    showFieldNames
                />
                <Notice text={editor.notice} onDismiss={editor.dismissNotice} />
            </View>
            <View className="flex-1 flex-row px-5">
                <ScrollView
                    className="flex-1"
                    onScroll={drag.onScroll}
                    scrollEventThrottle={16}
                    scrollEnabled={!drag.draggingKey}
                >
                    <FieldsTab
                        editor={editor}
                        context={s.context}
                        drag={drag}
                        isVisible={s.tab === 'fields'}
                    />
                    <RulesTab editor={editor} isVisible={s.tab === 'rules'} />
                </ScrollView>
                <EditorPanel isOpen={isPanelOpen} onClose={() => editor.select(null)} title="Field">
                    <SelectedProperties editor={editor} />
                </EditorPanel>
            </View>
            <PreviewDialog
                editor={editor}
                context={s.context}
                isOpen={s.isPreviewing}
                onClose={s.closePreview}
            />
            <ConfirmDialog
                isOpen={s.isConfirmingLeave}
                onClose={s.cancelLeave}
                onConfirm={s.discard}
                title="Discard changes?"
                message="This form has changes that are not saved."
                confirmLabel="Discard"
                isDestructive
                requiresServer={false}
            />
        </View>
    )
}
