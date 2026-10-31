package reports

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	validation "github.com/pocketbase/ozzo-validation/v4"
)

// layoutLegs are the group statement's computed rows: one select per
// computed row (and currency), whose cells compute the row's formula from
// the first-level group rows its sections name. A formula reads sections
// and earlier computed rows by name, never by row position.
func (c *compiler) layoutLegs(s *stmt, pivot []any) ([]string, error) {
	if len(c.p.layout) == 0 {
		return nil, nil
	}
	cur := "(SELECT 1) cur"
	if len(c.currencies) > 0 {
		// With no visible rows the computed rows still come, once, with no
		// currency, as they do for a report without currencies.
		nulls := strings.TrimSuffix(strings.Repeat("NULL, ", len(c.currencies)), ", ")
		cur = "(SELECT DISTINCT " + strings.Join(c.currencies, ", ") + " FROM o1 UNION ALL SELECT " + nulls +
			" WHERE NOT EXISTS (SELECT 1 FROM o1)) cur"
	}
	lc := &layoutCtx{c: c, s: s, items: map[string]*LayoutItem{}}
	sizes := map[string]int{}
	var legs []string
	for i, item := range c.p.layout {
		at := fmt.Sprintf("layout.%d", i)
		if item.Section != "" {
			if _, err := layoutKey(item.Key); err != nil {
				return nil, invalid(at+".key", errLayoutKey)
			}
			lc.items[item.Section] = item
			continue
		}
		// A formula that reads an earlier row is compiled with that row
		// inside it, so its size grows with every reference.
		sizes[item.Row] = expandedSize(item.Formula, sizes)
		if sizes[item.Row] > maxLayoutNodes {
			return nil, invalid(at, "the layout's computed rows are too large; reference fewer earlier rows")
		}
		cells := []string{fmt.Sprintf("%d AS __level", len(c.p.groups)+1), s.bind(item.Row) + " AS __row"}
		for g := range c.p.groups {
			cells = append(cells, fmt.Sprintf("NULL AS k%d", g))
		}
		for _, ck := range c.currencies {
			cells = append(cells, "cur."+ck+" AS "+ck)
		}
		// Compiled once on no column, so a layout with no number columns
		// is still checked.
		lc.cell, lc.typ = "", Number
		if _, err := lc.row(item, at+".formula"); err != nil {
			return nil, err
		}
		for idx, cp := range c.p.cols {
			if !isNumeric(c.levelTypes[cp.col.ID]) || c.levelTypes[cp.col.ID] == Bool {
				cells = append(cells, fmt.Sprintf("NULL AS v%d", idx))
				continue
			}
			lc.cell, lc.typ = fmt.Sprintf("v%d", idx), c.levelTypes[cp.col.ID]
			e, err := lc.row(item, at+".formula")
			if err != nil {
				return nil, err
			}
			cells = append(cells, e.sql+" AS "+lc.cell)
		}
		for j := range pivot {
			lc.cell, lc.typ = fmt.Sprintf("pv%d", j), c.levelTypes[c.p.pivot.cell.col.ID]
			e, err := lc.row(item, at+".formula")
			if err != nil {
				return nil, err
			}
			cells = append(cells, e.sql+" AS "+lc.cell)
		}
		cells = append(cells, fmt.Sprintf("%d AS __ord", i))
		legs = append(legs, "SELECT "+strings.Join(cells, ", ")+" FROM "+cur)
		lc.items[item.Row] = item
	}
	return legs, nil
}

// layoutCtx compiles a computed row's formula for one cell column: a
// {subtotal} leaf is that column's value on a section's group row, or on an
// earlier computed row. items holds only the items before the one being
// compiled, so a formula cannot read itself or a later row.
type layoutCtx struct {
	ctxBase
	c     *compiler
	s     *stmt
	items map[string]*LayoutItem
	// cell is the result column being compiled; empty for the check pass.
	cell string
	// typ is the type of that column's cells, which a subtotal keeps so the
	// money rules apply to a computed row.
	typ FieldType
}

// maxLayoutNodes caps the size of a computed row's formula after the rows it
// reads are inlined.
const maxLayoutNodes = 2000

const errLayoutKey = "a section key is text, a number, true, false or null"

// expandedSize counts a formula's nodes with each earlier row it reads
// counted in full.
func expandedSize(n *Node, rows map[string]int) int {
	if n == nil {
		return 0
	}
	size := 1 + rows[n.Subtotal]
	for _, a := range n.Args {
		size += expandedSize(a, rows)
	}
	return size
}

func (lc *layoutCtx) row(item *LayoutItem, at string) (expr, error) {
	e, err := compileFormula(lc, item.Formula, at)
	if err != nil {
		return expr{}, err
	}
	if !isNumeric(e.typ) || e.typ == Bool {
		return expr{}, invalid(at, "a computed row's formula is a number")
	}
	return e, nil
}

func (lc *layoutCtx) subtotal(id, at string) (expr, error) {
	item, ok := lc.items[id]
	if !ok {
		return expr{}, &SpecError{Status: 422, Problems: map[string]validation.Error{
			at: validation.NewError("unknown_subtotal", fmt.Sprintf("the layout has no section or earlier row %q", id)),
		}}
	}
	if item.Row != "" {
		return lc.row(item, at)
	}
	if lc.cell == "" {
		return expr{sql: "NULL", typ: Number}, nil
	}
	key, err := layoutKey(item.Key)
	if err != nil {
		return expr{}, invalid(at, errLayoutKey)
	}
	conds := []string{"o.k0 IS " + lc.s.bind(key)}
	for _, ck := range lc.c.currencies {
		conds = append(conds, "o."+ck+" IS cur."+ck)
	}
	// An empty section counts as zero.
	return expr{sql: fmt.Sprintf("COALESCE((SELECT o.%s FROM o1 o WHERE %s), 0)", lc.cell, strings.Join(conds, " AND ")), typ: lc.typ}, nil
}

func layoutKey(raw json.RawMessage) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	switch x := v.(type) {
	case json.Number:
		return numberValue(x), nil
	case bool:
		// A bool group key is read from SQLite as 0 or 1.
		if x {
			return int64(1), nil
		}
		return int64(0), nil
	case nil, string:
		return x, nil
	}
	return nil, fmt.Errorf("not a scalar")
}

func (lc *layoutCtx) col(_, at string) (expr, error)       { return expr{}, lc.only(at) }
func (lc *layoutCtx) path(_ Path, at string) (expr, error) { return expr{}, lc.only(at) }
func (lc *layoutCtx) param(_, at string) (expr, error)     { return expr{}, lc.only(at) }
func (lc *layoutCtx) aggregate(_ Aggregate, _ *Node, _ int, at string) (expr, error) {
	return expr{}, lc.only(at)
}
func (lc *layoutCtx) window(_ string, _ *Node, _ int, at string) (expr, error) {
	return expr{}, lc.only(at)
}
func (lc *layoutCtx) exists(_ *Node, at string) (expr, error) { return expr{}, lc.only(at) }
func (lc *layoutCtx) only(at string) error {
	return invalid(at, "a computed row reads sections' subtotals, earlier rows and values")
}
func (lc *layoutCtx) bind(v any) string   { return lc.s.bind(v) }
func (lc *layoutCtx) fiscalStart() string { return lc.bind(int64(lc.c.fiscal)) }
func (lc *layoutCtx) filter() bool        { return false }

// layoutRows emits the rows for one currency: each section's group row
// (titled, always with its subtotal) and each computed row, in the layout's
// order. First-level groups no section names are left out.
func (rn *runner) layoutRows(t *tree, total map[string]any) {
	ck := rn.currencyKey(total)
	byKey := map[string]map[string]any{}
	for _, g := range t.children[ck] {
		byKey[keyString([]any{g["k0"]})] = g
	}
	for _, item := range rn.c.p.layout {
		if item.Row != "" {
			row := t.computed[item.Row+"|"+ck]
			if row == nil {
				row = map[string]any{}
			}
			id := "c:" + item.Row + rn.currencySuffix(total)
			rn.push(Row{ID: id, Kind: KindComputed, Label: item.Label, Cells: rn.cells(row)})
			continue
		}
		// layoutLegs refused a bad key before any row was read.
		key, err := layoutKey(item.Key)
		if err != nil {
			continue
		}
		row := byKey[keyString([]any{key})]
		if row == nil {
			row = map[string]any{"k0": key, "__level": int64(1)}
			for _, name := range rn.c.currencies {
				row[name] = total[name]
			}
		}
		groupKey := rn.rowKey(row, 1)
		rn.groupWithLabel(t, row, 1, "", "g:"+keyString(groupKey), item.Title, groupKey, true)
	}
}
