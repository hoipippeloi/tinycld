import { MatchPillPair } from '@tinycld/core/components/rules/MatchPillPair'
import { RuleCard } from '@tinycld/core/components/rules/RuleCard'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { useFieldArray, useWatch } from 'react-hook-form'
import { Pressable, Text, View } from 'react-native'
import { ActionEditor } from './ActionEditor'
import { ConditionEditor, conditionFields, firstOperator } from './ConditionEditor'
import { RemoveButton } from './rule-parts'
import type { useEditorForm } from './use-editor-form'

type Editor = ReturnType<typeof useEditorForm>

export interface RuleEditorProps {
    editor: Editor
    index: number
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

function useRuleEditor(editor: Editor, index: number) {
    const { control } = editor.form
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
    return { match, setMatch, when, actions, addCondition, addAction }
}

export function RuleEditor({ editor, index, isSelected, onSelect, onRemove }: RuleEditorProps) {
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
    // The same border tokens as a selected canvas cell; always present so selecting never shifts layout.
    const border = isSelected ? 'border-primary' : 'border-transparent'
    return (
        <Pressable
            onPress={onSelect}
            className={`rounded-xl border-2 mb-3 ${border}`}
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
            </RuleCard>
        </Pressable>
    )
}
