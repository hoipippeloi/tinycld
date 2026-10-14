import { useBreakpoint } from '@tinycld/core/components/workspace/useBreakpoint'
import { addRule, removeRule } from '@tinycld/core/lib/forms/builder'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { useState } from 'react'
import { Platform, Text, View } from 'react-native'
import { AffectedFields } from './AffectedFields'
import { RuleEditor } from './RuleEditor'
import type { useEditorForm } from './use-editor-form'

type Editor = ReturnType<typeof useEditorForm>

export interface RulesTabProps {
    editor: Editor
    isVisible: boolean
}

function EmptyHint({ isVisible }: { isVisible: boolean }) {
    if (!isVisible) return null
    return (
        <Text className="text-sm text-muted-foreground mb-3">
            No rules yet. A rule reads fields and shows, hides, requires or fills others.
        </Text>
    )
}

function useRulesTab(editor: Editor) {
    // Which rule the affected-fields pane shows: local UI state.
    const [selected, setSelected] = useState(0)
    const breakpoint = useBreakpoint()
    const count = editor.rules.fields.length
    const current = Math.min(selected, Math.max(count - 1, 0))
    const add = () => {
        editor.apply(addRule)
        setSelected(count)
    }
    const removeAt = (index: number) => {
        const key = editor.form.getValues(`rules.${index}.key`)
        if (key) editor.apply(def => removeRule(def, key))
    }
    // The pane needs the room of a desktop window and a pointer to read it beside the rules.
    const hasPane = breakpoint === 'desktop' && Platform.OS === 'web' && count > 0
    return { selected: current, select: setSelected, add, removeAt, hasPane, count }
}

export function RulesTab({ editor, isVisible }: RulesTabProps) {
    const tab = useRulesTab(editor)
    if (!isVisible || !editor.host) return null
    const rules = editor.rules.fields.map((row, index) => (
        <RuleEditor
            key={row.id}
            editor={editor}
            index={index}
            isSelected={tab.hasPane && index === tab.selected}
            onSelect={() => tab.select(index)}
            onRemove={() => tab.removeAt(index)}
        />
    ))
    return (
        <View className="flex-row gap-4 py-3" testID="form-rules">
            <View className="flex-1">
                <EmptyHint isVisible={tab.count === 0} />
                {rules}
                <Button
                    variant="outline"
                    size="sm"
                    onPress={tab.add}
                    className="self-start"
                    testID="form-rule-add"
                >
                    <ButtonText>Add rule</ButtonText>
                </Button>
            </View>
            <AffectedFields editor={editor} ruleIndex={tab.selected} isVisible={tab.hasPane} />
        </View>
    )
}
