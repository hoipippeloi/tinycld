package forms

import (
	"encoding/json"
	"fmt"
)

// Wire mirror of core/lib/forms/definition.ts. Only what the server reads;
// unknown field properties pass through untouched.
type Option struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type Field struct {
	Key           string   `json:"key"`
	Kind          string   `json:"kind"`
	Page          string   `json:"page"`
	Label         string   `json:"label"`
	Required      bool     `json:"required"`
	Hidden        bool     `json:"hidden"`
	Options       []Option `json:"options,omitempty"`
	Multiple      bool     `json:"multiple,omitempty"`
	Collaborative bool     `json:"collaborative,omitempty"`
	Min           *float64 `json:"min,omitempty"`
	Max           *float64 `json:"max,omitempty"`
	MaxLength     *int     `json:"maxLength,omitempty"`
}

type Page struct {
	Key   string `json:"key"`
	Title string `json:"title"`
}

type Condition struct {
	Field string `json:"field"`
	Op    string `json:"op"`
	Value any    `json:"value,omitempty"`
}

type Action struct {
	Action  string   `json:"action"`
	Field   string   `json:"field,omitempty"`
	Page    string   `json:"page,omitempty"`
	Options []Option `json:"options,omitempty"`
	Value   any      `json:"value,omitempty"`
}

type Rule struct {
	Key     string      `json:"key"`
	Match   string      `json:"match"`
	When    []Condition `json:"when"`
	Actions []Action    `json:"actions"`
}

type Submit struct {
	Required []string `json:"required"`
}

type Definition struct {
	Version  int            `json:"version"`
	Pages    []Page         `json:"pages"`
	Fields   []Field        `json:"fields"`
	Rules    []Rule         `json:"rules"`
	Defaults map[string]any `json:"defaults"`
	Submit   Submit         `json:"submit"`
}

func ParseDefinition(raw []byte) (*Definition, error) {
	var def Definition
	if err := json.Unmarshal(raw, &def); err != nil {
		return nil, fmt.Errorf("forms: parse definition: %w", err)
	}
	if def.Defaults == nil {
		def.Defaults = map[string]any{}
	}
	return &def, nil
}

func (d *Definition) Field(key string) *Field {
	for i := range d.Fields {
		if d.Fields[i].Key == key {
			return &d.Fields[i]
		}
	}
	return nil
}
