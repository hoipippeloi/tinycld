package forms

import (
	"encoding/json"
	"os"
	"testing"
)

// The shared formula table: the report compiler runs every case
// (core/server/reports/formula_cases_test.go); the forms engines, Go here and
// TS in core/lib/forms/__tests__/formula-cases.test.ts, run each case that
// carries a "forms" formula. A shared case's expected value holds for both.
const formulaCasesPath = "../../lib/forms/fixtures/formula-cases.json"

type sharedFormulaCase struct {
	Name      string           `json:"name"`
	Values    map[string]any   `json:"values"`
	Rows      []map[string]any `json:"rows"`
	Forms     any              `json:"forms"`
	FormsNote string           `json:"formsNote"`
	Expect    any              `json:"expect"`
}

func TestSharedFormulaCases_FormsEngine(t *testing.T) {
	raw, err := os.ReadFile(formulaCasesPath)
	if err != nil {
		t.Fatal(err)
	}
	var table struct {
		Cases []sharedFormulaCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &table); err != nil {
		t.Fatal(err)
	}
	shared := 0
	for _, c := range table.Cases {
		if c.Forms == nil {
			continue
		}
		shared++
		t.Run(c.Name, func(t *testing.T) {
			var refs exprRefs
			if msg := parseExpr(c.Forms, &refs); msg != "" {
				t.Fatalf("the forms formula is not valid: %s", msg)
			}
			scope := map[string]any{}
			for k, v := range c.Values {
				scope[k] = v
			}
			if c.Rows != nil {
				rows := make([]any, len(c.Rows))
				for i, r := range c.Rows {
					rows[i] = r
				}
				scope["rows"] = rows
			}
			want, ok := c.Expect.(float64)
			if !ok {
				t.Fatalf("a shared case expects a number, got %#v", c.Expect)
			}
			if got := evalCompute(c.Forms, scope); got != want {
				t.Fatalf("evalCompute = %v, want %v", got, want)
			}
		})
	}
	// Keep equal to the count in the TS test and to the reports rule test.
	if shared != 27 {
		t.Fatalf("%d cases carry forms, want 27", shared)
	}
}
