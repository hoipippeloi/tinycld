package coreserver

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func widgetSelectFields() []*core.SelectField {
	values := []string{"small", "large"}
	return []*core.SelectField{
		{Name: "size", Values: values, MaxSelect: 1},
		{Name: "shade", Values: values, MaxSelect: 1, Required: true},
		{Name: "tags", Values: values, MaxSelect: 3},
		{Name: "labels", Values: values, MaxSelect: 3, Required: true},
		{Name: "kind", Values: values, MaxSelect: 0},
	}
}

func TestSchemaGenSelectFieldTypes(t *testing.T) {
	wantTS := map[string]string{
		"size":   "size: 'small' | 'large' | ''",
		"shade":  "shade: 'small' | 'large'",
		"tags":   "tags: ('small' | 'large')[]",
		"labels": "labels: ['small' | 'large', ...('small' | 'large')[]]",
		"kind":   "kind: 'small' | 'large' | ''",
	}
	wantZod := map[string]string{
		"size":   `size: z.enum(["small", "large"]).or(z.literal(''))`,
		"shade":  `shade: z.enum(["small", "large"])`,
		"tags":   `tags: z.enum(["small", "large"]).array().max(3)`,
		"labels": `labels: z.enum(["small", "large"]).array().nonempty().max(3)`,
		"kind":   `kind: z.enum(["small", "large"]).or(z.literal(''))`,
	}

	for _, field := range widgetSelectFields() {
		t.Run(field.Name, func(t *testing.T) {
			if got := tsFieldType(field, nil); got != wantTS[field.Name] {
				t.Errorf("tsFieldType(%s) = %q, want %q", field.Name, got, wantTS[field.Name])
			}
			if got := zodFieldType(field, nil); got != wantZod[field.Name] {
				t.Errorf("zodFieldType(%s) = %q, want %q", field.Name, got, wantZod[field.Name])
			}
		})
	}
}

func TestSchemaGenZodOptionalSelectLines(t *testing.T) {
	widgets := core.NewBaseCollection("widgets")
	for _, field := range widgetSelectFields() {
		widgets.Fields.Add(field)
	}

	out := generateZodSchema([]*core.Collection{widgets})

	wantLines := []string{
		`    size: z.enum(["small", "large"]).or(z.literal('')).optional(),`,
		`    shade: z.enum(["small", "large"]),`,
	}
	for _, line := range wantLines {
		if !strings.Contains(out, "\n"+line+"\n") {
			t.Errorf("generateZodSchema output lacks line %q; got:\n%s", line, out)
		}
	}
}
