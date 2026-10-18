import { MatchPillPair } from '@tinycld/core/components/rules/MatchPillPair'
import { RuleCard } from '@tinycld/core/components/rules/RuleCard'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import type { ReactNode } from 'react'
import { useFieldArray, useFormState, useWatch } from 'react-hook-form'
import { Pressable, Text, View } from 'react-native'
import { ActionEditor } from './ActionEditor'
import { ConditionEditor, conditionFields, firstOperator } from './ConditionEditor'
import { firstMessage } from './editor-errors'
import { RemoveButton } from './rule-parts'
import type { useEditorForm } from './use-editor-form'

type Editor = ReturnType<typeof useEditorForm>

export interface RuleEditorProps {
    editor: Editor
    index: number
    /** The affected-fields pane is beside the rules, so a rule can be chosen for it. */
    isSelectable: boolean
    isSelected: boolean
    onSelect: () => void
    onRemove: () => void
}

function AddButton({
    label,
    onPress,
    testID,
}: {
    label: string
    onPress: () => void
    testID: string
}) {
    return (
        <Button variant="ghost" size="sm" onPress={onPress} className="self-start" testID={testID}>
            <ButtonText>{label}</ButtonText>
        </Button>
    )
}

interface ShellProps {
    isSelectable: boolean
    isSelected: boolean
    onSelect: () => void
    testID: string
    children: ReactNode
}

/**
 * Where the pane shows, a press anywhere in the card picks the rule, a press
 * on a control inside it included (pointerdown and focus reach the shell
 * before the control handles the press). The shell is not an accessible
 * element itself: its controls are.
 */
function RuleShell({ isSelectable, isSelected, onSelect, testID, children }: ShellProps) {
    if (!isSelectable)
        return (
            <View className="mb-3" testID={testID}>
                {children}
            </View>
        )
    // The same border tokens as a selected canvas cell; always present so selecting never shifts layout.
    const border = isSelected ? 'border-primary' : 'border-transparent'
    return (
        <Pressable
            onPress={onSelect}
            onPointerDown={onSelect}
            onFocus={onSelect}
            accessible={false}
            className={`rounded-xl border-2 mb-3 ${border}`}
            testID={testID}
        >
            {children}
        </Pressable>
    )
}

/** The first thing wrong with the rule, in its card, so it is found where it is fixed. */
function RuleError({ message, testID }: { message: string | undefined; testID: string }) {
    if (!message) return null
    return (
        <Text className="text-xs text-danger" accessibilityRole="alert" testID={testID}>
            {message}
        </Text>
    )
}

function useRuleEditor(editor: Editor, index: number) {
    const { control } = editor.form
    const { errors } = useFormState({ control, name: `rules.${index}` })
    const error = firstMessage(errors.rules?.[index])
    const match = useWatch({ control, name: `rules.${index}.match` }) ?? 'all'
    const when = useFieldArray({ control, name: `rules.${index}.when` })
    const actions = useFieldArray({ control, name: `rules.${index}.actions` })
    const addCondition = () => {
        const draft = editor.form.getValues()
        const first = editor.host ? conditionFields(draft, editor.host)[0] : undefined
        if (!first || !editor.host) return
        when.append({
            field: first.key,
            op: firstOperator(draft, editor.host, first.key),
            value: undefined,
        })
    }
    const addAction = () => {
        const first = editor.form.getValues('fields')[0]
        if (first) actions.append({ action: 'show', field: first.key })
    }
    const setMatch = (next: 'all' | 'any') =>
        editor.form.setValue(`rules.${index}.match`, next, { shouldDirty: true })
    return { match, setMatch, when, actions, addCondition, addAction, error }
}

export function RuleEditor({
    editor,
    index,
    isSelectable,
    isSelected,
    onSelect,
    onRemove,
}: RuleEditorProps) {
    const rule = useRuleEditor(editor, index)
    const conditions = rule.when.fields.map((row, i) => (
        <ConditionEditor
            key={row.id}
            editor={editor}
            ruleIndex={index}
            index={i}
            onRemove={() => rule.when.remove(i)}
        />
    ))
    const actions = rule.actions.fields.map((row, i) => (
        <ActionEditor
            key={row.id}
            editor={editor}
            ruleIndex={index}
            index={i}
            onRemove={() => rule.actions.remove(i)}
        />
    ))
    const remove = (
        <RemoveButton
            label={`Remove rule ${index + 1}`}
            onPress={onRemove}
            testID={`form-rule-remove-${index}`}
        />
    )
    return (
        <RuleShell
            isSelectable={isSelectable}
            isSelected={isSelected}
            onSelect={onSelect}
            testID={`form-rule-${index}`}
        >
            <RuleCard title={`Rule ${index + 1}`} trailing={remove}>
                <View className="flex-row items-center gap-2">
                    <Text className="text-sm text-foreground">When</Text>
                    <MatchPillPair match={rule.match} onSelect={rule.setMatch} />
                    <Text className="text-sm text-foreground">of these are true</Text>
                </View>
                {conditions}
                <AddButton
                    label="Add condition"
                    onPress={rule.addCondition}
                    testID={`form-cond-add-${index}`}
                />
                <Text className="text-sm font-semibold text-foreground">Then</Text>
                {actions}
                <AddButton
                    label="Add action"
                    onPress={rule.addAction}
                    testID={`form-action-add-${index}`}
                />
                <RuleError message={rule.error} testID={`form-rule-error-${index}`} />
            </RuleCard>
        </RuleShell>
    )
}
