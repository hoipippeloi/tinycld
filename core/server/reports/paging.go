package reports

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
)

// cursorOf is the page cursor after row: its sort values, then its id.
func cursorOf(keys []sortKey, row map[string]any) string {
	values := make([]any, len(keys))
	for i, k := range keys {
		values[i] = row[k.name]
	}
	b, _ := json.Marshal(values)
	return base64.RawURLEncoding.EncodeToString(b)
}

// keysetAfter selects the rows after a cursor in the detail order: a page
// starts where the last one ended, so a row added or removed between pages
// does not shift the rest. The cursor's values are bound, never inlined.
func keysetAfter(s *stmt, keys []sortKey, cursor string) (string, error) {
	if cursor == "" {
		return "1", nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return "", invalid("options.cursor", "the cursor is not one this report gave")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var values []any
	if err := dec.Decode(&values); err != nil || len(values) != len(keys) || values[len(values)-1] == nil {
		return "", invalid("options.cursor", "the cursor is not one this report gave")
	}
	for i, v := range values {
		switch x := v.(type) {
		case json.Number:
			values[i] = numberValue(x)
		case nil, string, bool:
		default:
			return "", invalid("options.cursor", "the cursor is not one this report gave")
		}
	}
	last := len(keys) - 1
	cond := "d.__id > " + s.bind(values[last])
	for i := last - 1; i >= 0; i-- {
		col := "d." + keys[i].name
		if values[i] == nil {
			// NULLs sort last, so after a NULL come only NULLs.
			cond = "(" + col + " IS NULL AND " + cond + ")"
			continue
		}
		cmp := " > "
		if keys[i].desc {
			cmp = " < "
		}
		v := s.bind(values[i])
		cond = "(" + col + " IS NULL OR " + col + cmp + v + " OR (" + col + " = " + v + " AND " + cond + "))"
	}
	return cond, nil
}
