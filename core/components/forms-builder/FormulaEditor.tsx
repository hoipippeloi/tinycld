import {
    addOperand,
    asExpr,
    canRemoveOperand,
    childrenOf,
    describeFormula,
    exprAt,
    type FormulaOperands,
    type FormulaPart,
    type FormulaPath,
    isVariadic,
    PART_LABELS,
    partOf,
    partsFor,
    removeOperand,
    replaceAt,
    setAggregateColumn,
    setAggregateTable,
    setPlaces,
    withPart,
} from '@tinycld/core/lib/forms/builder'
import type { ComputeExpr } from '@tinycld/core/lib/forms/expression'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { Text, View } from 'react-native'
import { NumberText, type PickItem, PickMenu, RemoveButton } from './rule-parts'

const PLACES = [0, 1, 2, 3, 4, 5, 6]

export interface FormulaEditorProps {
    /** The stored formula; a draft holds it untyped. */
    value: unknown
    onChange: (expr: ComputeExpr) => void
    operands: FormulaOperands
    /** What a Field part is called: "Field", or "Column" in a column's formula. */
    valueNoun: string
    testID: string
}

/** Every edit replaces one part of the formula by its path; see lib/forms/builder/formula.ts. */
function formulaApi({
    value,
    onChange,
    operands,
}: Omit<FormulaEditorProps, 'valueNoun' | 'testID'>) {
    const expr = asExpr(value)
    const at = (path: FormulaPath) => exprAt(expr, path) ?? 0
    const set = (path: FormulaPath, next: ComputeExpr) => onChange(replaceAt(expr, path, next))
    return {
        expr,
        operands,
        summary: describeFormula(expr, operands),
        parts: partsFor(operands),
        at,
        set,
        setPart: (path: FormulaPath, part: FormulaPart) =>
            set(path, withPart(at(path), part, operands)),
        addPart: (path: FormulaPath) => set(path, addOperand(at(path))),
        removePart: (path: FormulaPath, index: number) => set(path, removeOperand(at(path), index)),
        setPlaces: (path: FormulaPath, places: number) => set(path, setPlaces(at(path), places)),
        setTable: (path: FormulaPath, key: string) =>
            set(path, setAggregateTable(at(path), key, operands)),
        setColumn: (path: FormulaPath, key: string) => set(path, setAggregateColumn(at(path), key)),
    }
}

type Formula = ReturnType<typeof formulaApi>

const idOf = (testID: string, path: FormulaPath) =>
    `${testID}-${path.length ? path.join('-') : 'root'}`

const partLabel = (part: FormulaPart, valueNoun: string) =>
    part === 'field' ? valueNoun : PART_LABELS[part]

interface PartProps {
    formula: Formula
    path: FormulaPath
    expr: ComputeExpr
    valueNoun: string
    id: string
}

function NumberPart({ formula, path, expr, id }: PartProps) {
    if (typeof expr !== 'number') return null
    // A cleared number is 0, the value the engine reads for nothing.
    return (
        <NumberText
            value={expr}
            onChange={n => formula.set(path, n ?? 0)}
            label="Number"
            placeholder="0"
            testID={`${id}-number`}
        />
    )
}

function ValuePick({ formula, path, expr, valueNoun, id }: PartProps) {
    if (typeof expr !== 'object' || !('var' in expr)) return null
    const items: PickItem[] = formula.operands.values.map(v => ({
        id: v.key,
        label: v.label,
        isSelected: v.key === expr.var,
        onSelect: () => formula.set(path, { var: v.key }),
    }))
    const label =
        formula.operands.values.find(v => v.key === expr.var)?.label ?? `${expr.var} (missing)`
    return <PickMenu label={label} purpose={valueNoun} items={items} testID={`${id}-field`} />
}

function PlacesPick({ formula, path, expr, id }: PartProps) {
    if (typeof expr !== 'object' || !('round' in expr)) return null
    const places = expr.round[1]
    const items: PickItem[] = PLACES.map(n => ({
        id: String(n),
        label: String(n),
        isSelected: n === places,
        onSelect: () => formula.setPlaces(path, n),
    }))
    return (
        <PickMenu
            label={`${places} places`}
            purpose="Decimal places"
            items={items}
            testID={`${id}-places`}
        />
    )
}

function ColumnPick({
    isVisible,
    label,
    items,
    testID,
}: {
    isVisible: boolean
    label: string
    items: PickItem[]
    testID: string
}) {
    if (!isVisible) return null
    return <PickMenu label={label} purpose="Column" items={items} testID={testID} />
}

/** Sum of a column: its table and column. Number of rows: its table. */
function TotalPick({ formula, path, expr, id }: PartProps) {
    if (typeof expr !== 'object' || !('sumOf' in expr || 'count' in expr)) return null
    const isSum = 'sumOf' in expr
    const tableKey = isSum ? expr.sumOf[0].var : expr.count[0].var
    const columnKey = isSum ? expr.sumOf[1] : ''
    const { tables } = formula.operands
    const table = tables.find(t => t.key === tableKey)
    const offered = isSum ? tables.filter(t => t.columns.length > 0) : tables
    const tableItems: PickItem[] = offered.map(t => ({
        id: t.key,
        label: t.label,
        isSelected: t.key === tableKey,
        onSelect: () => formula.setTable(path, t.key),
    }))
    const columnItems: PickItem[] = (table?.columns ?? []).map(c => ({
        id: c.key,
        label: c.label,
        isSelected: c.key === columnKey,
        onSelect: () => formula.setColumn(path, c.key),
    }))
    const columnLabel =
        table?.columns.find(c => c.key === columnKey)?.label ?? `${columnKey} (missing)`
    return (
        <>
            <PickMenu
                label={table?.label ?? `${tableKey} (missing)`}
                purpose="Table"
                items={tableItems}
                testID={`${id}-table`}
            />
            <ColumnPick
                isVisible={isSum}
                label={columnLabel}
                items={columnItems}
                testID={`${id}-column`}
            />
        </>
    )
}

function RemovePart({ onPress, testID }: { onPress: (() => void) | null; testID: string }) {
    if (!onPress) return null
    return <RemoveButton label="Remove part" onPress={onPress} testID={testID} />
}

function AddPart({
    isVisible,
    onPress,
    testID,
}: {
    isVisible: boolean
    onPress: () => void
    testID: string
}) {
    if (!isVisible) return null
    return (
        <Button
            variant="outline"
            size="sm"
            onPress={onPress}
            className="self-start"
            accessibilityLabel="Add part"
            testID={testID}
        >
            <ButtonText>Add part</ButtonText>
        </Button>
    )
}

/**
 * The parts a part holds, as nodes. A part has no id: its path is its
 * identity. The count and the part are in the key, so a removal or a new kind
 * of part remounts the inputs below rather than keeping a neighbour's typed text.
 */
function operandNodes(expr: ComputeExpr, path: FormulaPath, testID: string) {
    const parts = childrenOf(expr)
    return parts.map((part, index) => {
        const childPath = [...path, index]
        return {
            path: childPath,
            index,
            key: `${idOf(testID, childPath)}:${partOf(part)}:${parts.length}`,
        }
    })
}

function Operands({ formula, path, expr, valueNoun, id, testID }: PartProps & { testID: string }) {
    const nodes = operandNodes(expr, path, testID)
    if (nodes.length === 0) return null
    const canRemove = canRemoveOperand(expr)
    const items = nodes.map(node => (
        <FormulaNode
            key={node.key}
            formula={formula}
            path={node.path}
            valueNoun={valueNoun}
            testID={testID}
            onRemove={canRemove ? () => formula.removePart(path, node.index) : null}
        />
    ))
    return (
        <View className="pl-3 border-l border-border gap-1.5">
            {items}
            <AddPart
                isVisible={isVariadic(expr)}
                onPress={() => formula.addPart(path)}
                testID={`${id}-add`}
            />
        </View>
    )
}

interface NodeProps {
    formula: Formula
    path: FormulaPath
    valueNoun: string
    testID: string
    /** Removes this part from the one that holds it; null where it cannot go. */
    onRemove: (() => void) | null
}

function FormulaNode({ formula, path, valueNoun, testID, onRemove }: NodeProps) {
    const expr = formula.at(path)
    const part = partOf(expr)
    const id = idOf(testID, path)
    const partItems: PickItem[] = formula.parts.map(p => ({
        id: p,
        label: partLabel(p, valueNoun),
        isSelected: p === part,
        onSelect: () => formula.setPart(path, p),
    }))
    const props: PartProps = { formula, path, expr, valueNoun, id }
    return (
        <View className="gap-1.5" testID={id}>
            <View className="flex-row flex-wrap items-center gap-1.5">
                <PickMenu
                    label={partLabel(part, valueNoun)}
                    purpose="Formula part"
                    items={partItems}
                    testID={`${id}-part`}
                />
                <NumberPart {...props} />
                <ValuePick {...props} />
                <PlacesPick {...props} />
                <TotalPick {...props} />
                <RemovePart onPress={onRemove} testID={`${id}-remove`} />
            </View>
            <Operands {...props} testID={testID} />
        </View>
    )
}

/**
 * A formula built from parts picked from menus: no formula is typed, only a
 * number where a Number part is picked. The line on top reads it back as text.
 */
export function FormulaEditor({
    value,
    onChange,
    operands,
    valueNoun,
    testID,
}: FormulaEditorProps) {
    const formula = formulaApi({ value, onChange, operands })
    return (
        <View className="mb-3 gap-1.5" testID={testID}>
            <Text className="text-sm font-semibold text-foreground">Formula</Text>
            <Text
                className="text-sm text-foreground"
                accessibilityLabel={`Formula: ${formula.summary}`}
                testID={`${testID}-summary`}
            >
                {`= ${formula.summary}`}
            </Text>
            <FormulaNode
                key={partOf(formula.expr)}
                formula={formula}
                path={[]}
                valueNoun={valueNoun}
                testID={testID}
                onRemove={null}
            />
        </View>
    )
}
