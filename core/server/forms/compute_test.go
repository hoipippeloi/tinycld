package forms

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The fixture is the one the TypeScript engine runs; see
// core/lib/forms/__tests__/compute.test.ts.
const computedFixturePath = "../../lib/forms/fixtures/computed-fixture.json"

type computedCase struct {
	Name   string         `json:"name"`
	Values map[string]any `json:"values"`
	Expect struct {
		Values map[string]any `json:"values"`
		Absent []string       `json:"absent"`
	} `json:"expect"`
}

func loadComputedFixture(t *testing.T) (*Definition, []computedCase) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(computedFixturePath))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Definition json.RawMessage `json:"definition"`
		Cases      []computedCase  `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	def, err := ParseDefinition(f.Definition)
	if err != nil {
		t.Fatal(err)
	}
	return def, f.Cases
}

func TestApplyComputed_SharedFixture(t *testing.T) {
	def, cases := loadComputedFixture(t)
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			out := ApplyComputed(def, nil, c.Values)
			for key, want := range c.Expect.Values {
				if !reflect.DeepEqual(out[key], want) {
					t.Errorf("%s = %#v, want %#v", key, out[key], want)
				}
			}
			for _, key := range c.Expect.Absent {
				if _, ok := out[key]; ok {
					t.Errorf("%s must be absent, got %#v", key, out[key])
				}
			}
		})
	}
}

func TestApplyComputed_DoesNotMutateItsInput(t *testing.T) {
	def, _ := loadComputedFixture(t)
	values := map[string]any{"lines": []any{map[string]any{"id": "1", "qty": 1.0, "rate": 2.0}}, "tax_pct": 0.0, "units": 1.0}
	ApplyComputed(def, nil, values)
	row := values["lines"].([]any)[0].(map[string]any)
	if _, ok := row["amount"]; ok {
		t.Fatalf("input row was mutated: %v", row)
	}
}

func TestRoundHalfAway(t *testing.T) {
	cases := []struct {
		x        float64
		decimals int
		want     float64
	}{{0.5, 0, 1}, {-0.5, 0, -1}, {2.5, 0, 3}, {-2.5, 0, -3}, {1832.6666666666667, 2, 1832.67}}
	for _, c := range cases {
		if got := roundHalfAway(c.x, c.decimals); got != c.want {
			t.Errorf("round(%v,%d) = %v, want %v", c.x, c.decimals, got, c.want)
		}
	}
	if got := roundHalfAway(-0.2, 0); 1/got < 0 {
		t.Errorf("negative zero returned")
	}
}

func TestRoundHalfAway_NonFiniteIsZero(t *testing.T) {
	cases := []struct {
		x        float64
		decimals int
	}{{math.Inf(1), 0}, {math.Inf(-1), 2}, {math.NaN(), 0}, {1e307, 6}, {-1e307, 6}}
	for _, c := range cases {
		if got := roundHalfAway(c.x, c.decimals); got != 0 {
			t.Errorf("round(%v,%d) = %v, want 0", c.x, c.decimals, got)
		}
	}
}

func TestEvalCompute_CoercionAndDivision(t *testing.T) {
	scope := map[string]any{"t": "text", "n": nil, "b": true}
	cases := []struct {
		expr any
		want float64
	}{
		{map[string]any{"var": "missing"}, 0},
		{map[string]any{"var": "t"}, 0},
		{map[string]any{"var": "n"}, 0},
		{map[string]any{"var": "b"}, 1},
		{map[string]any{"div": []any{5.0, 0.0}}, 0},
		{map[string]any{"min": []any{3.0, 1.0, 2.0}}, 1},
		{map[string]any{"max": []any{3.0, 1.0, 2.0}}, 3},
	}
	for _, c := range cases {
		if got := evalCompute(c.expr, scope); got != c.want {
			t.Errorf("%v = %v, want %v", c.expr, got, c.want)
		}
	}
}
