package reports

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
)

// cursor is a page cursor: a fingerprint of the sort keys, then the sort
// values of the last row and its id.
type cursor struct {
	Key    string `json:"k"`
	Values []any  `json:"v"`
}

// valueKind is the JSON type a sort key's value has in a cursor: n for a
// number, s for text, a for a column whose type is not known.
func valueKind(k sortKey) string {
	switch {
	case k.name == "__id":
		return "s"
	case k.typ == "":
		return "a"
	case isNumeric(k.typ):
		return "n"
	}
	return "s"
}

// fingerprint ties a cursor to the sort columns, directions and value
// types of the report that gave it.
func fingerprint(keys []sortKey) string {
	h := sha256.New()
	for _, k := range keys {
		h.Write([]byte(k.col + "|" + dirOf(k.desc) + "|" + valueKind(k) + ";"))
	}
	return hex.EncodeToString(h.Sum(nil)[:6])
}

// cursorOf is the page cursor after row: its sort values, then its id.
func cursorOf(keys []sortKey, row map[string]any) string {
	values := make([]any, len(keys))
	for i, k := range keys {
		values[i] = row[k.name]
	}
	b, _ := json.Marshal(cursor{Key: fingerprint(keys), Values: values})
	return base64.RawURLEncoding.EncodeToString(b)
}

func badCursor() *SpecError {
	return invalid("options.cursor", "the cursor is not one this report gave")
}

// readCursor decodes a cursor and checks it fits keys: same fingerprint,
// one value per key, each of the type its key holds, a text id last.
func readCursor(keys []sortKey, text string) ([]any, error) {
	raw, err := base64.RawURLEncoding.DecodeString(text)
	if err != nil {
		return nil, badCursor()
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var c cursor
	if err := dec.Decode(&c); err != nil {
		return nil, badCursor()
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, badCursor()
	}
	if c.Key != fingerprint(keys) || len(c.Values) != len(keys) {
		return nil, badCursor()
	}
	for i, v := range c.Values {
		kind := valueKind(keys[i])
		switch x := v.(type) {
		case json.Number:
			if kind == "s" {
				return nil, badCursor()
			}
			c.Values[i] = numberValue(x)
		case string:
			if kind == "n" {
				return nil, badCursor()
			}
		case nil:
			if i == len(keys)-1 {
				return nil, badCursor()
			}
		default:
			return nil, badCursor()
		}
	}
	return c.Values, nil
}

// keysetAfter selects the rows after a cursor in the detail order: a page
// starts where the last one ended, so a row added or removed between pages
// does not shift the rest. The cursor's values are bound, never inlined.
func keysetAfter(s *stmt, keys []sortKey, text string) (string, error) {
	if text == "" {
		return "1", nil
	}
	values, err := readCursor(keys, text)
	if err != nil {
		return "", err
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
