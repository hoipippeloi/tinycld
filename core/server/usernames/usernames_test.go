package usernames

import "testing"

func TestDerive(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"foo@bar.com", "foo"},
		{"Bob.Smith+work@example.com", "bobsmithwork"},
		{"alice123@x.com", "alice123"},
		{"", "user"},             // empty → falls back to "user"
		{"@example.com", "user"}, // no local part → empty after strip → "user"
		{"UPPER@example.com", "upper"},
		{"dots.and+plus@x.com", "dotsandplus"},
		{"under_score-dash@x.com", "under_score-dash"},
		{"noemail", "noemail"},
		{"ab@x.com", "ab"}, // 2-char prefix is preserved
		{"a@x.com", "a"},   // 1-char prefix is preserved
	}
	for _, tc := range cases {
		got := Derive(tc.input)
		if got != tc.want {
			t.Errorf("Derive(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestValid(t *testing.T) {
	// Length floor relaxed to 1; single-char emails like "a@x.com" must be
	// representable as usernames. Character set and start-with-alphanumeric
	// rule are unchanged.
	valid := []string{"a", "ab", "abc", "foo", "foo123", "a1b", "foo-bar", "foo_bar"}
	invalid := []string{"", "FOO", "foo@bar", "foo bar", "foo!", "-foo", "_foo"}
	for _, s := range valid {
		if !Valid(s) {
			t.Errorf("Valid(%q) = false, want true", s)
		}
	}
	for _, s := range invalid {
		if Valid(s) {
			t.Errorf("Valid(%q) = true, want false", s)
		}
	}
}
