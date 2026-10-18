package forms

import (
	"fmt"
	"reflect"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/diegoholiveira/jsonlogic/v3"
)

type Context struct {
	Today  string `json:"today"`
	UserID string `json:"userId"`
}

type FieldState struct {
	Visible  bool     `json:"visible"`
	Required bool     `json:"required"`
	Options  []Option `json:"options,omitempty"`
}

type State struct {
	Fields      map[string]FieldState
	Pages       map[string]bool
	ActiveRules []string
	SetValues   map[string]any
}

// The custom operations read the context of the evaluation in flight. One
// mutex serializes evaluations, which are microseconds; jsonlogic's operator
// table is global, so this is the honest shape.
var (
	evalMu  sync.Mutex
	evalCtx Context
	opsOnce sync.Once
)

func isEmpty(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return x == ""
	case bool:
		return !x
	case []any:
		return len(x) == 0
	}
	return false
}

func hasValue(v, x any) bool {
	if arr, ok := v.([]any); ok {
		for _, it := range arr {
			if reflect.DeepEqual(it, x) {
				return true
			}
		}
		return false
	}
	return reflect.DeepEqual(v, x)
}

func anyOf(v, list any) bool {
	items, ok := list.([]any)
	if !ok || isEmpty(v) {
		return false
	}
	for _, it := range items {
		if hasValue(v, it) {
			return true
		}
	}
	return false
}

func first(values any) any {
	if arr, ok := values.([]any); ok && len(arr) > 0 {
		return arr[0]
	}
	return values
}

func doneOf(item any) bool {
	m, ok := item.(map[string]any)
	if !ok {
		return false
	}
	d, _ := m["done"].(bool)
	return d
}

func registerOperations() {
	opsOnce.Do(func() {
		jsonlogic.AddOperator("isEmpty", func(values, data any) any { return isEmpty(first(values)) })
		jsonlogic.AddOperator("allDone", func(values, data any) any {
			arr, ok := first(values).([]any)
			if !ok || len(arr) == 0 {
				return false
			}
			for _, it := range arr {
				if !doneOf(it) {
					return false
				}
			}
			return true
		})
		jsonlogic.AddOperator("anyOpen", func(values, data any) any {
			arr, _ := first(values).([]any)
			for _, it := range arr {
				if !doneOf(it) {
					return true
				}
			}
			return false
		})
		jsonlogic.AddOperator("hasValue", func(values, data any) any {
			arr, ok := values.([]any)
			if !ok || len(arr) != 2 {
				return false
			}
			return hasValue(arr[0], arr[1])
		})
		jsonlogic.AddOperator("anyOf", func(values, data any) any {
			arr, ok := values.([]any)
			if !ok || len(arr) != 2 {
				return false
			}
			return anyOf(arr[0], arr[1])
		})
		jsonlogic.AddOperator("today", func(values, data any) any { return evalCtx.Today })
		jsonlogic.AddOperator("me", func(values, data any) any { return evalCtx.UserID })
		jsonlogic.AddOperator("addDays", func(values, data any) any {
			arr, ok := values.([]any)
			if !ok || len(arr) != 2 {
				return nil
			}
			date, _ := arr[0].(string)
			days, _ := arr[1].(float64)
			return addDays(date, int(days))
		})
	})
}

func addDays(isoDate string, days int) string {
	if len(isoDate) < 10 {
		return isoDate
	}
	t, err := time.ParseInLocation("2006-01-02", isoDate[:10], time.Local)
	if err != nil {
		return isoDate
	}
	return t.AddDate(0, 0, days).Format("2006-01-02")
}

// guarded keeps TS and Go in agreement on empty fields: JSON Logic turns null
// into "null" or 0, which would make an empty field match "nu" or "< 5".
func guarded(v, op map[string]any) map[string]any {
	return map[string]any{"and": []any{map[string]any{"!": map[string]any{"isEmpty": []any{v}}}, op}}
}

func compileCondition(c Condition) map[string]any {
	v := map[string]any{"var": c.Field}
	switch c.Op {
	case "eq":
		return map[string]any{"==": []any{v, c.Value}}
	case "is":
		return map[string]any{"hasValue": []any{v, c.Value}}
	case "neq":
		return map[string]any{"!=": []any{v, c.Value}}
	case "is_not":
		return map[string]any{"!": map[string]any{"hasValue": []any{v, c.Value}}}
	case "contains":
		return guarded(v, map[string]any{"in": []any{c.Value, map[string]any{"cat": []any{v}}}})
	case "starts_with":
		s, _ := c.Value.(string)
		return guarded(v, map[string]any{"==": []any{map[string]any{"substr": []any{map[string]any{"cat": []any{v}}, float64(0), float64(utf8.RuneCountInString(s))}}, c.Value}})
	case "is_any_of":
		return map[string]any{"anyOf": []any{v, c.Value}}
	case "is_empty":
		return map[string]any{"isEmpty": []any{v}}
	case "not_empty":
		return map[string]any{"!": map[string]any{"isEmpty": []any{v}}}
	case "gt", "after":
		return guarded(v, map[string]any{">": []any{v, c.Value}})
	case "lt", "before":
		return guarded(v, map[string]any{"<": []any{v, c.Value}})
	case "gte":
		return guarded(v, map[string]any{">=": []any{v, c.Value}})
	case "lte":
		return guarded(v, map[string]any{"<=": []any{v, c.Value}})
	case "is_true":
		return map[string]any{"==": []any{v, true}}
	case "is_false":
		return map[string]any{"!=": []any{v, true}}
	case "all_done":
		return map[string]any{"allDone": []any{v}}
	case "any_open":
		return map[string]any{"anyOpen": []any{v}}
	}
	return map[string]any{"==": []any{true, false}}
}

func compileRule(r Rule) map[string]any {
	parts := make([]any, 0, len(r.When))
	for _, c := range r.When {
		parts = append(parts, compileCondition(c))
	}
	if r.Match == "any" {
		return map[string]any{"or": parts}
	}
	return map[string]any{"and": parts}
}

func truthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case nil:
		return false
	case string:
		return x != ""
	case float64:
		return x != 0
	}
	return true
}

// EvaluateExpression evaluates a literal or a JSON Logic object. Callers hold evalMu.
func evaluateExpressionLocked(expr any, values map[string]any) (any, error) {
	if m, ok := expr.(map[string]any); ok {
		return jsonlogic.ApplyInterface(m, values)
	}
	return expr, nil
}

// EvaluateExpression needs values holding JSON-decoded types only (float64,
// []any, map[string]any, string, bool, nil); jsonlogic rejects others.
func EvaluateExpression(expr any, ctx Context, values map[string]any) (any, error) {
	registerOperations()
	evalMu.Lock()
	defer evalMu.Unlock()
	evalCtx = ctx
	if values == nil {
		values = map[string]any{}
	}
	return evaluateExpressionLocked(expr, values)
}

// Evaluate needs values holding JSON-decoded types only (float64, []any,
// map[string]any, string, bool, nil); jsonlogic rejects others.
func Evaluate(def *Definition, values map[string]any, ctx Context) (State, error) {
	registerOperations()
	evalMu.Lock()
	defer evalMu.Unlock()
	evalCtx = ctx
	data := map[string]any{}
	for k, v := range values {
		data[k] = v
	}
	for _, f := range def.Fields {
		if _, ok := data[f.Key]; !ok {
			data[f.Key] = nil
		}
	}
	st := State{Fields: map[string]FieldState{}, Pages: map[string]bool{}, ActiveRules: []string{}, SetValues: map[string]any{}}
	submitRequired := map[string]bool{}
	for _, k := range def.Submit.Required {
		submitRequired[k] = true
	}
	for _, f := range def.Fields {
		st.Fields[f.Key] = FieldState{Visible: !f.Hidden, Required: f.Required || submitRequired[f.Key]}
	}
	for _, p := range def.Pages {
		st.Pages[p.Key] = true
	}
	for _, r := range def.Rules {
		res, err := jsonlogic.ApplyInterface(compileRule(r), data)
		if err != nil {
			return st, fmt.Errorf("forms: rule %s: %w", r.Key, err)
		}
		if !truthy(res) {
			continue
		}
		st.ActiveRules = append(st.ActiveRules, r.Key)
		for _, a := range r.Actions {
			switch a.Action {
			case "show", "hide":
				visible := a.Action == "show"
				if a.Page != "" {
					st.Pages[a.Page] = visible
				} else if fs, ok := st.Fields[a.Field]; ok {
					fs.Visible = visible
					st.Fields[a.Field] = fs
				}
			case "require":
				if fs, ok := st.Fields[a.Field]; ok {
					fs.Required = true
					st.Fields[a.Field] = fs
				}
			case "set_options":
				if fs, ok := st.Fields[a.Field]; ok {
					fs.Options = a.Options
					st.Fields[a.Field] = fs
				}
			case "set_value":
				v, err := evaluateExpressionLocked(a.Value, data)
				if err != nil {
					return st, fmt.Errorf("forms: rule %s set_value: %w", r.Key, err)
				}
				st.SetValues[a.Field] = v
			}
		}
	}
	for _, f := range def.Fields {
		fs := st.Fields[f.Key]
		if !st.Pages[f.Page] {
			fs.Visible = false
		}
		if !fs.Visible {
			fs.Required = false
		}
		st.Fields[f.Key] = fs
	}
	return st, nil
}

func ApplyDefaults(def *Definition, ctx Context) (map[string]any, error) {
	registerOperations()
	evalMu.Lock()
	defer evalMu.Unlock()
	evalCtx = ctx
	out := map[string]any{}
	for k, expr := range def.Defaults {
		v, err := evaluateExpressionLocked(expr, map[string]any{})
		if err != nil {
			return nil, fmt.Errorf("forms: default %s: %w", k, err)
		}
		out[k] = v
	}
	return out, nil
}
