package forms

import (
	"math"
	"reflect"

	"github.com/pocketbase/pocketbase/core"
)

// Mirror of core/lib/forms/expression.ts (evaluation) and compute.ts. The
// shared fixture core/lib/forms/fixtures/computed-fixture.json pins both.

func num(v any) float64 {
	switch x := v.(type) {
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return 0
		}
		return x
	case bool:
		if x {
			return 1
		}
	}
	return 0
}

func rowsOf(v any) []map[string]any {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	rows := make([]map[string]any, 0, len(arr))
	for _, r := range arr {
		if m, ok := r.(map[string]any); ok {
			rows = append(rows, m)
		}
	}
	return rows
}

// roundHalfAway rounds half away from zero at the given decimals. Never -0.
// A value that is not finite, or overflows when scaled, becomes 0: every
// computed value passes through here, and JSON cannot hold Inf or NaN (a
// record whose JSON column fails to marshal is stored as null).
func roundHalfAway(x float64, decimals int) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return 0
	}
	p := math.Pow10(decimals)
	r := math.Round(math.Abs(x)*p) / p
	if r == 0 || math.IsInf(r, 0) {
		return 0
	}
	if x < 0 {
		return -r
	}
	return r
}

// evalCompute evaluates a formula that already passed parseExpr. Malformed
// nodes read as 0 rather than panicking, since stored definitions are parsed,
// not re-validated, on every write.
func evalCompute(e any, scope map[string]any) float64 {
	switch x := e.(type) {
	case float64:
		return x
	case map[string]any:
		for op, arg := range x {
			return evalOp(op, arg, scope)
		}
	}
	return 0
}

func evalOp(op string, arg any, scope map[string]any) float64 {
	if op == "var" {
		name, _ := arg.(string)
		return num(scope[name])
	}
	args, _ := arg.([]any)
	at := func(i int) float64 {
		if i >= len(args) {
			return 0
		}
		return evalCompute(args[i], scope)
	}
	switch op {
	case "add":
		s := 0.0
		for i := range args {
			s += at(i)
		}
		return s
	case "mul":
		p := 1.0
		for i := range args {
			p *= at(i)
		}
		return p
	case "sub":
		return at(0) - at(1)
	case "div":
		d := at(1)
		if d == 0 {
			return 0
		}
		return at(0) / d
	case "round":
		d := 0
		if len(args) > 1 {
			d = int(num(args[1]))
		}
		return roundHalfAway(at(0), d)
	case "min", "max":
		if len(args) == 0 {
			return 0
		}
		m := at(0)
		for i := 1; i < len(args); i++ {
			if op == "min" {
				m = math.Min(m, at(i))
			} else {
				m = math.Max(m, at(i))
			}
		}
		return m
	case "sumOf":
		if len(args) < 2 {
			return 0
		}
		table, _ := varName(args[0])
		col, _ := args[1].(string)
		s := 0.0
		for _, r := range rowsOf(scope[table]) {
			s += num(r[col])
		}
		return s
	case "count":
		if len(args) < 1 {
			return 0
		}
		table, _ := varName(args[0])
		return float64(len(rowsOf(scope[table])))
	}
	return 0
}

type computeNode struct {
	expr     any
	decimals int
}

// collectComputed returns the form's formulas, its tables, and which of those
// tables are host tables whose rows live in another collection.
func collectComputed(def *Definition, host *Host) (map[string]computeNode, map[string][]Column, map[string]bool) {
	nodes := map[string]computeNode{}
	tables := map[string][]Column{}
	hostTables := map[string]bool{}
	for _, f := range def.Fields {
		switch f.Kind {
		case "computed":
			nodes[f.Key] = computeNode{f.Expression, f.Decimals}
		case "table":
			tables[f.Key] = f.Columns
		case "builtin":
			if host == nil {
				continue
			}
			b := host.Builtin(f.Key)
			if b == nil {
				continue
			}
			if b.Kind == "computed" && b.Expression != nil {
				nodes[f.Key] = computeNode{b.Expression, b.Decimals}
			} else if b.Kind == "table" {
				tables[f.Key] = b.Columns
				hostTables[f.Key] = true
			}
		}
	}
	return nodes, tables, hostTables
}

func fillRow(cols []Column, row any) any {
	m, ok := row.(map[string]any)
	if !ok {
		return row
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	byKey := map[string]Column{}
	deps := map[string][]string{}
	for _, c := range cols {
		if c.Kind != "computed" {
			continue
		}
		var refs exprRefs
		parseExpr(c.Expression, &refs)
		byKey[c.Key] = c
		deps[c.Key] = refs.vars
	}
	order, cycle := orderKeys(deps)
	if cycle != nil {
		return out
	}
	for _, key := range order {
		c := byKey[key]
		out[key] = roundHalfAway(evalCompute(c.Expression, out), c.Decimals)
	}
	return out
}

// ApplyComputed fills every table row's computed columns, then every computed
// field in dependency order. It returns a new map. A custom table lives in the
// record's own JSON, so when its value is absent or not a list it has no rows.
// A host table's rows live in another collection: a computed value that reads
// a host table missing from values, or reads another value skipped for that
// reason, is left as it was, because the host computes it. values must hold
// JSON-decoded types (float64, []any, map[string]any).
func ApplyComputed(def *Definition, host *Host, values map[string]any) map[string]any {
	out, _ := applyComputed(def, host, values)
	return out
}

// applyComputed is ApplyComputed that also returns the keys it left as they
// were, which only the host's own code may set.
func applyComputed(def *Definition, host *Host, values map[string]any) (map[string]any, map[string]bool) {
	nodes, tables, hostTables := collectComputed(def, host)
	out := make(map[string]any, len(values))
	for k, v := range values {
		out[k] = v
	}
	for key, cols := range tables {
		if rows, ok := out[key].([]any); ok {
			filled := make([]any, len(rows))
			for i, r := range rows {
				filled[i] = fillRow(cols, r)
			}
			out[key] = filled
		}
	}
	refsOf := map[string]exprRefs{}
	deps := map[string][]string{}
	for key, n := range nodes {
		var refs exprRefs
		parseExpr(n.expr, &refs)
		refsOf[key] = refs
		deps[key] = refs.vars
	}
	skipped := map[string]bool{}
	order, cycle := orderKeys(deps)
	if cycle != nil {
		return out, skipped
	}
	for _, key := range order {
		refs := refsOf[key]
		blocked := false
		for _, a := range refs.aggs {
			if _, ok := out[a.table].([]any); hostTables[a.table] && !ok {
				blocked = true
			}
		}
		for _, v := range refs.vars {
			if skipped[v] {
				blocked = true
			}
		}
		if blocked {
			skipped[key] = true
			continue
		}
		out[key] = roundHalfAway(evalCompute(nodes[key].expr, out), nodes[key].decimals)
	}
	return out, skipped
}

// storeComputed writes recomputed values back onto the record: custom
// computed fields and tables go into the JSON column, host computed built-ins
// into their own column. fields is the JSON column's decoded map, edited in
// place.
func storeComputed(host *Host, def *Definition, record *core.Record, fields map[string]any, computed map[string]any) {
	changed := false
	for _, f := range def.Fields {
		v, ok := computed[f.Key]
		if !ok {
			continue
		}
		switch f.Kind {
		case "computed", "table":
			if !reflect.DeepEqual(fields[f.Key], v) {
				fields[f.Key] = v
				changed = true
			}
		case "builtin":
			if b := host.Builtin(f.Key); b != nil && b.Kind == "computed" && b.Storage == "column" {
				record.Set(f.Key, v)
			}
		}
	}
	if changed {
		record.Set(host.FieldsColumn, fields)
	}
}
