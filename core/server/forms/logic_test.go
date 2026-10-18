package forms

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The fixture is the one the TypeScript engine runs; see
// core/lib/forms/__tests__/logic.test.ts.
const fixturePath = "../../lib/forms/fixtures/rules-fixture.json"

type fixtureCase struct {
	Name   string         `json:"name"`
	Values map[string]any `json:"values"`
	Expect struct {
		Fields map[string]FieldState `json:"fields"`
		Pages  map[string]struct {
			Visible bool `json:"visible"`
		} `json:"pages"`
		ActiveRules []string       `json:"activeRules"`
		SetValues   map[string]any `json:"setValues"`
	} `json:"expect"`
}

type fixture struct {
	Context    Context         `json:"context"`
	Definition json.RawMessage `json:"definition"`
	Cases      []fixtureCase   `json:"cases"`
	Defaults   map[string]any  `json:"defaults"`
}

func loadFixture(t *testing.T) (*Definition, fixture) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(fixturePath))
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	def, err := ParseDefinition(f.Definition)
	if err != nil {
		t.Fatal(err)
	}
	return def, f
}

func TestEvaluate_MatchesTheSharedFixture(t *testing.T) {
	def, f := loadFixture(t)
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			state, err := Evaluate(def, c.Values, f.Context)
			if err != nil {
				t.Fatal(err)
			}
			for key, want := range c.Expect.Fields {
				got := state.Fields[key]
				if got.Visible != want.Visible || got.Required != want.Required || !reflect.DeepEqual(got.Options, want.Options) {
					t.Errorf("field %s = %+v, want %+v", key, got, want)
				}
			}
			for key, want := range c.Expect.Pages {
				if state.Pages[key] != want.Visible {
					t.Errorf("page %s visible = %v, want %v", key, state.Pages[key], want.Visible)
				}
			}
			if c.Expect.ActiveRules != nil && !reflect.DeepEqual(state.ActiveRules, c.Expect.ActiveRules) {
				t.Errorf("activeRules = %v, want %v", state.ActiveRules, c.Expect.ActiveRules)
			}
			if c.Expect.SetValues != nil && !reflect.DeepEqual(state.SetValues, c.Expect.SetValues) {
				t.Errorf("setValues = %v, want %v", state.SetValues, c.Expect.SetValues)
			}
		})
	}
}

func TestApplyDefaults_MatchesTheSharedFixture(t *testing.T) {
	def, f := loadFixture(t)
	got, err := ApplyDefaults(def, f.Context)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, f.Defaults) {
		t.Fatalf("defaults = %v, want %v", got, f.Defaults)
	}
}

func TestAddDays_RollsTheMonth(t *testing.T) {
	if got := addDays("2026-02-28", 1); got != "2026-03-01" {
		t.Fatalf("got %s", got)
	}
}
