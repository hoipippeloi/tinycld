import { ValueInput } from '@tinycld/core/components/rules/ValueInput'
import type { CatalogField } from '@tinycld/core/lib/automation/api'
import {
    catalogFieldFor,
    type DraftDefinition,
    kindOf,
    LIST_VALUE_OPS,
    NO_VALUE_OPS,
    OPERATOR_LABELS,
    operatorsFor,
} from '@tinycld/core/lib/forms/builder'
import type { FormHostDef } from '@tinycld/core/lib/forms/host'
import { useWatch } from 'react-hook-form'
import { View } from 'react-native'
import {
    type Choice,
    ChoiceChips,
    type DraftCondition,
    optionsOf,
    PickMenu,
    RemoveButton,
} from './rule-parts'
import type { useEditorForm } from './use-editor-form'

type Editor = ReturnType<typeof useEditorForm>
type ConditionValue = DraftCondition['value']

export interface ConditionEditorProps {
    editor: Editor
    ruleIndex: number
    index: number
    onRemove: () => void
}

/** The fields a condition can read: every field but a section, which holds no value. */
export function conditionFields(draft: DraftDefinition, host: FormHostDef) {
    return draft.fields.filter(f => kindOf(draft, host, f.key) !== 'section')
}

export function firstOperator(draft: DraftDefinition, host: FormHostDef, key: string) {
    return operatorsFor(kindOf(draft, host, key) ?? 'text')[0]
}

interface ValueProps {
    catalog: CatalogField | undefined
    choices: Choice[]
    op: DraftCondition['op']
    value: ConditionValue
    onChange: (value: ConditionValue) => void
    testID: string
}

function listOf(value: ConditionValue): string[] {
    return Array.isArray(value) ? value : []
}

/** None for an operator that reads no value, chips for a choice, otherwise a typed input. */
function ConditionValueInput({ catalog, choices, op, value, onChange, testID }: ValueProps) {
    if (!catalog || NO_VALUE_OPS.has(op)) return null
    if (LIST_VALUE_OPS.has(op)) {
        const list = listOf(value)
        const toggle = (id: string) =>
            onChange(list.includes(id) ? list.filter(v => v !== id) : [...list, id])
        return (
            <ChoiceChips
                choices={choices}
                selected={list}
                onToggle={toggle}
                isMultiple
                testID={testID}
            />
        )
    }
    if (catalog.type === 'select')
        return (
            <ChoiceChips
                choices={choices}
                selected={typeof value === 'string' ? [value] : []}
                onToggle={onChange}
                testID={testID}
            />
        )
    return (
        <View className="flex-1 min-w-[120px] flex-row" testID={testID}>
            <ValueInput field={catalog} op={op} value={value} onChange={onChange} />
        </View>
    )
}

function useCondition(editor: Editor, ruleIndex: number, index: number) {
    const name = `rules.${ruleIndex}.when.${index}` as const
    const condition = useWatch({ control: editor.form.control, name })
    const host = editor.host
    if (!host || !condition) return null
    const draft = editor.form.getValues()
    const set = (patch: Partial<DraftCondition>) =>
        editor.form.setValue(name, { ...condition, ...patch }, { shouldDirty: true })
    const t = `${ruleIndex}-${index}`
    const fieldItems = conditionFields(draft, host).map(f => ({
        id: f.key,
        label: f.label,
        isSelected: f.key === condition.field,
        // A new field reads a new kind: its operators and value start over.
        onSelect: () =>
            set({ field: f.key, op: firstOperator(draft, host, f.key), value: undefined }),
    }))
    const opItems = operatorsFor(kindOf(draft, host, condition.field) ?? 'text').map(op => ({
        id: op,
        label: OPERATOR_LABELS[op],
        isSelected: op === condition.op,
        onSelect: () => set({ op, value: undefined }),
    }))
    const choices = optionsOf(draft, condition.field).map(o => ({ id: o.value, label: o.label }))
    return {
        condition,
        t,
        fieldLabel: draft.fields.find(f => f.key === condition.field)?.label ?? 'Field',
        fieldItems,
        opItems,
        catalog: catalogFieldFor(draft, host, condition.field),
        choices,
        setValue: (value: ConditionValue) => set({ value }),
    }
}

export function ConditionEditor({ editor, ruleIndex, index, onRemove }: ConditionEditorProps) {
    const c = useCondition(editor, ruleIndex, index)
    if (!c) return null
    return (
        <View className="flex-row flex-wrap items-center gap-1.5" testID={`form-cond-${c.t}`}>
            <PickMenu
                label={c.fieldLabel}
                purpose="Condition field"
                items={c.fieldItems}
                testID={`form-cond-field-${c.t}`}
            />
            <PickMenu
                label={OPERATOR_LABELS[c.condition.op]}
                purpose="Operator"
                items={c.opItems}
                testID={`form-cond-op-${c.t}`}
            />
            <ConditionValueInput
                // A new field or operator starts a fresh input, dropping any half-typed number.
                key={`${c.condition.field}:${c.condition.op}`}
                catalog={c.catalog}
                choices={c.choices}
                op={c.condition.op}
                value={c.condition.value}
                onChange={c.setValue}
                testID={`form-cond-value-${c.t}`}
            />
            <RemoveButton
                label="Remove condition"
                onPress={onRemove}
                testID={`form-cond-${c.t}-remove`}
            />
        </View>
    )
}
