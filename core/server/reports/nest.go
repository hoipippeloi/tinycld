package reports

import (
	"fmt"
	"slices"
	"strings"
)

// nestParent puts in w, as n0, the id of the row the first nest level
// hangs from: the row the hops before the nest link reach.
func (r *rowsCTE) nestParent() string {
	hops := r.c.p.nest[0].hops
	return r.add("n0", q(r.root.join(hops[:len(hops)-1]), "id"))
}

// nestPass runs one query per nest level, each keyed by the ids of the
// level above: the base rows of the page, then each level's own rows.
// Linked rows the reader cannot see are left out.
func (rn *runner) nestPass(details []map[string]any) ([]map[any][]map[string]any, error) {
	p := rn.c.p
	if len(p.nest) == 0 {
		return nil, nil
	}
	var out []map[any][]map[string]any
	parents := distinct(details, "__n0")
	for level := range p.nest {
		rows, err := rn.nestLevel(level, parents)
		if err != nil {
			return nil, err
		}
		byParent := map[any][]map[string]any{}
		for _, row := range rows {
			byParent[row["__parent"]] = append(byParent[row["__parent"]], row)
		}
		out = append(out, byParent)
		parents = distinct(rows, "__next")
	}
	return out, nil
}

func distinct(rows []map[string]any, key string) []any {
	seen := map[any]bool{}
	var out []any
	for _, row := range rows {
		if v := row[key]; v != nil && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// nestLevel reads one level's child rows from the child collection's rule
// CTE (through newScope), under the run's time limit (through rn.query).
func (rn *runner) nestLevel(level int, parents []any) ([]map[string]any, error) {
	p := rn.c.p
	if len(parents) == 0 {
		return nil, nil
	}
	nl := p.nest[level]
	link := nl.hops[len(nl.hops)-1]
	s := newStmt(rn.app, rn.c.info)
	sc := newScope(s, link.to)
	back := q(sc.alias, link.link.BackField)
	sel := []string{back + " AS __parent", q(sc.alias, "id") + " AS __id"}
	var order []string
	for _, cp := range nl.cols {
		rest := &pathPlan{hops: cp.path.hops[len(nl.hops):], field: cp.path.field}
		v := sc.value(rest).sql
		sel = append(sel, fmt.Sprintf("%s AS v%d", v, p.index(cp)))
		order = append(order, "("+v+" IS NULL)", v)
	}
	if level+1 < len(p.nest) {
		next := p.nest[level+1].hops
		sel = append(sel, q(sc.join(next[len(nl.hops):len(next)-1]), "id")+" AS __next")
	}
	ids := make([]string, len(parents))
	for i, id := range parents {
		ids[i] = s.bind(id)
	}
	body := fmt.Sprintf("SELECT %s\n%s\nWHERE %s IN (%s)\nORDER BY __parent, %s LIMIT %s",
		strings.Join(sel, ", "), sc.render(), back, strings.Join(ids, ", "),
		strings.Join(append(order, "__id"), ", "), s.bind(int64(runLimits.rowCap+1)))
	rows, err := rn.query(s, nil, body)
	if err != nil {
		return nil, err
	}
	if len(rows) > runLimits.rowCap {
		rows = rows[:runLimits.rowCap]
		rn.nestCapNotice()
	}
	return rows, nil
}

// nestCapNotice says a nest level reached the row cap, once per run.
func (rn *runner) nestCapNotice() {
	if slices.ContainsFunc(rn.res.Notices, func(n Notice) bool { return n.Code == "nestCap" }) {
		return
	}
	rn.notice(Notice{Code: "nestCap", Message: fmt.Sprintf("The report shows the first %d child rows.", runLimits.rowCap), Count: runLimits.rowCap})
}

// nestedRows emits the child rows of one parent, each followed by its own
// children.
func (rn *runner) nestedRows(t *tree, level int, parentKey any, parentID, section string, depth int) {
	if level >= len(t.nested) || parentKey == nil {
		return
	}
	cols := rn.c.p.nest[level].cols
	for _, row := range t.nested[level][parentKey] {
		id := fmt.Sprintf("%s/%v", parentID, row["__id"])
		cells := map[string]any{}
		for _, cp := range cols {
			cells[cp.col.ID] = rn.cellValue(cp, row[fmt.Sprintf("v%d", rn.c.p.index(cp))], false)
		}
		rn.push(Row{ID: id, Kind: KindDetail, Depth: depth, Label: rn.firstLabel(cols, row), Section: section, Parent: parentID, Cells: cells})
		rn.nestedRows(t, level+1, row["__next"], id, section, depth+1)
	}
}
